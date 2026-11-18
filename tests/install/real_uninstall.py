"""Real end-to-end check of install then uninstall (see MANUAL.md).

Temp profile directory, unregistered `-profile` through the acceptance harness,
HEADLESS=1; never `-CreateProfile`, never a real profile.

  1. install.py --profile <dir>; start Zen; the add-on is active; quit.
  2. install.py --profile <dir> --uninstall.
  3. start Zen: the add-on is gone (no sideload entry or notification), then quit.
  4. on disk: prefs.js has none of the block's prefs, extensions.json has no
     entry, the XPI is gone, user.js has no markers.
  5. a second start and quit is still clean.

    HEADLESS=1 uv run --project tests/acceptance python tests/install/real_uninstall.py

Marionette sets some extension prefs (for example extensions.autoDisableScopes)
on the DEFAULT branch for the session (RecommendedPreferences.sys.mjs), never
persisted, so in-session the check is prefHasUserValue (false for all names) and
the persistent check is the prefs.js on disk after quit.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests" / "acceptance"))
sys.path.insert(0, str(REPO / "scripts"))

from install import ADDON_ID, BEGIN, END, block_pref_names
from zen import BASE_PREFS, Zen

INSTALL = ["uv", "run", "--no-project", str(REPO / "scripts" / "install.py")]
failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(
        f"  [{'ok' if ok else 'FAIL'}] {label}"
        + (f": {detail}" if detail != "" else "")
    )
    if not ok:
        failures.append(label)


def installer(profile: Path, *extra: str) -> int:
    r = subprocess.run(
        [*INSTALL, "--profile", str(profile), *extra],
        capture_output=True,
        text=True,
        check=False,
    )
    print(f"$ install.py --profile <dir> {' '.join(extra)} -> exit {r.returncode}")
    if r.returncode:
        print(r.stdout, r.stderr)
    return r.returncode


IN_SESSION = """
const { AddonManager, AddonManagerPrivate } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionsUI } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionsUI.sys.mjs");
const [id, names] = args;
const t0 = Date.now();
let addon = await AddonManager.getAddonByID(id);
while (addon && Date.now() - t0 < 10000) {
  await new Promise(r => win.setTimeout(r, 200));
  addon = await AddonManager.getAddonByID(id);
}
const sideloads = (await AddonManagerPrivate.getNewSideloads()).map(a => a.id);
const msgs = Services.console.getMessageArray()
  .map(m => (m.message || m.errorMessage || String(m)))
  .filter(t => /zen-space-scope|zippeurfou/i.test(t))
  .map(t => t.slice(0, 300));
return {
  addonPresent: !!addon,
  addonState: addon ? { isActive: addon.isActive, userDisabled: addon.userDisabled } : null,
  secondsUntilGone: (Date.now() - t0) / 1000,
  sideloads,
  sideloadNotifications: ExtensionsUI.sideloaded.size,
  startupUninstalled: AddonManager.getStartupChanges(AddonManager.STARTUP_CHANGE_UNINSTALLED),
  userValues: names.filter(n => Services.prefs.prefHasUserValue(n)),
  consoleMessages: msgs,
};
"""


def start(profile: Path) -> Zen:
    zen = Zen(prefs={})
    zen.profile = profile  # an existing directory: the harness starts on it as is
    return zen.start()


def disk_state(profile: Path, names: list[str]) -> dict:
    prefs = (
        (profile / "prefs.js").read_text() if (profile / "prefs.js").exists() else ""
    )
    ext_json = profile / "extensions.json"
    entries = []
    if ext_json.exists():
        entries = [a["id"] for a in json.loads(ext_json.read_text()).get("addons", [])]
    user_js = (
        (profile / "user.js").read_text() if (profile / "user.js").exists() else ""
    )
    return {
        "prefs_left": [n for n in names if f'"{n}"' in prefs],
        "extensions_json_has_id": ADDON_ID in entries,
        "xpi_present": (profile / "extensions" / f"{ADDON_ID}.xpi").exists(),
        "markers": BEGIN in user_js or END in user_js,
    }


def main() -> int:
    names = block_pref_names()
    profile = Path(tempfile.mkdtemp(prefix="zen-space-scope-uninstall-"))
    try:
        quiet = {k: v for k, v in BASE_PREFS.items() if not k.startswith("extensions.")}
        (profile / "user.js").write_text(
            "".join(
                f"user_pref({json.dumps(k)}, {json.dumps(v)});\n"
                for k, v in quiet.items()
            )
        )

        print("1. install, start, quit")
        check("install exit 0", installer(profile) == 0)
        zen = start(profile)
        try:
            status = zen.wait_addon_active(ADDON_ID)
            check("add-on active", status["state"] == "active", status["state"])
        finally:
            zen.close(keep_profile=True)
        d = disk_state(profile, names)
        print("   on disk after the first quit:", json.dumps(d))
        check(
            "prefs.js holds the block's prefs after a run (the problem R32 fixes)",
            bool(d["prefs_left"]),
        )

        print("2. uninstall")
        check("uninstall exit 0", installer(profile, "--uninstall") == 0)

        print("3. start with the add-on removed")
        zen = start(profile)
        try:
            info = zen.chrome(IN_SESSION, ADDON_ID, names, timeout=40)
        finally:
            zen.close(keep_profile=True)
        print("   in session:", json.dumps(info, indent=2).replace("\n", "\n   "))
        check(
            "getAddonByID is null", not info["addonPresent"], info["secondsUntilGone"]
        )
        check("no sideload entry", ADDON_ID not in info["sideloads"], info["sideloads"])
        check("no sideload notification", info["sideloadNotifications"] == 0)
        check(
            "no user value for any block pref in session",
            info["userValues"] == [],
            info["userValues"],
        )
        print(
            "   (optional) startup-uninstalled lists the id:",
            ADDON_ID in info["startupUninstalled"],
        )

        print("4. on disk after quit")
        d = disk_state(profile, names)
        print("  ", json.dumps(d))
        check(
            "prefs.js has none of the block's prefs",
            d["prefs_left"] == [],
            d["prefs_left"],
        )
        check("extensions.json has no entry", not d["extensions_json_has_id"])
        check("XPI absent", not d["xpi_present"])
        check("user.js has no markers", not d["markers"])

        print("5. second start and quit")
        zen = start(profile)
        try:
            info2 = zen.chrome(IN_SESSION, ADDON_ID, names, timeout=40)
        finally:
            zen.close(keep_profile=True)
        check("add-on still gone", not info2["addonPresent"])
        check(
            "still no sideload entry or notification",
            not info2["sideloads"] and info2["sideloadNotifications"] == 0,
        )
        check(
            "no console messages about the add-on",
            info2["consoleMessages"] == [],
            info2["consoleMessages"],
        )
        d = disk_state(profile, names)
        check(
            "disk still clean",
            d["prefs_left"] == []
            and not d["extensions_json_has_id"]
            and not d["xpi_present"]
            and not d["markers"],
        )
        print("Console messages mentioning the add-on, first start after uninstall:")
        print(json.dumps(info["consoleMessages"], indent=2))
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    print("RESULT:", "PASS" if not failures else f"FAIL ({', '.join(failures)})")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
