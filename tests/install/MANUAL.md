# Installer: manual real run

`tests/install/test_install.py` covers the installer against fake profile
trees. This is the one check against a real Zen. It never uses `-CreateProfile`
and never touches a registered profile or `profiles.ini` / `installs.ini`.

```sh
HEADLESS=1 uv run --project tests/acceptance python tests/install/real_run.py
HEADLESS=1 uv run --project tests/acceptance python tests/install/real_run.py --existing
HEADLESS=1 uv run --project tests/acceptance python tests/install/real_run.py --existing --no-sideload-prefs
```

`real_run.py` makes a temporary directory, runs
`scripts/install.py --profile <dir>`, launches Zen on that directory
(unregistered `-profile <dir>`, through the acceptance harness) and asks Zen
for the add-on's state. `--existing` lets Zen run once on the profile before
the install. `--no-sideload-prefs` is a control: it pins Zen's shipped values
(`autoDisableScopes=15`, `startupScanScopes=0`) in place of the installer's.

## Result (Zen 1.24.2b, macOS, 2026-11-17)

| Run | Add-on | Outcome |
| --- | --- | --- |
| fresh profile | `isActive: true`, `userDisabled: false`, `scope: 1` (profile), `foreignInstall: true`, `getStatus().state: "active"` | PASS |
| `--existing` (Zen ran once before the install) | same | PASS |
| `--existing --no-sideload-prefs` (control) | `isActive: false`, `userDisabled: true` | FAIL, as expected |

Reading: with `extensions.autoDisableScopes=14` the sideloaded add-on starts
enabled with no prompt; with Zen's shipped 15 it is added disabled. Why
`startupScanScopes=1` stays is in the R34 section below.

Marionette sets `extensions.autoDisableScopes=0` as a default
(`RecommendedPreferences.sys.mjs:296`), so a user value is needed to see the
effect; the installer's block is a user value, so it wins.

## `--latest` with no release yet

`uv run scripts/install.py --profile <dir> --latest` exits 1 with
"no release has been published yet; pass --xpi PATH ..." and writes nothing.

## Running-Zen check (R33)

```sh
HEADLESS=1 uv run --project tests/acceptance python tests/install/real_running.py
```

Starts a headless Zen on a temp profile (unregistered `-profile`; the profile
holds only `.parentlock`, no `lock` symlink), then runs the installer on it.
Result (macOS, Zen 1.24.2b): install exit 1 ("Zen is running on ..."),
`--uninstall` exit 1, `--dry-run` exit 0 with "note: Zen is running on this
profile; a real run would refuse" and nothing written; after Zen quit, install
exit 0. No Zen processes left behind.

## Uninstall and prefs.js (R32)

Unit-tested on fake `prefs.js` files (`test_install.py`): `--uninstall` deletes
the `user_pref` lines of exactly the names the block sets, keeps every other
byte, writes through a symlink, and prints each reset. Custom values from
before the install are not restored.

## Why `startupScanScopes=1` stays (R34)

`XPIProvider.sys.mjs:3345` runs the startup scan with `ignoreSideloads =
(appChanged === false)` and `:1641` skips scopes missing from the pref, so on
an already-run profile a new XPI is only found by the later `getNewSideloads`
scan (`:3440`). That matches the control: the file was found, but as a
disabled sideload after startup, not enabled during it.

## Install, run, uninstall, run

```sh
HEADLESS=1 uv run --project tests/acceptance python tests/install/real_uninstall.py
```

Temp profile, unregistered `-profile`, headless. Sequence and result (macOS,
Zen 1.24.2b), every check ok:

1. Install, start Zen: add-on `active`. After quitting, `prefs.js` holds every
   pref of the block (Zen copies them there), `extensions.json` lists the
   add-on. This is the leftover state `--uninstall` has to clean.
2. `--uninstall` exits 0.
3. Start Zen: `AddonManager.getAddonByID` is null at once (0 s of polling),
   `AddonManagerPrivate.getNewSideloads()` is empty, `ExtensionsUI.sideloaded`
   is empty (no sideload notification), no block pref has a user value.
   `getStartupChanges("uninstalled")` is empty (optional check; the removal is
   not reported as a startup change). No console message mentions the add-on,
   so there is no Browser Console error to document for the README.
4. After quitting: `prefs.js` has none of the block's names, `extensions.json`
   has no entry, the XPI is gone, `user.js` has no markers.
5. A second start and quit is still clean.

Marionette sets some extension prefs (for example `autoDisableScopes=0`) on
the default branch for the session; those are never persisted
(`RecommendedPreferences.sys.mjs`, "never persisted in the profile"), so the
persistent check is `prefs.js` on disk after quit.

The check `getNewSideloads` lives on `AddonManagerPrivate`
(`AddonManager.sys.mjs:3792,3809`); the sideload notification set is
`ExtensionsUI.sideloaded` (`ExtensionsUI.sys.mjs:66,89`).
