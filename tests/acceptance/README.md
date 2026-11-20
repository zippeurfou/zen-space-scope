# Acceptance tests

These tests drive a real Zen through Marionette and read the address bar the
way a user sees it.

## Run

From the repository root:

```sh
HEADLESS=1 uv run --project tests/acceptance pytest tests/acceptance
```

- `HEADLESS=1` runs Zen without windows. Spaces, containers and the address
  bar all work headless. Leave it unset to watch the run.
- `ZEN_BINARY` points at the Zen executable. It defaults to
  `/Applications/Zen.app/Contents/MacOS/zen` on macOS and `zen` on Linux.
- Requires Zen 1.24.2b or later, and Python 3.12 through `uv` (no other setup).
- `-k lemonde -x` runs one test and stops at the first failure.

Each test starts its own Zen in a fresh temporary profile, with `-no-remote`
and a Marionette port picked at random, so a Zen you are already using is never
touched. The profile and every process of the test Zen are removed after the
test, pass or fail.

Once its window is ready, each test Zen gets one click in the middle of the
page (`user_input()`), so it runs with a user input on record like a user's
Zen, and history flooding prevention is live. The click is a WebDriver
action that Marionette synthesizes inside that Zen: it never moves your
pointer or reaches another window.

`uv.lock` is not committed: uv writes the URL of whatever package index the
machine is configured with into it.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and once a day:

- `node --test tests/unit/*.test.mjs` (Node 24);
- `uv run --with pytest --with pyyaml pytest tests/install tests/release`, on
  Linux and macOS;
- this suite on Linux, headless, against the latest Zen release
  (`zen.linux-x86_64.tar.xz` from `zen-browser/desktop`, extracted so that
  `ZEN_BINARY` is `<dir>/zen/zen`). The daily run catches a Zen release that
  breaks the add-on.

Every job sets `UV_NO_CONFIG=1`, so uv ignores any machine-level `uv.toml`
and resolves test dependencies from PyPI. To run what CI runs, from the
repository root:

```sh
export UV_NO_CONFIG=1
node --test tests/unit/*.test.mjs
uv run --with pytest --with pyyaml pytest tests/install tests/release
HEADLESS=1 uv run --project tests/acceptance pytest tests/acceptance
```

`.github/workflows/release.yml` runs on a `v<version>` tag. It fails unless
the tag matches `manifest.json`'s version, runs the unit, install and release
tests, then publishes exactly one XPI plus `updates.json`
(`scripts/make_updates_json.py`) as the latest release.

The suite was written and run on macOS. The CI job is its first run on
Linux, so a failure there on a first push is more likely the Linux setup
than the add-on.

## Self-update

The manifest's `update_url` is the latest release's `updates.json`. Its
`update_link` is the versioned asset URL, with the file's sha256 as
`update_hash` and `strict_min_version` 160.0. Zen checks it once a day and
installs a newer version in place. `test_self_update.py` serves both files
from the local test server over plain HTTP, which needs
`extensions.checkUpdateSecurity=false` in those temporary profiles only (Zen
otherwise disables an add-on whose `update_url` is not https); the real
channel is https and needs no pref change.

## How it works

- **Pages** (`pages.py`). The `site` fixture runs one HTTP server on
  `127.0.0.1` and Zen uses it as its HTTP and HTTPS proxy. Pages keep plain URLs
  such as `http://lemonde.test/a` (no port, no DNS). The served hosts are in
  `pages.HOSTS`. Any other host gets a 404 and HTTPS tunnels are refused, so
  nothing reaches the internet. Each page is titled `"<host> <name>"`, except
  on `mail.test`, a webmail stand-in: `/login-<account>` sets an `account`
  cookie, and every other page is titled `"Inbox - <account>"`. Cookies are
  per container, so one URL gets a different title in each space.
- **Zen** (`zen.py`). Zen 1.24.2b allows chrome-context scripts only when the
  environment variable `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` is set
  (`remote/content/components/RemoteAgent.sys.mjs`). It has no command-line flag
  for this, so the harness sets the variable.
- **The add-on**. When `manifest.json` exists at the repository root, the
  `addon` fixture builds the add-on with `scripts/build.sh` (once per session),
  installs the XPI as a temporary add-on, and waits until it reports `active`.
  Without `manifest.json` it installs nothing. The profile always has
  `xpinstall.signatures.required=false` and `extensions.experiments.enabled=true`.
- **Fail closed**. A test that uses `addon` gets a `zen` whose `user.js` also
  has the installer's block from `src/user.js.example` (every guarded
  suggestion pref off, see `src/guarded-prefs.json`), so the add-on has to turn
  suggestions on itself. Other tests get Zen's defaults.
  `zen.user_js_block_prefs()` returns that block as a dict, for `launch_zen`.

## Fixtures

| Fixture | What it gives |
|---|---|
| `site` | `Site` (session scope). `site.url(host, name) -> "http://host/name"`. `site.serve(url, body, content_type)` serves a file at any plain-HTTP URL until `site.unserve(url)` (the self-update tests publish an XPI and `updates.json` this way). |
| `zen` | A started `Zen` with the default prefs, plus the `user.js` block when the test also uses `addon`. |
| `launch_zen` | `launch_zen(prefs: dict \| None = None) -> Zen`, for extra startup prefs. Can start several. |
| `addon_xpi` | The XPI built by `scripts/build.sh` (session scope), or `None` without `manifest.json`. |
| `addon` | The add-on id after a temporary install of `addon_xpi`, once it is `active`, or `None` without `manifest.json`. |

`Zen` methods. They act on the browser window Marionette has selected.

| Method | Does |
|---|---|
| `make_space(name, container: str \| None) -> str` | Returns the uuid of a space called `name`. `container` is a container label, created if missing; `None` means no container (container 0). The first call with `None` renames and reuses the profile's default space, so the profile never has two spaces without a container by accident; later calls with `None` create one. The active space does not change. |
| `switch_space(uuid)` | Makes that space active. |
| `active_space() -> dict` | `{uuid, name, container}` of the active space. |
| `container_id(name) -> int` | The container's userContextId. |
| `visit(url, container: int \| None = None, *, typed=False)` | Opens `url` in a new selected tab of the active space and waits until Places has recorded the visit and the title, and the tab shows the page. `None` uses the active space's container, as Zen does. The tab stays open. `typed=True` records the visit as typed in the address bar. Fails when Places reports another container or count for the visit, and says so when Firefox restricted the visit (see below). |
| `user_input()` | Clicks the middle of the window through WebDriver actions, the way a user clicks the page, and checks Firefox recorded it as a user input. The click is synthesized inside the test Zen, so it never reaches the screen. |
| `recalculate_frecency()` | Recalculates every outdated frecency now. Places does it later on its own. Origin autofill needs typed visits and an up-to-date frecency. |
| `close_tab(url)` | Closes every tab of the window on `url` and waits until the address bar no longer counts it as open. |
| `refresh_top_sites() -> list[str]` | Rebuilds the top sites from history now and returns their URLs. A page needs two visits to become a top site. With the `user.js` block the top-sites feed only starts once the add-on is active; this waits for it. |
| `add_bookmark(url, title, parent=None) -> str` | Bookmarks `url` without visiting it (`PlacesUtils.bookmarks.insert`) in folder `parent` (a guid; `None` is "Other Bookmarks") and returns its guid. The address bar matches it right away. |
| `add_bookmark_folder(title) -> str` | Creates a bookmark folder in "Other Bookmarks" and returns its guid. |
| `assign_bookmark(guid, spaces: list[str])` | Sets the spaces (uuids; `[]` for none) of a bookmark or folder the way Zen's bookmark dialog does (`PlacesUIUtils.BookmarkState.save()`, which writes `zen_bookmarks_workspaces` and notifies `workspace-bookmarks-updated`), and checks Zen reads them back. |
| `query(text, *, from_blank_tab=True) -> list[dict]` | Types `text` and returns the visible result rows as `{provider, type, source, url, title}`, with `type` and `source` as `UrlbarShared` names (`"URL"`, `"TAB_SWITCH"`, `"HISTORY"`...) and `title` the title text the row shows. A query cancelled before it finishes is retried once, then raises `QueryCancelledError`. |
| `open_window(*, private=False, synced=True) -> str` | Opens a browser window, selects it for the helpers without focusing it, and returns its handle. `private=True` opens a private window and `synced=False` an unsynced one; neither has the user's spaces. |
| `wait_new_window(opener, *, ready=...) -> str` | Calls `opener()`, waits for the chrome window it opens (a popup, say), selects it, runs the `ready` script in it and returns its handle. |
| `use_window(handle, *, focus=False)` | Selects another window for the helpers. Focus it to make it the most recent window. |
| `window` | The handle of the selected window. |
| `install_addon(path) -> str` | Temporary install of a directory or `.xpi`. |
| `addon_call(addon_id, method, *args)` | Calls `browser.spaceScope.<method>` of the add-on from chrome and returns the result. |
| `options_page(addon_id)` | Context manager: opens the add-on's options page in a new tab and, once it has loaded, yields an `ExtensionPage` (`eval(js, *args)`, `wait(js, what)`, `text(selector)`, `click(selector)`) that runs in the page's content context. Leave the `with` block before calling other helpers; they need the chrome context. |
| `chrome(body, *args, timeout=30)` | Runs `body` as an async function in the window. `win`, `args` and `waitFor(fn, what, ms)` are in scope; `return` a JSON value. A throw raises `ZenScriptError` with the JS stack. |

`zen.hosts(rows)` returns the set of URL hosts in a list of rows, and
`zen.urls(rows, type=None)` their URLs, optionally for one result type.
`zen.wait_out_visit_window()` waits until Firefox stores visits of a host
again (see below).

Things worth knowing:

- Firefox does not store every visit. Once the latest click or key press is
  more than 3 s old, history flooding prevention drops the 4th visit of one
  host within 5 s of its first, and announces it as container 0 with visit id
  0 (`places.history.floodingPrevention.*`). A test that visits one host more
  than 3 times either uses several hosts or calls `wait_out_visit_window()`
  between groups of at most 3 visits. Never turn flooding prevention off:
  real users have it on. `test_restricted_visits.py` asserts what happens to
  a restricted visit.
- A fresh profile starts with one space named "Space" that has no container.
- `query` runs from a blank tab of the active space (Cmd+T, then typing) and
  closes it afterwards. Firefox never suggests the selected tab's own page, so a
  query from that page's tab would not show it. Pass `from_blank_tab=False` to
  type into the selected tab.
- While a page is open in a tab, Firefox shows it as a `TAB_SWITCH` row instead
  of a `HISTORY` row. Close the tab to see the history row.
- An empty query (`query("")`) shows the top sites.
- Origin autofill (typing `wiki.t` and getting `wiki.test/`) only fires for an
  origin with typed visits whose frecency has been recalculated: use
  `visit(url, typed=True)` and then `recalculate_frecency()`.
- Popups, private windows and unsynced windows have none of the user's
  spaces. `test_windows.py` shows how to open each.
- New bookmarks are in no space, as in Zen. After `assign_bookmark` the add-on
  rereads the spaces in the background; its `getStatus()["bookmarks"]` is
  `"loading"` until it has caught up (`test_bookmarks.py` waits for that).
  Bookmark rows have `source == "BOOKMARKS"`; match on it so a history row for
  the same URL can't pass for a bookmark.
- A query for an engine alias followed by a space (`"@google wiki"`) enters
  search mode, which restarts the query under another search string, so
  `query` reports it as cancelled. Query the alias alone.
