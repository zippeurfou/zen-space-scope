"""The real-run check for scripts/install.py (see MANUAL.md).

Creates a throwaway profile directory, runs the installer on it with
--profile, launches Zen on that directory (unregistered, through the
acceptance harness) and checks the add-on came up active without a prompt.
It never uses -CreateProfile and never touches the user's real profiles.

    HEADLESS=1 uv run --project tests/acceptance python tests/install/real_run.py
    ... real_run.py --existing        # Zen runs once on the profile before the install
    ... real_run.py --existing --no-sideload-prefs   # control

`--existing` matters: on a brand-new profile Zen scans every scope at its first
start, so only a profile that has already run shows that extensions.startupScanScopes
is needed. `--no-sideload-prefs` sets the two sideload prefs to Zen's shipped defaults (15, 0) and
is expected to FAIL (the add-on is not found, or is found disabled).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests" / "acceptance"))

from zen import BASE_PREFS, Zen

ADDON_ID = "zen-space-scope@zippeurfou.github.io"


def main() -> int:
    existing = "--existing" in sys.argv
    no_sideload = "--no-sideload-prefs" in sys.argv
    profile = Path(tempfile.mkdtemp(prefix="zen-space-scope-install-"))
    quiet = {k: v for k, v in BASE_PREFS.items() if not k.startswith("extensions.")}
    try:
        if existing:
            with open(profile / "user.js", "w") as f:
                f.writelines(
                    f"user_pref({json.dumps(name)}, {json.dumps(value)});\n"
                    for name, value in quiet.items()
                )
            first = Zen(prefs={})
            first.profile = profile
            first.start()
            first.close(keep_profile=True)
        subprocess.run(
            [
                "uv",
                "run",
                "--no-project",
                str(REPO / "scripts" / "install.py"),
                "--profile",
                str(profile),
            ],
            check=True,
        )
        # Quiet startup only. The extensions.* prefs come from the installer's
        # block alone: that is what is being tested.
        text = (profile / "user.js").read_text()
        if no_sideload:
            # Marionette sets autoDisableScopes=0 as a default, which would hide
            # the effect; pin Zen's shipped defaults as user values instead.
            text = text.replace(
                'user_pref("extensions.autoDisableScopes", 14);',
                'user_pref("extensions.autoDisableScopes", 15);',
            ).replace(
                'user_pref("extensions.startupScanScopes", 1);',
                'user_pref("extensions.startupScanScopes", 0);',
            )
            (profile / "user.js").write_text(text)
        if not existing:
            with open(profile / "user.js", "a") as f:
                f.writelines(
                    f"user_pref({json.dumps(name)}, {json.dumps(value)});\n"
                    for name, value in quiet.items()
                )

        print(
            "user.js scopes:",
            [
                l
                for l in (profile / "user.js").read_text().splitlines()
                if "Scopes" in l
            ],
            sorted(p.name for p in profile.glob("prefs*")),
        )
        zen = Zen(prefs={})
        zen.profile = profile  # an existing directory: the harness starts on it as is
        zen.start()
        try:
            info = zen.chrome(
                """
                const { AddonManager } = ChromeUtils.importESModule(
                  "resource://gre/modules/AddonManager.sys.mjs");
                let a = null;
                for (let i = 0; i < 100 && !a; i++) {
                  a = await AddonManager.getAddonByID(args[0]);
                  if (!a) await new Promise(r => win.setTimeout(r, 100));
                }
                if (!a) return null;
                return {
                  isActive: a.isActive, userDisabled: a.userDisabled,
                  appDisabled: a.appDisabled, foreignInstall: a.foreignInstall,
                  scope: a.scope, permanent: !a.temporary,
                  version: a.version,
                  autoDisableScopes: Services.prefs.getIntPref("extensions.autoDisableScopes", -1),
                  startupScanScopes: Services.prefs.getIntPref("extensions.startupScanScopes", -1),
                };
                """,
                ADDON_ID,
            )
            print("add-on:", json.dumps(info))
            if info is None or not info["isActive"]:
                print("RESULT: FAIL (not found or not active)")
                return 1
            status = zen.wait_addon_active(ADDON_ID)
            history_pref = zen.chrome(
                'return Services.prefs.getBoolPref("browser.urlbar.suggest.history");'
            )
        finally:
            zen.close(keep_profile=True)
        print("status:", json.dumps(status))
        print("browser.urlbar.suggest.history while active:", history_pref)
        ok = (
            info["isActive"]
            and not info["userDisabled"]
            and status["state"] == "active"
        )
        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        import shutil

        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
