# Contributing

Small, focused changes with a test are the easiest to review. The add-on is privileged and hides data on purpose, so changes that could let a row through need a test that proves they can't.

[docs/design.md](docs/design.md) explains how the add-on works and resolves the "ruling R20" style references in code comments.

## Tooling

Python runs through [uv](https://docs.astral.sh/uv/) only. Don't call `python` or `pip` directly. Unit tests need Node 24. Don't commit `uv.lock` files: uv writes the URL of whatever package index your machine uses into them, and CI resolves test dependencies from PyPI instead.

## Running the tests

From the repository root:

```sh
node --test tests/unit/*.test.mjs
uv run --with pytest pytest tests/install
uv run --with pytest --with pyyaml pytest tests/release
HEADLESS=1 MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 uv run --project tests/acceptance pytest tests/acceptance
```

The unit tests cover the filter rules. The install tests run the installer against fake profile trees, and never touch a real profile. The release tests check the build and the update manifest.

The installer reads one environment variable, `ZEN_SPACE_SCOPE_RELEASES_URL`. It is a test hook. It replaces the GitHub API URL that `--latest` asks for the latest release, so the install tests can point it at a fake. It has to be an HTTPS URL, like every URL the installer follows, and anything else is refused before a byte is written. Don't set it for a real install.

The acceptance tests drive a real Zen through Marionette, in a fresh temporary profile each, so a Zen you are using is not touched. They need Zen 1.24.2b or later. `ZEN_BINARY` points at the executable (it defaults to the macOS app path, or `zen` on Linux), and leaving `HEADLESS` unset lets you watch. `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` is required by Zen for chrome-context scripts; the harness sets it too. Details are in [tests/acceptance/README.md](tests/acceptance/README.md).

To run what CI runs, set `UV_NO_CONFIG=1` first so uv ignores any machine-level config.

## CI

CI runs on every push and once a day, on Linux, against the latest Zen release, so a Zen update that breaks the add-on shows up without a push. GitHub disables scheduled workflows after 60 days without repository activity. A daily run that has stopped is not a green one, so check that it is still running.

## Releasing

Tag `v<version>`, where the version matches `manifest.json`. The release workflow fails if they differ, then runs the tests, builds the XPI, hashes it and publishes it with `updates.json`. Never upload release assets by hand: the self-update channel trusts the hash that workflow writes.

If a release changes a guarded pref (`src/guarded-prefs.json`), say so in the release notes. Self-updates don't touch `user.js`, so users have to re-run the installer to get the new block.

## Commits

Conventional commits (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`), one logical change each.
