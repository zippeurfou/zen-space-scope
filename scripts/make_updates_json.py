#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Write the update manifest (updates.json) for a built zen-space-scope XPI.

    uv run scripts/make_updates_json.py XPI [-o OUT] [--expect-tag TAG]
                                            [--base-url URL [--allow-http]]

The add-on's manifest points Zen's add-on manager at the latest release's
updates.json. That file names one version, its versioned download URL
(`<base-url>/<XPI file name>`, by default
https://github.com/zippeurfou/zen-space-scope/releases/download/v<version>),
the sha256 of that exact file, and the minimum Firefox version. The version,
add-on id and minimum version are read from the XPI's own manifest.json.

--expect-tag fails unless TAG is "v<version>" (the release workflow passes
the pushed tag). --allow-http lets tests use a plain-HTTP base URL. OUT
defaults to updates.json next to the XPI; its path is printed. Nothing is
written on any error. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.parse
import zipfile
from pathlib import Path

ADDON_ID = "zen-space-scope@zippeurfou.github.io"
DOWNLOADS = "https://github.com/zippeurfou/zen-space-scope/releases/download"


class UpdatesError(Exception):
    pass


def read_manifest(xpi: Path) -> dict:
    try:
        with zipfile.ZipFile(xpi) as z:
            return json.loads(z.read("manifest.json"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as e:
        raise UpdatesError(f"cannot read manifest.json in {xpi} ({e})") from e


def build(xpi: Path, base_url: str | None, allow_http: bool, tag: str | None) -> dict:
    manifest = read_manifest(xpi)
    gecko = (manifest.get("browser_specific_settings") or {}).get("gecko") or {}
    addon_id = gecko.get("id")
    if addon_id != ADDON_ID:
        raise UpdatesError(f"{xpi} is the add-on {addon_id!r}, expected {ADDON_ID!r}")
    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        raise UpdatesError(f"{xpi} has no version")
    min_version = gecko.get("strict_min_version")
    if not isinstance(min_version, str) or not min_version:
        raise UpdatesError(
            f"{xpi} has no browser_specific_settings.gecko.strict_min_version"
        )
    if tag is not None and tag != f"v{version}":
        raise UpdatesError(f"the tag {tag} does not match the add-on version {version}")

    base = base_url if base_url is not None else f"{DOWNLOADS}/v{version}"
    scheme = urllib.parse.urlsplit(base).scheme.lower()
    if scheme != "https" and not (allow_http and scheme == "http"):
        raise UpdatesError(f"the base URL is not https: {base}")
    link = base.rstrip("/") + "/" + urllib.parse.quote(xpi.name)
    digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
    return {
        "addons": {
            ADDON_ID: {
                "updates": [
                    {
                        "version": version,
                        "update_link": link,
                        "update_hash": f"sha256:{digest}",
                        # Zen reads `applications.gecko` (AddonUpdateChecker).
                        "applications": {"gecko": {"strict_min_version": min_version}},
                    }
                ]
            }
        }
    }


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".updates-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("xpi", type=Path)
    p.add_argument("-o", "--output", type=Path)
    p.add_argument("--expect-tag")
    p.add_argument("--base-url")
    p.add_argument("--allow-http", action="store_true", help="tests only")
    args = p.parse_args(argv)
    try:
        data = build(args.xpi, args.base_url, args.allow_http, args.expect_tag)
        out = args.output or args.xpi.parent / "updates.json"
        write_atomic(out, json.dumps(data, indent=2) + "\n")
    except (UpdatesError, OSError) as e:
        print(f"make_updates_json: {e}", file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
