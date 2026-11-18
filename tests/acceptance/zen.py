"""Drive a real Zen through Marionette for the acceptance tests.

Every `Zen` runs in a fresh temporary profile with its own Marionette port, so
it never touches, or attaches to, a Zen the user is already running. All
helpers run chrome-context scripts in the browser window that Marionette has
selected (the first window, unless a test switches windows).

Fixtures (registered through conftest.py):

- `zen`: a started `Zen` with the default prefs, closed after the test. A
  test that also uses `addon` gets the `user.js` block of
  `src/user.js.example` too (history-based suggestions off).
- `launch_zen`: a factory, `launch_zen(prefs=None) -> Zen`, for tests that
  need extra prefs at startup. Every Zen it starts is closed after the test.
- `addon`: when the repository root has a `manifest.json`, builds the add-on
  with `scripts/build.sh` (once per session), installs the XPI as a temporary
  add-on, waits until it reports `active`, and yields its id. Yields None and
  installs nothing otherwise.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest
from marionette_driver.addons import Addons
from marionette_driver.marionette import Marionette
from pages import Site

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_BINARY = {
    "darwin": "/Applications/Zen.app/Contents/MacOS/zen",
    "linux": "zen",
}

# The two prefs the add-on needs.
ADDON_PREFS: dict[str, Any] = {
    "xpinstall.signatures.required": False,
    "extensions.experiments.enabled": True,
}

# Quiet, deterministic startup in a throwaway profile.
BASE_PREFS: dict[str, Any] = {
    "marionette.port": 0,  # pick a free port, written to MarionetteActivePort
    "zen.welcome-screen.seen": True,
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.page": 0,
    "browser.startup.homepage": "about:blank",
    "startup.homepage_welcome_url": "about:blank",
    "browser.aboutwelcome.enabled": False,
    "browser.sessionstore.resume_from_crash": False,
    "app.update.disabledForTesting": True,
    "app.update.auto": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "datareporting.healthreport.uploadEnabled": False,
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "network.captive-portal-service.enabled": False,
    "network.connectivity-service.enabled": False,
    "network.trr.mode": 5,
    "privacy.userContext.enabled": True,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 5,
    "extensions.update.enabled": False,
}

USER_JS_EXAMPLE = REPO_ROOT / "src" / "user.js.example"
_USER_PREF = re.compile(r'^user_pref\(("(?:[^"\\]|\\.)*"), (.*)\);$')


def user_js_block_prefs() -> dict[str, Any]:
    """The prefs of the zen-space-scope block in `src/user.js.example`, the
    block the installer writes: the two add-on prefs and every guarded
    suggestion pref at its off value."""
    lines = USER_JS_EXAMPLE.read_text().splitlines()
    begin = lines.index("// zen-space-scope: begin")
    end = lines.index("// zen-space-scope: end")
    prefs: dict[str, Any] = {}
    for line in lines[begin + 1 : end]:
        m = _USER_PREF.match(line)
        if not m:
            raise ValueError(f"not a user_pref line in {USER_JS_EXAMPLE}: {line!r}")
        prefs[json.loads(m.group(1))] = json.loads(m.group(2))
    return prefs


STARTUP_TIMEOUT = 60  # seconds, Zen startup plus Marionette handshake

# Firefox 160's history flooding prevention does not store the 4th visit of
# one host within 5 s once the latest user input is over 3 s old
# (places.history.floodingPrevention.*, History.cpp
# UpdateOriginFloodingRestriction). The window starts at the host's first
# visit. A test that visits one host more than 3 times waits it out between
# groups of at most 3 visits, as a person reading pages would.
VISIT_WINDOW = 5.5  # seconds


def wait_out_visit_window() -> None:
    """Wait until Firefox stores visits of a host visited 3 times again."""
    time.sleep(VISIT_WINDOW)


SCRIPT_TIMEOUT = 30  # seconds, one chrome script


class ZenScriptError(RuntimeError):
    """A chrome-context script threw. The message carries the JS stack."""


class QueryCancelledError(ZenScriptError):
    """An address-bar query was cancelled before it finished, twice in a row.

    Its rows would be a truncated list, so `Zen.query` refuses to return them.
    """


def zen_binary() -> str:
    env = os.environ.get("ZEN_BINARY")
    if env:
        return env
    default = DEFAULT_BINARY.get(sys.platform)
    if default is None:
        raise RuntimeError(f"set ZEN_BINARY: no default Zen path on {sys.platform}")
    return default


def _pref_line(name: str, value: Any) -> str:
    return f"user_pref({json.dumps(name)}, {json.dumps(value)});\n"


# Wraps an async function body. `win` is the chrome window Marionette has
# selected. The result is JSON: {"ok": value} or {"error": "message + stack"}.
_PRELUDE = """
const __resolve = arguments[arguments.length - 1];
const args = Array.from(arguments).slice(0, -1);
const win = window;
(async () => {
/*BODY*/
})().then(
  value => __resolve({ ok: value === undefined ? null : value }),
  e => __resolve({ error: String(e) + "\\n" + (e && e.stack || "") })
);
"""

# Wait helper available to every script: waitFor(fn, what, ms).
_HELPERS = """
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => win.setTimeout(r, 50));
  }
}
"""


# Waits until a browser window has its spaces and address bar ready.
_WINDOW_READY = """
await waitFor(() => win.gZenWorkspaces && win.gURLBar, "browser window");
await win.delayedStartupPromise;
await win.gZenWorkspaces.promiseInitialized;
await waitFor(() => win.gZenWorkspaces.getActiveWorkspaceFromCache(), "an active space");
"""


class Zen:
    """One running Zen in a fresh temporary profile."""

    def __init__(
        self,
        site: Site | None = None,
        prefs: dict[str, Any] | None = None,
        *,
        binary: str | None = None,
        headless: bool | None = None,
    ) -> None:
        self.binary = binary or zen_binary()
        self.headless = (
            os.environ.get("HEADLESS") == "1" if headless is None else headless
        )
        self.prefs: dict[str, Any] = {**BASE_PREFS, **ADDON_PREFS}
        if site is not None:
            self.prefs.update(site.prefs)
        self.prefs.update(prefs or {})
        self.profile: Path | None = None
        self.process: subprocess.Popen[bytes] | None = None
        self.client: Marionette | None = None
        self._log = None
        self._default_space_claimed = False

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> Zen:
        if self.profile is None:
            self.profile = Path(tempfile.mkdtemp(prefix="zen-space-scope-profile-"))
            with open(self.profile / "user.js", "w") as f:
                f.writelines(
                    _pref_line(name, value) for name, value in self.prefs.items()
                )
        (self.profile / "MarionetteActivePort").unlink(missing_ok=True)

        args = [
            self.binary,
            "-marionette",
            "-no-remote",
            "-new-instance",
            "-profile",
            str(self.profile),
        ]
        if self.headless:
            args.append("-headless")
        env = {
            **os.environ,
            # Lets Marionette run chrome-context scripts. Zen 1.24.2b reads
            # this env var (RemoteAgent.sys.mjs:28,60); it has no CLI flag.
            "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1",
            "MOZ_CRASHREPORTER_DISABLE": "1",
            "MOZ_CRASHREPORTER_SHUTDOWN": "1",
        }
        if self.headless:
            env["MOZ_HEADLESS"] = "1"
        self._log = open(self.profile / "zen-stdout.log", "ab")  # noqa: SIM115 (lives as long as Zen)
        self.process = subprocess.Popen(
            args,
            env=env,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            port = self._wait_for_port()
            self.client = Marionette(host="127.0.0.1", port=port)
            self.client.start_session(timeout=STARTUP_TIMEOUT)
            self.client.set_context(Marionette.CONTEXT_CHROME)
            self.client.timeout.script = SCRIPT_TIMEOUT
            self.chrome(_WINDOW_READY, timeout=STARTUP_TIMEOUT)
            # A real user has clicked or typed by now. Without a user input on
            # record Firefox never restricts a visit, and the suite would run
            # in a state no user is in.
            self.user_input()
        except BaseException as e:
            log = self.profile / "zen-stdout.log"
            if log.exists():
                tail = log.read_text(errors="replace").splitlines()[-30:]
                e.add_note("Zen output (last 30 lines):\n" + "\n".join(tail))
            self.close()
            raise
        return self

    def _wait_for_port(self) -> int:
        assert self.profile is not None and self.process is not None
        port_file = self.profile / "MarionetteActivePort"
        deadline = time.monotonic() + STARTUP_TIMEOUT
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"Zen exited with {self.process.returncode} during startup"
                )
            if port_file.exists():
                text = port_file.read_text().strip()
                if text:
                    return int(text)
            time.sleep(0.1)
        raise TimeoutError(f"Marionette did not start within {STARTUP_TIMEOUT}s")

    def restart(self) -> Zen:
        """Quit Zen and start it again on the same profile, as a user would.
        Add-ons installed with `install_addon(path, temp=False)` stay."""
        self.close(keep_profile=True)
        return self.start()

    def close(self, *, keep_profile: bool = False) -> None:
        """Quit Zen, kill anything left of it, and delete the profile unless
        `keep_profile`."""
        if self.client is not None:
            # Best effort: the process is killed below whatever happens here.
            with contextlib.suppress(Exception):
                self.client._send_message("Marionette:Quit", {"flags": ["eForceQuit"]})
            with contextlib.suppress(Exception):
                self.client.delete_session(send_request=False)
            self.client = None
        if self.process is not None:
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
            # Zen's child processes share its process group.
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            self.process = None
        if self._log is not None:
            self._log.close()
            self._log = None
        if self.profile is not None and not keep_profile:
            shutil.rmtree(self.profile, ignore_errors=True)
            self.profile = None

    # -- generic chrome access --------------------------------------------

    def chrome(self, body: str, *args: Any, timeout: float = SCRIPT_TIMEOUT) -> Any:
        """Run `body` as an async function in the selected browser window.

        Inside `body`: `win` is the chrome window, `args` the positional
        arguments, `waitFor(fn, what, ms)` polls until `fn()` is truthy.
        `return` sends a JSON-serializable value back. A throw raises
        `ZenScriptError` with the JS stack.
        """
        assert self.client is not None, "Zen is not started"
        script = _PRELUDE.replace("/*BODY*/", _HELPERS + body)
        result = self.client.execute_async_script(
            script,
            script_args=list(args),
            script_timeout=int((timeout + 5) * 1000),
        )
        if result is None or "error" in result:
            raise ZenScriptError((result or {}).get("error", "script returned nothing"))
        return result["ok"]

    # -- user input ---------------------------------------------------------

    def user_input(self) -> None:
        """Click the middle of the selected window, as a user clicking the
        page, and check that Firefox took it as a user input.

        The click goes through WebDriver actions: Marionette synthesizes it
        inside this Zen (`windowUtils.sendMouseEvent`, through the same
        PresShell path as a real click), so it never reaches the screen or
        another application. Firefox keeps the time of the latest trusted
        click or key press (`UserActivation::LatestUserInputStart`, read by
        `windowUtils.millisSinceLastUserInput`, -1 before the first one), and
        history flooding prevention only runs once there is one.
        """
        assert self.client is not None
        width, height = self.chrome("return [win.innerWidth, win.innerHeight];")
        mouse = self.client.actions.sequence(
            "pointer", "mouse", {"pointerType": "mouse"}
        )
        mouse.pointer_move(
            width // 2, height // 2
        ).pointer_down().pointer_up().perform()
        self.client.actions.release()
        since = self.chrome("return win.windowUtils.millisSinceLastUserInput;")
        if not 0 <= since < 5000:
            raise RuntimeError(
                f"Firefox did not record the click as a user input: {since}"
            )

    # -- add-ons ------------------------------------------------------------

    def install_addon(self, path: str, *, temp: bool = True) -> str:
        """Install the add-on at `path` (a directory or an .xpi), temporarily
        unless `temp` is False.

        Returns the add-on id. Temporary add-ons need no signature and go
        away with the profile or a restart; a permanent install of an unsigned
        XPI relies on `xpinstall.signatures.required=false`.
        """
        assert self.client is not None
        return Addons(self.client).install(str(Path(path).resolve()), temp=temp)

    def addon_call(self, addon_id: str, method: str, *args: Any) -> Any:
        """Call `browser.spaceScope.<method>(*args)` of the installed add-on
        from chrome, through the same API object its background page uses,
        and return the result."""
        return self.chrome(
            """
            const [id, method, callArgs] = args;
            const { ExtensionParent } = ChromeUtils.importESModule(
              "resource://gre/modules/ExtensionParent.sys.mjs");
            const extension = ExtensionParent.GlobalManager.getExtension(id);
            if (!extension) throw new Error("add-on not running: " + id);
            const api = extension.apiManager.getAPI("spaceScope", extension, "addon_parent");
            if (!api) throw new Error("no spaceScope experiment in " + id);
            const value = await api.getAPI({ extension }).spaceScope[method](...callArgs);
            return value === undefined ? null : value;
            """,
            addon_id,
            method,
            list(args),
        )

    def wait_addon_active(self, addon_id: str) -> dict:
        """Wait until the add-on has started and return its status. Raises if
        the state is not `active`. `getStatus` resolves once start-up is
        over, so one call is enough."""
        status = self.addon_call(addon_id, "getStatus")
        if status["state"] != "active":
            raise RuntimeError(f"add-on is not active: {status}")
        return status

    @contextlib.contextmanager
    def options_page(self, addon_id: str):
        """Open the add-on's options page in a new tab and yield an
        `ExtensionPage` that runs scripts in it (Marionette's content
        context). The tab is closed and the chrome context restored after.
        Leave the `with` block before calling the other helpers: they run
        chrome scripts, which need the chrome context."""
        assert self.client is not None
        chrome_handle = self.window
        before = set(self.client.window_handles)
        self.chrome(
            """
            const policy = WebExtensionPolicy.getByID(args[0]);
            const tab = win.gBrowser.addTab(
              `moz-extension://${policy.mozExtensionHostname}/options/options.html`,
              { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
            win.gBrowser.selectedTab = tab;
            win.optionsTab = tab;
            """,
            addon_id,
        )
        deadline = time.monotonic() + SCRIPT_TIMEOUT
        while not (new := set(self.client.window_handles) - before):
            if time.monotonic() > deadline:
                self.chrome("win.gBrowser.removeTab(win.optionsTab);")
                raise TimeoutError("the options tab did not open")
            time.sleep(0.1)
        tab = new.pop()
        try:
            self.client.set_context(Marionette.CONTEXT_CONTENT)
            self.client.switch_to_window(tab)
            yield ExtensionPage(self.client)
        finally:
            self.client.set_context(Marionette.CONTEXT_CHROME)
            self.client.switch_to_window(chrome_handle)
            self.chrome("win.gBrowser.removeTab(win.optionsTab);")

    # -- containers and spaces ----------------------------------------------

    def container_id(self, name: str) -> int:
        """The userContextId of the container labelled `name`."""
        ucid = self.chrome(
            """
            const { ContextualIdentityService } = ChromeUtils.importESModule(
              "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
            const hit = ContextualIdentityService.getPublicIdentities().find(
              i => ContextualIdentityService.getUserContextLabel(i.userContextId) == args[0]);
            return hit ? hit.userContextId : null;
            """,
            name,
        )
        if ucid is None:
            raise LookupError(f"no container named {name!r}")
        return ucid

    def make_space(self, name: str, container: str | None) -> str:
        """Create a space called `name` and return its uuid.

        `container` is a container label, created if missing, or None for a
        space without a container (container 0). The active space does not
        change. A fresh profile already has one space without a container:
        the first `make_space(name, None)` renames and reuses it rather than
        leave two spaces without a container. Later calls with None create a
        new space.
        """
        claim_default = container is None and not self._default_space_claimed
        uuid = self.chrome(
            """
            const [name, containerName, claimDefault] = args;
            const { ContextualIdentityService } = ChromeUtils.importESModule(
              "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
            let ucid = 0;
            if (containerName !== null) {
              let hit = ContextualIdentityService.getPublicIdentities().find(
                i => ContextualIdentityService.getUserContextLabel(i.userContextId)
                     == containerName);
              hit ??= ContextualIdentityService.create(containerName, "fingerprint", "blue");
              ucid = hit.userContextId;
            }
            const zw = win.gZenWorkspaces;
            const noContainer = s => typeof s.containerTabId != "number" || s.containerTabId == 0;
            if (claimDefault) {
              const spaces = zw.getWorkspaces().filter(noContainer);
              if (spaces.length > 1) {
                throw new Error(`${spaces.length} spaces already have no container`);
              }
              if (spaces.length == 1) {
                zw.saveWorkspace({ ...spaces[0], name });
                await waitFor(() => zw.getWorkspaceFromId(spaces[0].uuid)?.name == name,
                              "the default space to be renamed");
                return spaces[0].uuid;
              }
            }
            const previous = zw.getActiveWorkspaceFromCache().uuid;
            const space = await zw.createAndSaveWorkspace(name, undefined, false, ucid);
            if (!space) throw new Error("createAndSaveWorkspace returned nothing");
            if (space.name !== name || space.containerTabId !== ucid) {
              throw new Error(`space came out as ${space.name}/${space.containerTabId}`);
            }
            await zw.changeWorkspaceWithID(previous);
            await waitFor(() => zw.getActiveWorkspaceFromCache().uuid == previous,
                          "switch back to the previous space");
            return space.uuid;
            """,
            name,
            container,
            claim_default,
        )
        if claim_default:
            self._default_space_claimed = True
        return uuid

    def switch_space(self, uuid: str) -> None:
        """Make space `uuid` the active space of the window."""
        self.chrome(
            """
            const zw = win.gZenWorkspaces;
            await zw.changeWorkspaceWithID(args[0]);
            await waitFor(() => zw.getActiveWorkspaceFromCache().uuid == args[0],
                          "space " + args[0]);
            """,
            uuid,
        )

    def active_space(self) -> dict[str, Any]:
        """`{uuid, name, container}` of the window's active space."""
        return self.chrome(
            """
            const zw = win.gZenWorkspaces;
            const s = zw.getActiveWorkspaceFromCache();
            return { uuid: s.uuid, name: s.name, container: zw.getCurrentSpaceContainerId() };
            """
        )

    # -- windows --------------------------------------------------------------

    def open_window(self, *, private: bool = False, synced: bool = True) -> str:
        """Open a new browser window, select it, and return its handle.

        `private` opens a private window. `synced=False` opens an unsynced
        window, as Zen's "New Unsynced Window" command does
        (zen-sets.js:117-118). Neither has the user's spaces, only a
        placeholder one (ZenSpaceManager.mjs:165-169).

        Marionette selects the window without focusing it, so the window
        opened last stays the most recent one
        (`Services.wm.getMostRecentWindow`).
        """
        return self.wait_new_window(
            lambda: self.chrome(
                "win.OpenBrowserWindow({ private: args[0], zenSyncedWindow: args[1] });",
                private,
                synced,
            )
        )

    def wait_new_window(self, opener, *, ready: str = _WINDOW_READY) -> str:
        """Call `opener()`, wait for the chrome window it opens, select it,
        run the `ready` script in it, and return its handle."""
        assert self.client is not None
        before = set(self.client.chrome_window_handles)
        opener()
        deadline = time.monotonic() + STARTUP_TIMEOUT
        while True:
            new = set(self.client.chrome_window_handles) - before
            if new:
                break
            if time.monotonic() > deadline:
                raise TimeoutError("the new browser window did not open")
            time.sleep(0.1)
        handle = new.pop()
        self.use_window(handle)
        self.chrome(ready, timeout=STARTUP_TIMEOUT)
        return handle

    def use_window(self, handle: str, *, focus: bool = False) -> None:
        """Direct every later helper at window `handle`. By default the window
        is not focused, so which window is the most recent does not change."""
        assert self.client is not None
        self.client.switch_to_window(handle, focus=focus)

    @property
    def window(self) -> str:
        """The handle of the window the helpers act on."""
        assert self.client is not None
        return self.client.current_chrome_window_handle

    # -- browsing -----------------------------------------------------------

    def visit(
        self, url: str, container: int | None = None, *, typed: bool = False
    ) -> None:
        """Open `url` in a new, selected tab of the active space.

        `container` is a userContextId; None means the active space's
        container, which is what Zen gives a new tab. Returns once Places has
        recorded the visit and the page title, so a query right after sees it.
        The tab stays open. `typed` records the visit as typed in the address
        bar (`markPageAsTyped`, as UrlbarUtils.sys.mjs:107 does): an origin's
        frecency, which origin autofill needs, only counts typed visits
        (PlacesFrecencyRecalculator.sys.mjs:325-352).

        Raises when Places reports another container or more than one visit,
        and says so when Firefox restricted the visit (history flooding
        prevention: the 4th visit of a host within 5 s, once the latest user
        input is over 3 s old), which it then does not store.
        """
        self.chrome(
            """
            const url = Services.io.newURI(args[0]).spec;
            const wanted = args[1];
            if (args[2]) {
              ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs")
                .PlacesUtils.history.markPageAsTyped(Services.io.newURI(url));
            }
            const ucid = wanted ?? win.gZenWorkspaces.getCurrentSpaceContainerId();
            let visited = false, titled = false;
            const seen = [];
            const listener = events => {
              for (const e of events) {
                if (e.url != url) continue;
                if (e.type == "page-visited") {
                  visited = true;
                  seen.push([e.userContextId ?? null, e.visitId ?? null]);
                }
                if (e.type == "page-title-changed") titled = true;
              }
            };
            const { PlacesUtils } = ChromeUtils.importESModule(
              "resource://gre/modules/PlacesUtils.sys.mjs");
            const types = ["page-visited", "page-title-changed"];
            PlacesObservers.addListener(types, listener);
            try {
              const tab = win.gBrowser.addTab(url, {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                userContextId: ucid,
              });
              win.gBrowser.selectedTab = tab;
              await waitFor(() => visited, "Places to announce " + url);
              // Visit id 0: Places did not store the visit
              // (History.cpp NotifyOriginRestrictedVisit).
              if (seen.some(([, id]) => id === 0)) {
                throw new Error(
                  `Firefox restricted the visit of ${url} and did not store it ` +
                  `(Places reported ${JSON.stringify(seen)} [container, visit id]). ` +
                  "History flooding prevention restricts the 4th visit of one host " +
                  "within 5 s once the latest user input is over 3 s old. Space the " +
                  "visits out (wait_out_visit_window()), use several hosts, or assert " +
                  "the restricted behavior.");
              }
              // A repeat visit does not change the title, so no title event.
              await waitFor(async () => titled || (await PlacesUtils.history.fetch(url))?.title,
                            "Places to record the title of " + url);
              await waitFor(() => tab.linkedBrowser.currentURI.spec == url,
                            "the tab to show " + url);
              const got = Number(tab.getAttribute("usercontextid") || 0);
              if (got != ucid) throw new Error(`tab opened in container ${got}, not ${ucid}`);
              // Places reports the container of every visit (Firefox 160).
              if (seen.length != 1 || seen[0][0] !== ucid) {
                throw new Error(`Places reported visits ${JSON.stringify(seen)} ` +
                                `[container, visit id] for one visit in container ${ucid}`);
              }
            } finally {
              PlacesObservers.removeListener(types, listener);
            }
            """,
            url,
            container,
            typed,
        )

    def refresh_top_sites(self) -> list[str]:
        """Rebuild the new-tab top sites from history now, rather than at the
        feed's next update, and return their URLs. A page becomes a top site
        once its frecency passes the feed's threshold; two visits do it."""
        return self.chrome(
            """
            const { AboutNewTab } = ChromeUtils.importESModule(
              "resource:///modules/AboutNewTab.sys.mjs");
            const store = AboutNewTab.activityStream.store;
            // With the user.js block the feed starts only once the add-on
            // turns its pref on; refresh() does nothing before its first one.
            const feed = await waitFor(
              () => store.getState().TopSites.initialized &&
                    store.feeds.get("feeds.system.topsites"),
              "the top-sites feed to start");
            feed.frecentCache.expire();
            await feed.refresh({ broadcast: true });
            return AboutNewTab.getTopSites().filter(Boolean).map(s => s.url);
            """
        )

    def recalculate_frecency(self) -> None:
        """Recalculate every outdated frecency now. Places does it later, from
        a deferred task (PlacesFrecencyRecalculator.sys.mjs:407-410), and
        origin autofill only fires for an origin whose frecency is set."""
        self.chrome(
            """
            const recalculator = Cc["@mozilla.org/places/frecency-recalculator;1"]
              .getService(Ci.nsIObserver).wrappedJSObject;
            await recalculator.recalculateAnyOutdatedFrecencies();
            """
        )

    def close_tab(self, url: str) -> None:
        """Close every tab of the window showing `url`, in any space, and wait
        until the address bar no longer counts them as open tabs. Their pages
        then come back as history rows instead of `TAB_SWITCH` rows."""
        self.chrome(
            """
            const url = Services.io.newURI(args[0]).spec;
            const gBrowser = win.gBrowser;
            const tabs = gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec == url);
            if (!tabs.length) throw new Error("no open tab on " + url);
            for (const tab of tabs) gBrowser.removeTab(tab, { animate: false });
            const { UrlbarProviderOpenTabs } = ChromeUtils.importESModule(
              "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs");
            await waitFor(async () => {
              const open = await UrlbarProviderOpenTabs.getDatabaseRegisteredOpenTabsForTests();
              return !gBrowser.tabs.some(t => tabs.includes(t)) &&
                     !open.some(o => o.url == url);
            }, "the tabs on " + url + " to close");
            """,
            url,
        )

    # -- bookmarks -----------------------------------------------------------

    def add_bookmark(self, url: str, title: str, parent: str | None = None) -> str:
        """Bookmark `url` as `title` in folder `parent` (a guid; None means
        "Other Bookmarks") through `PlacesUtils.bookmarks.insert`, without
        visiting it, and return the bookmark's guid. The address bar matches
        it right away."""
        return self.chrome(
            """
            const [url, title, parent] = args;
            const { PlacesUtils } = ChromeUtils.importESModule(
              "resource://gre/modules/PlacesUtils.sys.mjs");
            const { guid } = await PlacesUtils.bookmarks.insert({
              parentGuid: parent ?? PlacesUtils.bookmarks.unfiledGuid, url, title });
            return guid;
            """,
            url,
            title,
            parent,
        )

    def add_bookmark_folder(self, title: str) -> str:
        """Create a bookmark folder in "Other Bookmarks" and return its guid."""
        return self.chrome(
            """
            const { PlacesUtils } = ChromeUtils.importESModule(
              "resource://gre/modules/PlacesUtils.sys.mjs");
            const { guid } = await PlacesUtils.bookmarks.insert({
              parentGuid: PlacesUtils.bookmarks.unfiledGuid,
              type: PlacesUtils.bookmarks.TYPE_FOLDER, title: args[0] });
            return guid;
            """,
            title,
        )

    def assign_bookmark(self, guid: str, spaces: list[str]) -> None:
        """Set the spaces of bookmark or folder `guid` to the space uuids in
        `spaces` (empty: no space), the way Zen's bookmark dialog does:
        `PlacesUIUtils.BookmarkState` and `save()`, which writes
        `zen_bookmarks_workspaces` and notifies `workspace-bookmarks-updated`
        (PlacesUIUtils.sys.mjs `updateBookmarkWorkspaces`). Returns once
        Zen reads the new spaces back."""
        self.chrome(
            """
            const [guid, spaces] = args;
            const { PlacesUIUtils } = ChromeUtils.importESModule(
              "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs");
            const storage = win.ZenWorkspaceBookmarksStorage;
            const before = await storage.getBookmarkWorkspaces(guid);
            const state = new PlacesUIUtils.BookmarkState({
              info: { itemGuid: guid }, workspaces: before });
            await state._workspacesChanged(spaces);
            await state.save();
            const after = (await storage.getBookmarkWorkspaces(guid)).sort();
            if (JSON.stringify(after) != JSON.stringify([...spaces].sort())) {
              throw new Error(`bookmark ${guid} is in spaces ${after}, not ${spaces}`);
            }
            """,
            guid,
            spaces,
        )

    def query(self, text: str, *, from_blank_tab: bool = True) -> list[dict[str, Any]]:
        """Type `text` in the address bar and return the rows the user sees.

        Each row is `{provider, type, source, url, title}`: the provider name,
        the `RESULT_TYPE` and `RESULT_SOURCE` names, the payload URL (None
        when the row has none) and the title text the row shows (None when it
        shows none). Rows come from the open result view after the query
        finished, so they are what the muxer and the view kept.

        By default the query runs from a blank tab of the active space, like
        pressing Cmd+T and typing, and that tab is closed afterwards. Firefox
        never suggests the selected tab's own page (UrlbarProviderPlaces
        "Don't suggest switching to the current tab"), so querying from a
        page's own tab would hide it. `from_blank_tab=False` types into the
        selected tab instead.

        A query cancelled before it finished is retried once; a second cancel
        raises `QueryCancelledError` rather than return a truncated list.
        """
        for _attempt in range(2):
            result = self._query_once(text, from_blank_tab)
            if not result.get("cancelled"):
                return result["rows"]
        raise QueryCancelledError(
            f"query {text!r} was cancelled before it finished, twice in a row"
        )

    def _query_once(self, text: str, from_blank_tab: bool) -> dict[str, Any]:
        """One attempt: `{"rows": [...]}`, or `{"cancelled": True}`."""
        return self.chrome(
            """
            const [text, fromBlankTab] = args;
            const urlbar = win.gURLBar;
            const gBrowser = win.gBrowser;
            const { UrlbarShared } = ChromeUtils.importESModule(
              "chrome://browser/content/urlbar/UrlbarShared.mjs", { global: "current" });
            const nameOf = (table, v) =>
              Object.keys(table).find(k => table[k] === v) ?? String(v);
            const previousTab = gBrowser.selectedTab;
            let scratch = null;
            if (fromBlankTab) {
              scratch = gBrowser.addTab("about:blank", {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                userContextId: win.gZenWorkspaces.getCurrentSpaceContainerId(),
              });
              gBrowser.selectedTab = scratch;
              await waitFor(() => gBrowser.selectedTab == scratch, "the blank tab");
            }
            try {
              urlbar.view.close();
              let finished = null, cancelled = false;
              // Listeners run in insertion order, after the view's own, so
              // when this one fires the view has applied the final results.
              // A cancel also sends QUERY_FINISHED (UrlbarParentController
              // cancelQuery), but the view then stops before settling its
              // rows (UrlbarView onQueryFinished), so the list is truncated.
              const listener = {
                onQueryCancelled(ctx) { if (ctx.searchString == text) cancelled = true; },
                onQueryFinished(ctx) { if (ctx.searchString == text) finished = ctx; },
              };
              urlbar.controller.addListener(listener);
              try {
                urlbar.search(text);
                await urlbar.lastQueryContextPromise;
                await waitFor(() => finished || cancelled, "the address bar query to finish");
              } finally {
                urlbar.controller.removeListener(listener);
              }
              if (cancelled) return { cancelled: true };
              const rows = Array.from(
                urlbar.view.panel.querySelector(".urlbarView-results").children);
              // A finished query leaves every row visible and no stale row
              // (UrlbarView #removeStaleRows). Anything else means the view
              // did not settle, and its rows can't be trusted.
              const unsettled = rows.filter(
                r => r.hasAttribute("hidden") || r.hasAttribute("stale"));
              if (unsettled.length) {
                throw new Error(`query ${JSON.stringify(text)}: ${unsettled.length} ` +
                                "rows still hidden or stale after the query finished");
              }
              return { rows: rows
                .filter(r => r.style.display != "none" && r.result)
                .map(r => ({
                  provider: r.result.providerName,
                  type: nameOf(UrlbarShared.RESULT_TYPE, r.result.type),
                  source: nameOf(UrlbarShared.RESULT_SOURCE, r.result.source),
                  url: r.result.payload.url ?? null,
                  title: r.querySelector(".urlbarView-title")?.textContent ?? null,
                })) };
            } finally {
              urlbar.view.close();
              urlbar.handleRevert();
              if (scratch) {
                gBrowser.selectedTab = previousTab;
                gBrowser.removeTab(scratch, { animate: false });
              }
            }
            """,
            text,
            from_blank_tab,
        )


class ExtensionPage:
    """An extension page open in the selected tab, driven in the content
    context. Get one from `Zen.options_page`."""

    def __init__(self, client: Marionette) -> None:
        self.client = client

    def eval(self, js: str, *args: Any) -> Any:
        """Run `js` as a function body in the page and return its value."""
        return self.client.execute_script(js, script_args=list(args))

    def wait(self, js: str, what: str, timeout: float = 15) -> Any:
        """Poll `js` (a function body) until it returns something truthy."""
        end = time.monotonic() + timeout
        while True:
            value = self.eval(js)
            if value:
                return value
            if time.monotonic() > end:
                raise AssertionError(f"timed out waiting for {what}")
            time.sleep(0.1)

    def text(self, selector: str) -> str:
        return self.eval(
            "return document.querySelector(arguments[0])?.textContent ?? null;",
            selector,
        )

    def click(self, selector: str) -> None:
        self.eval("document.querySelector(arguments[0]).click();", selector)


def hosts(rows: list[dict[str, Any]]) -> set[str]:
    """The URL hosts of query rows, for assertions."""
    return {urlsplit(r["url"]).hostname for r in rows if r.get("url")} - {None}


def urls(rows: list[dict[str, Any]], *, type: str | None = None) -> list[str]:
    """The URLs of query rows, optionally only rows of RESULT_TYPE `type`."""
    return [
        r["url"] for r in rows if r.get("url") and (type is None or r["type"] == type)
    ]


@pytest.fixture
def launch_zen(site: Site):
    started: list[Zen] = []

    def launch(prefs: dict[str, Any] | None = None) -> Zen:
        z = Zen(site, prefs)
        started.append(z)
        return z.start()

    try:
        yield launch
    finally:
        for z in started:
            z.close()


@pytest.fixture
def zen(launch_zen, request) -> Zen:
    # A test with the add-on runs where it is meant to: a profile whose
    # user.js keeps history-based suggestions off until the add-on turns
    # them on.
    if "addon" in request.fixturenames:
        return launch_zen(user_js_block_prefs())
    return launch_zen()


@pytest.fixture(scope="session")
def addon_xpi() -> Path | None:
    """The add-on built from the repository by `scripts/build.sh`, once per
    session, or None when the repository has no `manifest.json` yet."""
    if not (REPO_ROOT / "manifest.json").exists():
        return None
    out = subprocess.run(
        ["sh", str(REPO_ROOT / "scripts" / "build.sh")],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(out.stdout.strip().splitlines()[-1])


@pytest.fixture
def addon(zen: Zen, addon_xpi: Path | None) -> str | None:
    if addon_xpi is None:
        return None
    addon_id = zen.install_addon(str(addon_xpi))
    zen.wait_addon_active(addon_id)
    return addon_id
