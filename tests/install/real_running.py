"""Real check that the installer refuses while Zen runs (see MANUAL.md).

Starts a headless Zen on a throwaway profile directory (unregistered
`-profile`, through the acceptance harness; never `-CreateProfile`, never a
real profile), runs the installer on it, quits Zen and runs it again.

    HEADLESS=1 uv run --project tests/acceptance python tests/install/real_running.py
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

from zen import BASE_PREFS, Zen

INSTALL = ["uv", "run", "--no-project", str(REPO / "scripts" / "install.py")]


def install(profile: Path, *extra: str) -> int:
    r = subprocess.run(
        [*INSTALL, "--profile", str(profile), *extra],
        capture_output=True,
        text=True,
        check=False,
    )
    lines = (r.stdout + r.stderr).strip().splitlines()
    shown = [ln for ln in lines if "running" in ln.lower() or ln.startswith("profile")]
    print(f"$ install.py --profile <dir> {' '.join(extra)}".rstrip())
    print(f"  exit {r.returncode}; " + " | ".join(shown or lines[:2]))
    return r.returncode


def main() -> int:
    profile = Path(tempfile.mkdtemp(prefix="zen-space-scope-running-"))
    try:
        quiet = {k: v for k, v in BASE_PREFS.items() if not k.startswith("extensions.")}
        (profile / "user.js").write_text(
            "".join(
                f"user_pref({json.dumps(k)}, {json.dumps(v)});\n"
                for k, v in quiet.items()
            )
        )
        zen = Zen(prefs={})
        zen.profile = profile
        zen.start()
        try:
            print(
                "Zen running; files:",
                sorted(
                    p.name
                    for p in profile.iterdir()
                    if p.name.startswith((".parent", "lock"))
                ),
            )
            refused = install(profile)
            refused_u = install(profile, "--uninstall")
            dry = install(profile, "--dry-run")
            assert not (profile / "extensions").exists(), "wrote while running"
        finally:
            zen.close(keep_profile=True)
        print("Zen quit")
        proceeded = install(profile)
        ok = refused != 0 and refused_u != 0 and dry == 0 and proceeded == 0
        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
