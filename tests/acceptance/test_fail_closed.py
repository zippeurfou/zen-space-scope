"""Fail closed: history-based suggestions stay off unless the add-on runs and
its self-check passed. Every "nothing shown" check has its positive control:
the same query in the same profile once the add-on is active and healthy."""

import json
import time

from zen import REPO_ROOT, Zen, ZenScriptError, urls, user_js_block_prefs

GUARDED = json.loads((REPO_ROOT / "src" / "guarded-prefs.json").read_text())
OFF = {p["name"]: p["off"] for p in GUARDED}
ON = {p["name"]: p["on"] for p in GUARDED}
NOTICE = "zen-space-scope-fail-closed"

# Rows that come from history, bookmarks, open tabs or top sites.
HISTORY_PROVIDERS = {
    "UrlbarProviderPlaces",
    "UrlbarProviderAutofill",
    "UrlbarProviderTopSites",
    "UrlbarProviderInputHistory",
    "UrlbarProviderHistoryUrlHeuristic",
    "UrlbarProviderOpenTabs",
    "UrlbarProviderRecentSearches",
    "UrlbarProviderRemoteTabs",
}


def history_based(rows):
    return [
        r
        for r in rows
        if r["provider"] in HISTORY_PROVIDERS
        or r["type"] in ("TAB_SWITCH", "REMOTE_TAB")
        or r["source"] in ("HISTORY", "BOOKMARKS", "TABS")
    ]


def prefs_now(zen: Zen) -> dict:
    return zen.chrome(
        """
        const out = {};
        for (const [name, want] of args[0]) {
          const get = { boolean: "getBoolPref", number: "getIntPref",
                        string: "getStringPref" }[typeof want];
          out[name] = Services.prefs[get](name);
        }
        return out;
        """,
        [[p["name"], p["off"]] for p in GUARDED],
    )


def notice(zen: Zen) -> str | None:
    """The label of the add-on's fail-closed notification in the selected
    window, or None."""
    return zen.chrome(
        """
        const box = win.gNotificationBox;
        await waitFor(() => !box._animating, "the notification box", 5000).catch(() => {});
        const item = box.getNotificationWithValue(args[0]);
        return item ? (item.label ?? item.messageText?.textContent ?? "") : null;
        """,
        NOTICE,
    )


def wait_status(zen: Zen, addon_id: str, pred, what: str, timeout: float = 15) -> dict:
    end = time.monotonic() + timeout
    while True:
        status = zen.addon_call(addon_id, "getStatus")
        if pred(status):
            return status
        if time.monotonic() > end:
            raise AssertionError(f"timed out waiting for {what}: {status}")
        time.sleep(0.2)


def launch_fail_closed(launch_zen) -> Zen:
    """A Zen whose user.js has the installer's block, and no add-on yet."""
    return launch_zen(user_js_block_prefs())


def visit_closed(zen, url):
    zen.visit(url)
    zen.close_tab(url)


def setup_pages(zen: Zen, site) -> dict:
    """In the profile's default space (no container): a history page visited
    twice (a top site), a bookmark, and a page left open in a tab."""
    pages = {
        "history": site.url("wiki.test", "a"),
        "bookmark": site.url("docs.test", "b"),
        "tab": site.url("zillow.test", "a"),
    }
    zen.visit(pages["history"])
    visit_closed(zen, pages["history"])
    zen.add_bookmark(pages["bookmark"], "docs b")
    zen.visit(pages["tab"])
    # Back to the blank tab the window started with.
    zen.chrome("win.gBrowser.selectedTab = win.gBrowser.tabs[0];")
    return pages


# Each query, and the row a healthy add-on shows for it in the default space.
QUERIES = {
    "history": ("wiki", lambda rows, p: p["history"] in urls(rows, type="URL")),
    "autofill": (
        "wiki.test/",
        lambda rows, p: any(r["provider"] == "UrlbarProviderAutofill" for r in rows),
    ),
    "bookmark": (
        "docs",
        lambda rows, p: any(
            r["url"] == p["bookmark"] and r["source"] == "BOOKMARKS" for r in rows
        ),
    ),
    "tab": ("zillow", lambda rows, p: p["tab"] in urls(rows, type="TAB_SWITCH")),
    "top site": ("", lambda rows, p: p["history"] in urls(rows)),
}


def assert_nothing_from_history(zen: Zen, *, from_blank_tab: bool = True) -> None:
    for name, (text, _) in QUERIES.items():
        rows = zen.query(text, from_blank_tab=from_blank_tab)
        assert not history_based(rows), (
            f"{name} query {text!r} shows {history_based(rows)}"
        )


def assert_everything_back(
    zen: Zen, pages: dict, *, from_blank_tab: bool = True
) -> None:
    top = zen.refresh_top_sites()
    assert pages["history"] in top, (
        f"setup: {pages['history']} is not a top site: {top}"
    )
    for name, (text, shows) in QUERIES.items():
        rows = zen.query(text, from_blank_tab=from_blank_tab)
        assert shows(rows, pages), (
            f"positive control: no {name} row for {text!r}: {rows}"
        )


def test_no_addon_means_no_history_rows(launch_zen, site, addon_xpi):
    """With only the user.js block (no add-on, or an add-on
    still starting), the address bar shows nothing from history."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    assert prefs_now(zen) == OFF
    pages = setup_pages(zen, site)
    assert_nothing_from_history(zen)

    addon = zen.install_addon(str(addon_xpi))
    zen.wait_addon_active(addon)
    assert_everything_back(zen, pages)


def test_addon_turns_suggestions_on(launch_zen, site, addon_xpi):
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    assert prefs_now(zen) == OFF
    addon = zen.install_addon(str(addon_xpi))
    status = zen.wait_addon_active(addon)
    assert status["failedChecks"] == []
    assert prefs_now(zen) == ON
    assert notice(zen) is None


def test_active_after_a_restart(launch_zen, site, addon_xpi):
    """The add-on installed for good starts with Zen, before or while the
    first window starts, and turns suggestions on once its checks pass."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    zen.close_tab(pages["tab"])
    addon = zen.install_addon(str(addon_xpi), temp=False)
    zen.wait_addon_active(addon)
    zen.restart()
    status = wait_status(zen, addon, lambda s: s["state"] != "starting", "start-up")
    assert status["state"] == "active", status
    assert prefs_now(zen) == ON
    zen.visit(pages["tab"])
    zen.chrome("win.gBrowser.selectedTab = win.gBrowser.tabs[0];")
    assert_everything_back(zen, pages)


def test_broken_internal_fails_closed(launch_zen, site, addon_xpi):
    """An internal renamed by a Zen update, before the add-on
    starts."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    # As a Zen update would: the method gets another name, and Zen's own
    # caller that address-bar queries reach (ZenSpaceManager.mjs:465) uses it.
    zen.chrome(
        """
        const zw = win.gZenWorkspaces;
        zw.renamedForTest = zw.getCurrentSpaceContainerId;
        zw.getCurrentSpaceContainerId = undefined;
        zw.getCurrentEssentialsContainer = function () {
          return this.getEssentialsSection(this.renamedForTest());
        };
        """
    )
    addon = zen.install_addon(str(addon_xpi))
    status = zen.addon_call(addon, "getStatus")
    assert status["state"] == "fail-closed", status
    assert "active-space-resolves" in status["failedChecks"], status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "active-space-resolves" in label, label
    # The blank-tab helper needs the renamed method; type in the blank tab.
    assert_nothing_from_history(zen, from_blank_tab=False)

    zen.chrome(
        """
        delete win.gZenWorkspaces.getCurrentSpaceContainerId;
        delete win.gZenWorkspaces.getCurrentEssentialsContainer;
        """
    )
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    assert prefs_now(zen) == ON
    assert notice(zen) is None
    assert_everything_back(zen, pages)


def test_failed_bookmark_read_fails_closed(launch_zen, site, addon_xpi):
    """Ruling R23: a failed read of Zen's bookmark spaces is a failed check."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    zen.chrome(
        """
        const storage = win.ZenWorkspaceBookmarksStorage;
        win.savedRead = storage.getBookmarkGuidsByWorkspace;
        storage.getBookmarkGuidsByWorkspace = async () => {
          throw new Error("bookmark spaces broken for the test");
        };
        """
    )
    addon = zen.install_addon(str(addon_xpi))
    status = wait_status(
        zen, addon, lambda s: s["state"] == "fail-closed", "the add-on to fail closed"
    )
    assert "bookmark-spaces" in status["failedChecks"], status
    assert status["bookmarks"] == "failed", status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "bookmark-spaces" in label, label
    assert_nothing_from_history(zen)

    zen.chrome(
        "win.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace = win.savedRead;"
    )
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    wait_status(zen, addon, lambda s: s["bookmarks"] == "ready", "the bookmark spaces")
    assert prefs_now(zen) == ON
    assert_everything_back(zen, pages)


def test_failed_bookmark_read_after_activation_fails_closed(
    launch_zen, site, addon_xpi
):
    """Ruling R23, once active: a bookmark change triggers a read of Zen's
    bookmark spaces, the read fails, and the add-on goes from active to
    fail-closed."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    addon = zen.install_addon(str(addon_xpi))
    zen.wait_addon_active(addon)
    wait_status(zen, addon, lambda s: s["bookmarks"] == "ready", "the bookmark spaces")
    assert prefs_now(zen) == ON
    assert_everything_back(zen, pages)

    zen.chrome(
        """
        const storage = win.ZenWorkspaceBookmarksStorage;
        win.savedRead = storage.getBookmarkGuidsByWorkspace;
        storage.getBookmarkGuidsByWorkspace = async () => {
          throw new Error("bookmark spaces broken for the test");
        };
        """
    )
    # A new bookmark makes the add-on read the spaces again.
    zen.add_bookmark(site.url("docs.test", "c"), "docs c")
    status = wait_status(
        zen, addon, lambda s: s["state"] == "fail-closed", "the add-on to fail closed"
    )
    assert status["failedChecks"] == ["bookmark-spaces"], status
    assert status["bookmarks"] == "failed", status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "bookmark-spaces" in label, label
    assert_nothing_from_history(zen)

    zen.chrome(
        "win.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace = win.savedRead;"
    )
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    assert_everything_back(zen, pages)


# Breaks the activeWorkspace setter of every window that starts from now on,
# as a renamed setter would: an own getter-only accessor over the class's
# getter. Whether this observer runs before or after the add-on's guard, the
# window ends up without the guard's setter wrap.
BREAK_SETTER_OF_NEXT_WINDOWS = """
win.breakSetter = {
  observe(subject) {
    const zw = subject.gZenWorkspaces;
    let proto = Object.getPrototypeOf(zw);
    let d;
    while (proto && !(d = Object.getOwnPropertyDescriptor(proto, "activeWorkspace"))) {
      proto = Object.getPrototypeOf(proto);
    }
    Object.defineProperty(zw, "activeWorkspace", { configurable: true, get: d.get });
    subject.brokenForTest = true;
  },
};
Services.obs.addObserver(win.breakSetter, "browser-delayed-startup-finished");
"""


def test_later_window_with_broken_setter_fails_closed(launch_zen, site, addon_xpi):
    """Ruling R27 for a window opened while active: its guard cannot wrap
    the activeWorkspace setter, so the add-on goes from active to
    fail-closed and turns suggestions off."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    first = zen.window
    addon = zen.install_addon(str(addon_xpi))
    zen.wait_addon_active(addon)
    assert prefs_now(zen) == ON
    assert_everything_back(zen, pages)

    zen.chrome(BREAK_SETTER_OF_NEXT_WINDOWS)
    second = zen.open_window()
    assert zen.chrome("return !!win.brokenForTest;"), "setup: the setter was not broken"
    zen.use_window(first)
    zen.chrome(
        'Services.obs.removeObserver(win.breakSetter, "browser-delayed-startup-finished");'
    )
    status = wait_status(
        zen, addon, lambda s: s["state"] == "fail-closed", "the add-on to fail closed"
    )
    assert status["failedChecks"] == ["space-switch-guard"], status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "space-switch-guard" in label, label
    assert_nothing_from_history(zen)

    zen.use_window(second)
    zen.chrome("delete win.gZenWorkspaces.activeWorkspace;")
    zen.use_window(first)
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    assert_everything_back(zen, pages)


def test_unguardable_window_fails_closed(launch_zen, site, addon_xpi):
    """Ruling R25: a window whose address-bar view cannot be guarded."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    # The view's cache loses its clear() for the guard; Zen's own calls still
    # reach the real cache.
    zen.chrome(
        """
        const view = win.gURLBar.view;
        const real = view.queryContextCache;
        win.realCache = real;
        const hidden = new Proxy(real, {
          get(target, key) {
            if (key === "clear") return undefined;
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        Object.defineProperty(view, "queryContextCache",
                              { value: hidden, configurable: true, writable: true });
        """
    )
    addon = zen.install_addon(str(addon_xpi))
    status = zen.addon_call(addon, "getStatus")
    assert status["state"] == "fail-closed", status
    assert "view-guard" in status["failedChecks"], status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "view-guard" in label, label
    assert_nothing_from_history(zen)

    zen.chrome("win.gURLBar.view.queryContextCache = win.realCache;")
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    assert_everything_back(zen, pages)


def test_missing_space_setter_fails_closed(launch_zen, site, addon_xpi):
    """Ruling R27: Zen's activeWorkspace setter is gone (renamed), so the
    view guard cannot clear the panel at the instant of a space switch."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    zen.chrome(
        """
        const zw = win.gZenWorkspaces;
        let proto = zw;
        let d;
        while (proto && !(d = Object.getOwnPropertyDescriptor(proto, "activeWorkspace"))) {
          proto = Object.getPrototypeOf(proto);
        }
        if (!d?.get || !d?.set) throw new Error("setup: no activeWorkspace accessor");
        Object.defineProperty(zw, "activeWorkspace", { configurable: true, get: d.get });
        """
    )
    addon = zen.install_addon(str(addon_xpi))
    status = zen.addon_call(addon, "getStatus")
    assert status["state"] == "fail-closed", status
    assert "space-switch-guard" in status["failedChecks"], status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "space-switch-guard" in label, label
    assert_nothing_from_history(zen)

    zen.chrome("delete win.gZenWorkspaces.activeWorkspace;")
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    assert_everything_back(zen, pages)


# A query with no controller, as paste-and-go and drop-and-go run it
# (UrlbarParentController.getHeuristicResult, :259-262).
NO_CONTROLLER_QUERY = """
const { UrlbarQueryContext } = ChromeUtils.importESModule(
  "chrome://browser/content/urlbar/UrlbarQueryContext.mjs", { global: "current" });
const { ProvidersManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");
const ctx = new UrlbarQueryContext({
  sapName: "urlbar", searchString: args[0], isPrivate: false, maxResults: 10,
  allowAutofill: true,
});
await ProvidersManager.getInstanceForSap("urlbar").startQuery(ctx);
return {
  heuristic: ctx.heuristicResult?.providerName ?? null,
  rows: ctx.results.map(r => ({ provider: r.providerName, url: r.payload.url ?? null })),
};
"""


def test_query_without_a_window_keeps_only_safe_rows(zen, site, addon):
    """A query with no controller has no window to take a space from, so it
    keeps only the allowlisted kinds rather than guess the most recent
    window's space."""
    assert addon is not None, "the add-on is not built"
    lemonde = site.url("lemonde.test", "a")
    visit_closed(zen, lemonde)
    rows = zen.query("lemonde.test/a")
    assert lemonde in urls(rows), f"positive control: the space lost its page: {rows}"
    assert any(r["provider"] == "UrlbarProviderAutofill" for r in rows), rows

    out = zen.chrome(NO_CONTROLLER_QUERY, "lemonde.test/a")
    assert out["heuristic"] == "UrlbarProviderHeuristicFallback", out
    assert not [
        r for r in out["rows"] if r["provider"] != "UrlbarProviderHeuristicFallback"
    ], f"a query with no window kept rows that need a space: {out}"


def test_disable_turns_suggestions_off(zen, site, addon):
    assert addon is not None, "the add-on is not built"
    wiki = site.url("wiki.test", "a")
    visit_closed(zen, wiki)
    assert prefs_now(zen) == ON
    assert wiki in urls(zen.query("wiki")), "positive control: no history row"

    status = zen.addon_call(addon, "setEnabled", False)
    assert status["state"] == "disabled", status
    assert prefs_now(zen) == OFF
    assert not history_based(zen.query("wiki"))

    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active", status
    assert wiki in urls(zen.query("wiki"))


QUERY_IS_FIREFOX_OWN = """
const { Query } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");
// Firefox's own methods, not wrappers (UrlbarProvidersManager.sys.mjs:754,914).
return String(Query.prototype.add).includes("Invalid provider passed to the add callback")
    && String(Query.prototype.start).includes("This Query has been started already");
"""


def test_no_api_call_after_shutdown_reinstalls_the_hook(zen, site, addon):
    """Disabling the add-on turns suggestions off and unhooks the address
    bar; an API object kept from before cannot hook it again."""
    assert addon is not None, "the add-on is not built"
    assert not zen.chrome(QUERY_IS_FIREFOX_OWN), "precondition: the hook is installed"
    zen.chrome(
        """
        const { ExtensionParent } = ChromeUtils.importESModule(
          "resource://gre/modules/ExtensionParent.sys.mjs");
        const extension = ExtensionParent.GlobalManager.getExtension(args[0]);
        const api = extension.apiManager.getAPI("spaceScope", extension, "addon_parent");
        win.keptApi = api.getAPI({ extension }).spaceScope;
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs");
        await (await AddonManager.getAddonByID(args[0])).disable();
        """,
        addon,
    )
    assert zen.chrome(QUERY_IS_FIREFOX_OWN), "the hook outlived the add-on"
    assert prefs_now(zen) == OFF

    status = zen.chrome(
        """
        await win.keptApi.start();
        await win.keptApi.setEnabled(true);
        return await win.keptApi.getStatus();
        """
    )
    assert status["state"] == "disabled", status
    assert zen.chrome(QUERY_IS_FIREFOX_OWN), "an API call after shutdown hooked again"
    assert prefs_now(zen) == OFF


def test_activation_that_throws_fails_closed(launch_zen, site, addon_xpi):
    """Ruling R40: an error nobody planned for while the add-on turns on must
    end in fail-closed, with the notice, not leave it at "starting". Here the
    bookmark watcher cannot be set up again after a failed bookmark read."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    pages = setup_pages(zen, site)
    zen.chrome(
        """
        const storage = win.ZenWorkspaceBookmarksStorage;
        win.savedRead = storage.getBookmarkGuidsByWorkspace;
        storage.getBookmarkGuidsByWorkspace = async () => {
          throw new Error("bookmark spaces broken for the test");
        };
        """
    )
    addon = zen.install_addon(str(addon_xpi))
    wait_status(
        zen, addon, lambda s: s["state"] == "fail-closed", "the add-on to fail closed"
    )

    # Turning it on again sets the bookmark watcher up anew, which throws.
    zen.chrome(
        """
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs");
        win.savedObservers = Object.getOwnPropertyDescriptor(PlacesUtils, "observers");
        const real = PlacesUtils.observers;
        Object.defineProperty(PlacesUtils, "observers", {
          configurable: true,
          value: {
            addListener() { throw new Error("unexpected, for the test"); },
            removeListener: (...a) => real.removeListener(...a),
          },
        });
        """
    )
    try:
        try:
            zen.addon_call(addon, "setEnabled", True)
        except ZenScriptError:
            pass  # before the fix the call itself rejected
        status = zen.addon_call(addon, "getStatus")
    finally:
        zen.chrome(
            """
            const { PlacesUtils } = ChromeUtils.importESModule(
              "resource://gre/modules/PlacesUtils.sys.mjs");
            delete PlacesUtils.observers;
            if (win.savedObservers) {
              Object.defineProperty(PlacesUtils, "observers", win.savedObservers);
            }
            win.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace = win.savedRead;
            """
        )
    assert status["state"] == "fail-closed", status
    assert status["failedChecks"] == ["activation"], status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "activation" in label, label
    assert_nothing_from_history(zen)

    # Positive control: with nothing in the way, the switch retries and wins.
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active" and status["failedChecks"] == [], status
    wait_status(zen, addon, lambda s: s["bookmarks"] == "ready", "the bookmark spaces")
    assert prefs_now(zen) == ON
    assert_everything_back(zen, pages)


def test_turning_debug_off_clears_the_log(zen, site, addon):
    """Ruling R40: the debug log holds the URLs of every decision, so it goes
    when debug is turned off."""
    assert addon is not None, "the add-on is not built"
    wiki = site.url("wiki.test", "a")
    visit_closed(zen, wiki)
    zen.addon_call(addon, "setDebug", True)
    zen.query("wiki")
    log = zen.addon_call(addon, "getLog")
    assert any(wiki in line for line in log), f"positive control: nothing logged: {log}"

    zen.addon_call(addon, "setDebug", False)
    assert zen.addon_call(addon, "getLog") == [], "the log outlived debug mode"
    zen.query("wiki")
    assert zen.addon_call(addon, "getLog") == [], "decisions are logged with debug off"


def test_start_up_failure_asks_for_a_restart(launch_zen, site, addon_xpi):
    """Ruling R40: the switch runs the checks again, except after a failure
    while the add-on was loading (here, reading history into its index). The
    notice and the options page then say to restart Zen, and the switch
    indeed does not retry."""
    assert addon_xpi is not None, "the add-on is not built"
    zen = launch_fail_closed(launch_zen)
    zen.chrome(
        """
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs");
        win.realConnection = PlacesUtils.promiseDBConnection;
        PlacesUtils.promiseDBConnection = function () {
          // Only the add-on's index load (src/glue/places.sys.mjs).
          if (new Error().stack.includes("/src/glue/places.sys.mjs")) {
            return Promise.reject(new Error("history broken for the test"));
          }
          return win.realConnection.apply(this, arguments);
        };
        """
    )
    addon = zen.install_addon(str(addon_xpi))
    status = zen.addon_call(addon, "getStatus")
    assert status["state"] == "fail-closed", status
    assert status["failedChecks"] == ["history-container-column"], status
    assert status["canRetry"] is False, status
    assert prefs_now(zen) == OFF
    label = notice(zen)
    assert label and "restart Zen" in label and "off and on again" not in label, label
    with zen.options_page(addon) as page:
        page.wait(
            "return document.querySelector('#state')?.textContent === 'fail-closed'",
            "fail-closed",
        )
        advice = page.text("#failed-box")
        assert "Restart Zen" in advice and "Switch the add-on" not in advice, advice

    zen.chrome(
        """
        ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs")
          .PlacesUtils.promiseDBConnection = win.realConnection;
        """
    )
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "fail-closed", f"the switch retried a start-up: {status}"
    assert prefs_now(zen) == OFF
