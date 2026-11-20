#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Install or remove zen-space-scope in a Zen profile.

    uv run scripts/install.py [--profile PATH] [--xpi PATH | --latest] [--dry-run]
    uv run scripts/install.py --uninstall [--profile PATH] [--dry-run]
    uv run scripts/install.py --print-block

Install does three things in the profile and prints each one:

1. Writes one marked block into user.js (between the begin and end marker
   lines). It holds the add-on's prefs and every guarded suggestion pref at
   its off value, so history-based suggestions stay off at every startup until
   the add-on's self-check passes. Everything else in user.js is kept. A
   symlinked user.js is written through to its target.
2. Copies the XPI to <profile>/extensions/<add-on id>.xpi.
3. The block also carries two sideload prefs (see SIDELOAD_PREFS), so Zen
   finds that file at the next start and enables it without a prompt.

Quit Zen first: the script refuses to touch a profile whose lock is held.
Standard library only. macOS and Linux only: the lock check needs POSIX
locks, so on Windows only --print-block works.
"""

from __future__ import annotations

import argparse
import configparser
import contextlib
import errno
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Iterator
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: no POSIX locks to tell whether Zen is running
    fcntl = None  # type: ignore[assignment]

ADDON_ID = "zen-space-scope@zippeurfou.github.io"
BEGIN = "// zen-space-scope: begin"
END = "// zen-space-scope: end"
REPO_ROOT = Path(__file__).resolve().parent.parent
GUARDED_PREFS_PATH = REPO_ROOT / "src" / "guarded-prefs.json"
RELEASES_URL = os.environ.get(
    "ZEN_SPACE_SCOPE_RELEASES_URL",
    "https://api.github.com/repos/zippeurfou/zen-space-scope/releases/latest",
)

# The add-on is an unsigned WebExtension Experiment.
ADDON_PREFS = [
    ("xpinstall.signatures.required", False),
    ("extensions.experiments.enabled", True),
]

# How an XPI dropped into <profile>/extensions/ becomes an enabled add-on
# without a prompt (checked in the Zen 1.24.2b source):
# - extensions.autoDisableScopes: a file found by a startup scan in a scope
#   whose bit is set here is added disabled (XPIDatabase.sys.mjs, around
#   line 3382, "Disabling foreign installed add-on"). Zen's default is 15,
#   which includes SCOPE_PROFILE (1). 14 clears that one bit.
# - extensions.startupScanScopes: the scopes scanned for new files at startup.
#   Zen's default is 0. XPIProvider.sys.mjs:3345 runs the startup scan with
#   ignoreSideloads = (appChanged === false), and :1641 then skips every scope
#   missing from this pref. So on a profile that has already run, a new or
#   replaced XPI is not found during startup; only the later getNewSideloads
#   scan (:3440) finds it, and that one lists it as a disabled sideload. 1
#   (SCOPE_PROFILE) makes the startup scan look in the profile every time.
# Profile scope is always allowed to sideload (AddonSettings.sys.mjs, around
# line 137, SCOPES_SIDELOAD) and always enabled (XPIProvider.sys.mjs, line 164).
SIDELOAD_PREFS = [
    ("extensions.autoDisableScopes", 14),
    ("extensions.startupScanScopes", 1),
]


class InstallError(Exception):
    """A problem to report to the user, without a traceback."""


def _line(name: str, value: object) -> str:
    return f"user_pref({json.dumps(name)}, {json.dumps(value)});"


def load_guarded_prefs(path: Path = GUARDED_PREFS_PATH) -> list[dict]:
    try:
        prefs = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise InstallError(f"cannot read {path}: {e}") from e
    ok = isinstance(prefs, list) and all(
        isinstance(p, dict)
        and isinstance(p.get("name"), str)
        and isinstance(p.get("off"), (bool, int, str))
        for p in prefs
    )
    if not ok:
        raise InstallError(
            f"{path} is not a list of {{name, off, on}} entries; cannot build the block"
        )
    return prefs


def build_block(guarded: list[dict] | None = None) -> str:
    if guarded is None:
        guarded = load_guarded_prefs()
    lines = [BEGIN]
    lines += [_line(n, v) for n, v in ADDON_PREFS + SIDELOAD_PREFS]
    lines += [_line(p["name"], p["off"]) for p in guarded]
    lines.append(END)
    return "\n".join(lines) + "\n"


# -- profile discovery ---------------------------------------------------------


def default_zen_dirs(platform: str = sys.platform) -> list[Path]:
    home = Path.home()
    if platform == "darwin":
        return [home / "Library" / "Application Support" / "zen"]
    return [
        home / ".zen",
        home / ".config" / "zen",
        home / ".var" / "app" / "app.zen_browser.zen" / ".zen",
    ]


def _read_ini(path: Path) -> configparser.RawConfigParser:
    # Zen's ini files have case-sensitive keys and no interpolation.
    ini = configparser.RawConfigParser(strict=False)
    ini.optionxform = str  # type: ignore[assignment,method-assign]
    try:
        with open(path, encoding="utf-8") as f:
            ini.read_file(f)
    except FileNotFoundError:
        pass
    except (OSError, UnicodeDecodeError, configparser.Error) as e:
        raise InstallError(f"cannot read {path}: {e}; pass --profile PATH") from e
    return ini


def _resolve(root: Path, path: str, relative: bool = True) -> Path:
    p = Path(path)
    p = root / p if relative and not p.is_absolute() else p
    return Path(os.path.realpath(p))


def _is_data_dir(path: Path) -> bool:
    """A Zen data directory holds profiles.ini or installs.ini; a profile
    never does."""
    return (path / "profiles.ini").exists() or (path / "installs.ini").exists()


def _ini_profile(
    zen_dir: Path, ini_path: Path, section: str, key: str, value: str, relative: bool
) -> Path:
    """The profile directory an ini entry names. An empty value would resolve
    to the data directory itself, which is not a profile: refuse it, and any
    other value that lands there."""
    where = f"{ini_path} has [{section}] {key}="
    if not value.strip():
        raise InstallError(f"{where} with no value; pass --profile PATH")
    path = _resolve(zen_dir, value, relative)
    if path == Path(os.path.realpath(zen_dir)) or _is_data_dir(path):
        raise InstallError(
            f"{where}{value}, which is the Zen data directory {path}, not a "
            "profile; pass --profile PATH"
        )
    return path


def find_profile(zen_dir: Path) -> Path:
    """The profile this Zen install uses, from the install information.

    installs.ini sections and [Install...] sections of profiles.ini each name
    the Default profile of one install. Entries for the same profile (relative
    or absolute) count once. One profile: that one. Several: refuse and list
    them, because the section names are hashes of install paths we cannot
    match. Only when there is no install information at all: the profile
    flagged Default=1 in profiles.ini, then the only profile.
    """
    profiles_ini = zen_dir / "profiles.ini"
    installs_ini = zen_dir / "installs.ini"
    if not profiles_ini.exists() and not installs_ini.exists():
        raise InstallError(f"no profiles.ini or installs.ini in {zen_dir}")

    profiles = _read_ini(profiles_ini)
    installs = _read_ini(installs_ini)

    flagged: Path | None = None
    all_profiles: list[Path] = []
    for section in profiles.sections():
        if not re.fullmatch(r"Profile\d+", section) or not profiles.has_option(
            section, "Path"
        ):
            continue
        path = _ini_profile(
            zen_dir,
            profiles_ini,
            section,
            "Path",
            profiles.get(section, "Path"),
            profiles.get(section, "IsRelative", fallback="1") == "1",
        )
        all_profiles.append(path)
        if profiles.get(section, "Default", fallback="0") == "1":
            flagged = path

    candidates: list[Path] = []
    for ini, ini_path, wanted in (
        (installs, installs_ini, lambda n: n != "General"),
        (profiles, profiles_ini, lambda n: n.startswith("Install")),
    ):
        for section in ini.sections():
            if wanted(section) and ini.has_option(section, "Default"):
                path = _ini_profile(
                    zen_dir,
                    ini_path,
                    section,
                    "Default",
                    ini.get(section, "Default"),
                    True,
                )
                if path not in candidates:
                    candidates.append(path)

    if len(candidates) == 1:
        chosen = candidates[0]
    elif len(candidates) > 1:
        listing = "".join(f"\n  {c}" for c in candidates)
        raise InstallError(
            f"{zen_dir} lists several Zen installs, with these default profiles:"
            f"{listing}\npass --profile PATH"
        )
    elif flagged is not None:
        chosen = flagged
    elif len(all_profiles) == 1:
        chosen = all_profiles[0]
    else:
        raise InstallError(f"no default profile in {zen_dir}; pass --profile PATH")

    if not chosen.is_dir():
        raise InstallError(f"the default profile {chosen} does not exist")
    return chosen


def locate_profile(profile: str | None, zen_dir: str | None) -> Path:
    if profile:
        path = Path(profile).expanduser()
        if not path.is_dir():
            raise InstallError(f"profile directory {path} does not exist")
        if _is_data_dir(path):
            raise InstallError(
                f"{path} is a Zen data directory (it holds profiles.ini or "
                "installs.ini), not a profile; pass the profile directory "
                "inside it (see about:profiles)"
            )
        return path
    dirs = [Path(zen_dir).expanduser()] if zen_dir else default_zen_dirs()
    # Several default places can hold a Zen data directory (on Linux, a native
    # install and a flatpak one). The same directory reached twice, through a
    # symlink, counts once.
    found: list[Path] = []
    for d in dirs:
        if _is_data_dir(d) and os.path.realpath(d) not in map(os.path.realpath, found):
            found.append(d)
    if len(found) == 1:
        return find_profile(found[0])
    if found:
        listing = "".join(f"\n  {d}" for d in found)
        raise InstallError(
            f"several Zen data directories found:{listing}\n"
            "pass --zen-dir PATH to pick one, or --profile PATH"
        )
    raise InstallError(
        "no Zen data directory found (looked in "
        + ", ".join(str(d) for d in dirs)
        + "); pass --profile PATH"
    )


# -- Zen running -----------------------------------------------------------------


def _parentlock_state(profile: Path) -> str | None:
    """Why Zen counts as running, or None when it does not.

    Gecko holds a POSIX lock on <profile>/.parentlock while it runs (macOS and
    Linux). No file, or a lock we get (released at once): not running. The lock
    is held by someone else: running. Any other error: we cannot tell, so fail
    closed and say so."""
    path = profile / ".parentlock"
    try:
        fd = os.open(path, os.O_RDWR)
    except FileNotFoundError:
        return None
    except OSError as e:
        return f"cannot check {path} ({e})"
    try:
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        if e.errno in (errno.EACCES, errno.EAGAIN):
            return f"another process holds {path}"
        return f"cannot lock {path} ({e})"
    finally:
        os.close(fd)  # closing also drops any lock we took
    return None


def _lock_symlink_live(profile: Path) -> str | None:
    """Linux also leaves a dangling symlink "<ip>:+<pid>" named `lock`; a
    stale one names a dead pid."""
    lock = profile / "lock"
    if not lock.is_symlink():
        return None
    m = re.search(r":\+?(\d+)$", os.readlink(lock))
    if not m:
        return None
    try:
        os.kill(int(m.group(1)), 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return f"{lock} names the live process {m.group(1)}"


def zen_running(profile: Path) -> str | None:
    return _parentlock_state(profile) or _lock_symlink_live(profile)


def _refuse(profile: Path, why: str) -> InstallError:
    return InstallError(
        f"Zen is running on {profile}, or cannot be ruled out: {why}. "
        "Quit Zen (Cmd+Q) and re-run the same command."
    )


@contextlib.contextmanager
def holding_profile(profile: Path) -> Iterator[None]:
    """Hold Zen's own lock on <profile>/.parentlock from the running check
    through the last write, so a Zen started meanwhile finds the profile in
    use instead of racing our build, download, reads and writes (ruling R46).

    The lock is the POSIX record lock (fcntl.lockf, F_SETLK) Gecko takes, not
    a BSD flock: on macOS the two kinds do not see each other. A missing
    .parentlock (a profile Zen never opened) is created, so the hold covers
    it too, and removed again while still held, so the profile is left as it
    was. One exception: if lockf fails with an error other than EAGAIN or
    EACCES, a .parentlock created here stays behind as an empty file. A
    .parentlock that was already there is never removed. Closing the
    descriptor drops the lock on every exit path. Nothing inside the hold may
    open and close another descriptor on .parentlock: closing any descriptor
    of a file drops this process's POSIX locks on it.

    Removing the created file leaves a small race: a newcomer that opened it
    just before the unlink ends up holding a lock on an unlinked file, while
    the next process creates a fresh .parentlock. The window is microseconds,
    after the last write, and only on a profile Zen never opened; under R46
    this order is the best available."""
    path = profile / ".parentlock"
    created = not os.path.lexists(path)
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    except OSError as e:
        raise _refuse(profile, f"cannot check {path} ({e})") from e
    try:
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            if e.errno in (errno.EACCES, errno.EAGAIN):
                raise _refuse(profile, f"another process holds {path}") from e
            raise _refuse(profile, f"cannot lock {path} ({e})") from e
        try:
            why = _lock_symlink_live(profile)
            if why:
                raise _refuse(profile, why)
            yield
        finally:
            if created:
                with contextlib.suppress(OSError):
                    path.unlink()
    finally:
        os.close(fd)


# -- user.js ---------------------------------------------------------------------


def _split_block(text: str) -> tuple[int, int] | None:
    """(start, end) offsets of the marked block, end after its last newline."""
    lines = text.splitlines(keepends=True)
    begin = end = None
    offset = 0
    start = stop = 0
    for line in lines:
        s = line.strip()
        if s == BEGIN and begin is None:
            begin = True
            start = offset
        elif s == END and begin and end is None:
            end = True
            stop = offset + len(line)
        offset += len(line)
    if begin and not end:
        raise InstallError(
            f"user.js has a '{BEGIN}' line without '{END}'; fix it by hand first"
        )
    if end is None:
        return None
    return start, stop


def with_block(text: str, block: str) -> str:
    span = _split_block(text)
    if span:
        return text[: span[0]] + block + text[span[1] :]
    if text and not text.endswith("\n"):
        text += "\n"
    return text + block


def without_block(text: str) -> str:
    span = _split_block(text)
    if span is None:
        return text
    return text[: span[0]] + text[span[1] :]


def _read(path: Path) -> str | None:
    """The text of `path`, None when it does not exist."""
    try:
        with open(path, encoding="utf-8", errors="surrogateescape", newline="") as f:
            return f.read()
    except FileNotFoundError:
        return None
    except OSError as e:
        raise InstallError(f"cannot read {path} ({e}); nothing was changed") from e


def _write_through(target: Path, text: str) -> None:
    # Replace atomically in the target's directory; target is already resolved,
    # so a symlinked user.js stays a symlink.
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".zss-")
    try:
        with os.fdopen(
            fd, "w", encoding="utf-8", errors="surrogateescape", newline=""
        ) as f:
            f.write(text)
        if target.exists():
            shutil.copymode(target, tmp)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _install_file(src: Path, dest: Path) -> None:
    """Copy to a temp file next to `dest`, then replace: never a half file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=".zss-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as out, open(src, "rb") as f:
            shutil.copyfileobj(f, out)
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@contextlib.contextmanager
def step(name: str):
    """Turn a filesystem failure into an InstallError that names the step.
    Every step is idempotent, so running the same command again finishes it."""
    try:
        yield
    except OSError as e:
        raise InstallError(
            f"{name} failed ({e}). Fix that, then re-run the same command to finish."
        ) from e


# -- prefs.js (R32) -----------------------------------------------------------------


def block_pref_names(guarded: list[dict] | None = None) -> list[str]:
    """The pref names the block sets, from the same lists build_block uses."""
    if guarded is None:
        guarded = load_guarded_prefs()
    return [n for n, _ in ADDON_PREFS + SIDELOAD_PREFS] + [p["name"] for p in guarded]


def reset_prefs(text: str, names: list[str]) -> tuple[str, list[str]]:
    """`text` (a prefs.js) without the user_pref lines of `names`, and the
    names that were found. Every other byte is kept."""
    wanted = {f"user_pref({json.dumps(n)},": n for n in names}
    kept, found = [], []
    for line in text.splitlines(keepends=True):
        hit = next((n for k, n in wanted.items() if line.startswith(k)), None)
        if hit and line.rstrip().endswith(");"):
            found.append(hit)
        else:
            kept.append(line)
    return "".join(kept), found


# -- XPI sources -------------------------------------------------------------------


def build_xpi() -> Path:
    build = REPO_ROOT / "scripts" / "build.sh"
    if not build.exists():
        raise InstallError(
            "no add-on in this checkout to build; pass --xpi PATH or --latest"
        )
    try:
        out = subprocess.run(
            ["sh", str(build)], capture_output=True, text=True, check=True
        )
    except (OSError, subprocess.CalledProcessError) as e:
        detail = getattr(e, "stderr", "") or str(e)
        raise InstallError(f"building the add-on failed: {detail.strip()}") from e
    return Path(out.stdout.strip().splitlines()[-1])


def validate_xpi(path: Path) -> None:
    """The file must be a zip whose manifest.json names this add-on."""
    try:
        with zipfile.ZipFile(path) as z:
            manifest = json.loads(z.read("manifest.json"))
        found = manifest["browser_specific_settings"]["gecko"]["id"]
    except zipfile.BadZipFile as e:
        raise InstallError(f"{path} is not a zip file ({e})") from e
    except KeyError as e:
        raise InstallError(
            f"{path} has no manifest.json with browser_specific_settings.gecko.id ({e})"
        ) from e
    except (OSError, ValueError, TypeError) as e:
        raise InstallError(f"cannot read the add-on manifest in {path} ({e})") from e
    if found != ADDON_ID:
        raise InstallError(f"{path} is the add-on {found!r}, expected {ADDON_ID!r}")


def _require_https(url: str, what: str) -> None:
    if urllib.parse.urlsplit(str(url)).scheme.lower() != "https":
        raise InstallError(f"{what} is not an https URL: {url}")


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _require_https(newurl, "a redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(req, timeout=None):
    return urllib.request.build_opener(_HttpsOnlyRedirects).open(req, timeout=timeout)


def download_latest(dest_dir: Path, opener=None) -> Path:
    """Download the first .xpi asset of the latest release to
    `dest_dir/latest.xpi` (a fixed name: the asset name is never used as a
    path). Every URL, including the final one after redirects, must be https."""
    opener = opener or _open
    hint = "; pass --xpi PATH with a built or downloaded XPI instead"
    try:
        _require_https(RELEASES_URL, "the releases URL")
        req = urllib.request.Request(
            RELEASES_URL, headers={"Accept": "application/vnd.github+json"}
        )
        with opener(req, timeout=20) as r:
            _require_https(r.geturl(), "the releases URL after redirects")
            release = json.load(r)
        assets = [
            a
            for a in release.get("assets", [])
            if str(a.get("name", "")).endswith(".xpi")
        ]
        if not assets:
            raise InstallError("the latest release has no .xpi asset" + hint)
        url = assets[0]["browser_download_url"]
        _require_https(url, "the asset URL")
        with opener(url, timeout=60) as r:
            _require_https(r.geturl(), "the asset URL after redirects")
            data = r.read()
        dest = dest_dir / "latest.xpi"
        dest.write_bytes(data)
        return dest
    except InstallError as e:
        if hint not in str(e):
            raise InstallError(str(e) + hint) from e
        raise
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise InstallError("no release has been published yet" + hint) from e
        raise InstallError(f"fetching the latest release failed ({e})" + hint) from e
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        raise InstallError(f"fetching the latest release failed ({e})" + hint) from e


# -- main ----------------------------------------------------------------------------


NOTES = """\
Next steps and good to know:
- Start Zen. The add-on enables itself (no prompt) and checks its own setup.
- Without the add-on, history-based suggestions stay OFF: the block above
  keeps them off at every startup. The add-on turns them on only after its
  self-check passes, and off again if a later check fails.
- When it runs, the add-on sets those prefs to Zen's default "on" values (from
  src/guarded-prefs.json), so your own customization of them is overridden
  while it runs.
- What the block enables in this profile: unsigned add-ons, experiment
  add-ons, and any add-on file in this profile's extensions folder starting
  without a prompt. Only install add-on files you trust.
- To uninstall: quit Zen, then run this script with --uninstall. It removes
  the XPI and the block, and resets every pref the block sets in prefs.js (Zen
  copies user.js values there), so they return to Zen's defaults. A custom
  value you had before installing is not restored.
- To uninstall by hand: quit Zen, remove the XPI and the block, then reset
  those prefs in about:config (or delete their lines from prefs.js)."""


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="install.py", description="Install or remove zen-space-scope."
    )
    ap.add_argument("--profile", help="Zen profile directory (default: auto-detect)")
    ap.add_argument("--zen-dir", help="Zen data directory holding profiles.ini")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--xpi", help="XPI to install (default: build from this checkout)")
    src.add_argument(
        "--latest", action="store_true", help="download the latest GitHub release"
    )
    ap.add_argument("--dry-run", action="store_true", help="print changes, write none")
    ap.add_argument(
        "--uninstall", action="store_true", help="remove the block and the XPI"
    )
    ap.add_argument(
        "--print-block", action="store_true", help="print the user.js block and exit"
    )
    return ap.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    if args.print_block:
        sys.stdout.write(build_block())
        return 0

    if fcntl is None:
        raise InstallError(
            "this script supports macOS and Linux only; on Windows, install "
            'by hand (README, "By hand, without the script"; --print-block '
            "prints the user.js block)"
        )

    profile = locate_profile(args.profile, args.zen_dir)
    dry = args.dry_run

    def say(present: str, past: str) -> str:
        return f"[dry run] would {present}" if dry else past

    if dry:
        # A dry run writes nothing, so a check without holding is enough.
        why = zen_running(profile)
        if why:
            print(
                f"note: Zen may be running on this profile ({why}); a real run would refuse"
            )
        return _run_in_profile(args, profile, dry, say)
    with holding_profile(profile):
        return _run_in_profile(args, profile, dry, say)


def _run_in_profile(args, profile, dry, say) -> int:
    print(f"profile: {profile}")
    user_js = profile / "user.js"
    target = Path(os.path.realpath(user_js)) if user_js.is_symlink() else user_js
    if user_js.is_symlink():
        print(f"user.js is a symlink to {target}; writing through to the target")
    xpi_dest = profile / "extensions" / f"{ADDON_ID}.xpi"
    original = _read(target)

    if args.uninstall:
        return uninstall(profile, user_js, target, original, xpi_dest, dry, say)
    return install(args, target, original, xpi_dest, dry, say)


def uninstall(profile, user_js, target, original, xpi_dest, dry, say) -> int:
    # Reads and computation first: a failure here changes nothing.
    names = block_pref_names()
    prefs_js = profile / "prefs.js"
    prefs_target = (
        Path(os.path.realpath(prefs_js)) if prefs_js.is_symlink() else prefs_js
    )
    prefs_text = _read(prefs_target)
    new_prefs, found = (None, [])
    if prefs_text is not None:
        new_prefs, found = reset_prefs(prefs_text, names)
    has_block = original is not None and _split_block(original) is not None
    new_user = without_block(original) if has_block else None
    drop_user_js = has_block and new_user == "" and not user_js.is_symlink()
    has_xpi = os.path.lexists(xpi_dest)

    # Order: security prefs first, then the block, then the XPI.
    if found:
        if prefs_js.is_symlink():
            print(f"prefs.js is a symlink to {prefs_target}; writing through")
        for name in found:
            print(say(f"reset {name} in prefs.js", f"reset {name} in prefs.js"))
        if not dry:
            with step("resetting the prefs in prefs.js"):
                _write_through(prefs_target, new_prefs)
    else:
        print(f"no zen-space-scope prefs in {prefs_target}")

    if has_block:
        if drop_user_js:
            print(
                say(f"remove {user_js}", f"removed {user_js}")
                + " (only held the block)"
            )
        else:
            print(
                say(
                    f"remove the block from {target}",
                    f"removed the block from {target}",
                )
            )
        if not dry:
            with step("removing the block from user.js"):
                if drop_user_js:
                    user_js.unlink()
                else:
                    _write_through(target, new_user)
    else:
        print(f"no zen-space-scope block in {target}")

    if has_xpi:
        print(say(f"remove {xpi_dest}", f"removed {xpi_dest}"))
        if not dry:
            with step("removing the add-on file"):
                xpi_dest.unlink()
    else:
        print(f"no {xpi_dest}")

    if dry:
        print("Dry run: nothing was written.")
    else:
        print(
            "Start Zen. The add-on is gone and the prefs the block set are back at Zen's defaults."
        )
    return 0


def install(args, target, original, xpi_dest, dry, say) -> int:
    # Everything that can fail runs before the first write.
    block = build_block()
    with tempfile.TemporaryDirectory() as tmp:
        if args.xpi:
            xpi = Path(args.xpi).expanduser()
            if not xpi.is_file():
                raise InstallError(f"XPI {xpi} does not exist")
        elif args.latest:
            xpi = download_latest(Path(tmp))
        else:
            xpi = build_xpi()
        validate_xpi(xpi)
        new_text = with_block(original or "", block)

        # The XPI goes first: without the block's prefs Zen will not load an
        # unsigned add-on, so a failure between the two steps changes no pref.
        print(say(f"copy {xpi} -> {xpi_dest}", f"copied {xpi} -> {xpi_dest}"))
        if not dry:
            with step("copying the add-on file"):
                _install_file(xpi, xpi_dest)
        if original and _split_block(original):
            head = say("update the block in", "updated the block in")
        else:
            head = say("add the block to", "added the block to")
        print(f"{head} {target}:")
        print("".join("    " + ln + "\n" for ln in block.splitlines()), end="")
        if not dry:
            with step("writing the block to user.js"):
                _write_through(target, new_text)

    if dry:
        print("Dry run: nothing was written.")
    print(NOTES)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except InstallError as e:
        print(f"install.py: {e}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError) as e:
        print(
            f"install.py: unexpected failure ({e}). Nothing more was done; "
            "re-run the same command after fixing it.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
