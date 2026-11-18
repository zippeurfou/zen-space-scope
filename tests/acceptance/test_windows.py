"""Windows without one of the user's spaces: popups, private windows and
unsynced windows (ruling R37). Zen gives them no space, or a placeholder one
in container 0 (ZenSpaceManager.mjs:93-99, :165-169, :771-773), so they show
no history-based suggestion, and they must not make the add-on fail closed.
Every "nothing shown" check has a positive control."""

import time

import pytest
from test_fail_closed import OFF, ON, history_based, prefs_now
from test_scoping import two_spaces, visit_closed
from zen import hosts, urls

HTML = "text/html; charset=utf-8"

# A started browser window, with or without spaces.
STARTED = """
await waitFor(() => win.gBrowserInit?.delayedStartupFinished && win.gZenWorkspaces,
              "the window to start");
await win.gZenWorkspaces.promiseInitialized;
"""

NO_SPACE = "return win.gZenWorkspaces.privateWindowOrDisabled === true;"


def stays_active(zen, addon, seconds=3.0):
    """The add-on's status, checked for `seconds`: a window opened just now
    is checked by the add-on a moment after it starts."""
    end = time.monotonic() + seconds
    while True:
        status = zen.addon_call(addon, "getStatus")
        assert status["state"] == "active", f"the add-on left active: {status}"
        assert status["failedChecks"] == [], status
        if time.monotonic() > end:
            return status
        time.sleep(0.2)


def pages_in_two_spaces(zen, site):
    """A page visited only in Work (container 0) and one only in Perso; Work
    is active. Returns (work page, perso page)."""
    work, perso = two_spaces(zen)
    wiki, lemonde = site.url("wiki.test", "a"), site.url("lemonde.test", "a")
    visit_closed(zen, wiki)
    zen.switch_space(perso)
    visit_closed(zen, lemonde)
    zen.switch_space(work)
    return wiki, lemonde


def assert_main_window_still_scoped(zen, wiki):
    assert prefs_now(zen) == ON
    rows = zen.query("wiki")
    assert wiki in urls(rows, type="URL"), f"Work lost its own page: {rows}"
    rows = zen.query("lemonde")
    assert "lemonde.test" not in hosts(rows), f"Perso's page shows in Work: {rows}"


def test_popup_window_does_not_fail_closed(zen, site, addon):
    """A popup (window.open with features, as a sign-in or payment window)
    has no toolbar or menubar chrome flag, so Zen never gives it spaces
    (ZenSpaceManager.mjs:93-99, :744-757). It is not a failed check."""
    wiki, _ = pages_in_two_spaces(zen, site)
    main = zen.window
    status = zen.addon_call(addon, "getStatus")
    assert status["state"] == "active" and prefs_now(zen) == ON, status

    opener = site.url("shop.test", "opener")
    target = site.url("shop.test", "popup-target")
    site.serve(
        opener,
        (
            "<!doctype html><title>opener</title><script>"
            f"window.open({target!r}, '_blank', 'popup,width=300,height=300');"
            "</script>"
        ).encode(),
        HTML,
    )
    zen.chrome('Services.prefs.setBoolPref("dom.disable_open_during_load", false);')
    try:
        popup = zen.wait_new_window(lambda: zen.visit(opener), ready=STARTED)
    finally:
        site.unserve(opener)
    assert zen.chrome(
        """
        const flags = win.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIAppWindow).chromeFlags;
        return !(flags & Ci.nsIWebBrowserChrome.CHROME_TOOLBAR) &&
               !(flags & Ci.nsIWebBrowserChrome.CHROME_MENUBAR) &&
               win.gZenWorkspaces.privateWindowOrDisabled === true &&
               !win.gZenWorkspaces.getActiveWorkspaceFromCache();
        """
    ), "setup: the new window is not a popup without spaces"
    assert zen.chrome('return Object.hasOwn(win.gURLBar.view, "onQueryResults");'), (
        "the popup's address-bar view is not guarded"
    )

    zen.use_window(main)
    stays_active(zen, addon)
    assert_main_window_still_scoped(zen, wiki)
    zen.use_window(popup)
    assert zen.chrome("return !win.closed;"), "setup: the popup closed meanwhile"


@pytest.mark.parametrize("kind", ["private", "unsynced"])
def test_window_without_a_space_shows_no_history(zen, site, addon, kind):
    """A private or unsynced window only has Zen's placeholder space in
    container 0 (ZenSpaceManager.mjs:165-169, :854-869). It must not show
    container-0 history, nor any other space's."""
    wiki, _ = pages_in_two_spaces(zen, site)
    main = zen.window
    zen.open_window(private=kind == "private", synced=kind != "unsynced")
    assert zen.chrome(NO_SPACE), f"setup: the {kind} window has its own spaces"
    is_private = zen.chrome(
        """
        return ChromeUtils.importESModule(
          "resource://gre/modules/PrivateBrowsingUtils.sys.mjs")
          .PrivateBrowsingUtils.isWindowPrivate(win);
        """
    )
    assert is_private == (kind == "private"), f"setup: not a {kind} window"
    assert zen.chrome('return Object.hasOwn(win.gURLBar.view, "onQueryResults");'), (
        f"the {kind} window's address-bar view is not guarded"
    )
    stays_active(zen, addon)

    for text in ("wiki", "lemonde"):
        rows = zen.query(text)
        assert not history_based(rows), (
            f"the {kind} window shows history for {text!r}: {history_based(rows)}"
        )
        # Positive control: the search row still shows.
        assert [r for r in rows if r["type"] == "SEARCH"], (
            f"the {kind} window lost its search row for {text!r}: {rows}"
        )
    rows = zen.query("wiki.test/a")
    assert not history_based(rows), (
        f"the {kind} window shows history: {history_based(rows)}"
    )
    # Positive control: the typed address still shows.
    typed = [r for r in rows if r["provider"] == "UrlbarProviderHeuristicFallback"]
    assert [r["url"] for r in typed if r["type"] == "URL"] == [wiki], (
        f"the {kind} window lost the typed address: {rows}"
    )
    assert not history_based(zen.query("")), f"the {kind} window shows top sites"

    zen.use_window(main)
    stays_active(zen, addon, seconds=0)
    assert_main_window_still_scoped(zen, wiki)


# Holds the self-check's first Places read (selfcheck.sys.mjs,
# "history-container-column") until win.gate.open() is called, so a test can
# act while an activation is under way. Other callers are not held.
ARM_GATE = """
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs");
const real = PlacesUtils.promiseDBConnection;
const gate = { reached: false };
gate.promise = new Promise(resolve => (gate.open = resolve));
gate.restore = () => { PlacesUtils.promiseDBConnection = real; };
PlacesUtils.promiseDBConnection = async function () {
  if (!gate.reached && new Error().stack.includes("selfcheck.sys.mjs")) {
    gate.reached = true;
    await gate.promise;
  }
  return real.apply(this, arguments);
};
win.gate = gate;
"""

# Starts setEnabled(true) without waiting for it, and returns once the
# self-check is held at the gate.
ENABLE_UP_TO_THE_GATE = """
const { ExtensionParent } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionParent.sys.mjs");
const extension = ExtensionParent.GlobalManager.getExtension(args[0]);
const api = extension.apiManager.getAPI("spaceScope", extension, "addon_parent");
win.enabling = api.getAPI({ extension }).spaceScope.setEnabled(true);
await waitFor(() => win.gate.reached, "the self-check to reach the gate");
"""


def test_window_started_during_activation_is_checked(zen, site, addon):
    """A window that finishes starting while the self-check runs is not in
    the list that run took, and the add-on's check of later windows only
    runs once it is active. Such a window still gets its per-window checks
    before suggestions come on."""
    wiki, _ = pages_in_two_spaces(zen, site)
    first = zen.window
    assert zen.addon_call(addon, "setEnabled", False)["state"] == "disabled"

    zen.chrome(ARM_GATE)
    try:
        zen.chrome(ENABLE_UP_TO_THE_GATE, addon)
        second = zen.open_window()
        # As a Zen update would for this window: the space lookup is gone
        # (and Zen's own caller that address-bar queries reach uses the
        # renamed one, ZenSpaceManager.mjs:465).
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
        zen.use_window(first)
        status = zen.chrome("win.gate.open(); return await win.enabling;")
    finally:
        zen.use_window(first)
        zen.chrome("win.gate.restore();")
    assert status["state"] == "fail-closed", (
        f"a window started during activation was not checked: {status}"
    )
    assert status["failedChecks"] == ["active-space-resolves"], status
    assert prefs_now(zen) == OFF

    # Positive control: with the lookup back, the same two windows pass.
    zen.use_window(second)
    zen.chrome(
        """
        delete win.gZenWorkspaces.getCurrentSpaceContainerId;
        delete win.gZenWorkspaces.getCurrentEssentialsContainer;
        """
    )
    zen.use_window(first)
    status = zen.addon_call(addon, "setEnabled", True)
    assert status["state"] == "active" and status["failedChecks"] == [], status
    assert_main_window_still_scoped(zen, wiki)


def test_conflicts_are_not_read_from_a_window_without_spaces(zen, addon):
    """The container conflict is read from a window that has the user's
    spaces. An unsynced window only has Zen's placeholder space, which would
    read as "no conflict" and clear the warning."""
    zen.make_space("Work", None)
    zen.make_space("Other", None)
    first = zen.window
    assert len(zen.addon_call(addon, "getStatus")["conflicts"]) == 1, "setup"

    # Windows are listed in the order they opened: once the first one is
    # closed, the unsynced window comes before the one with spaces.
    unsynced = zen.open_window(synced=False)
    assert zen.chrome(NO_SPACE), "setup: the unsynced window has its own spaces"
    assert zen.chrome("return win.gZenWorkspaces.getWorkspaces().length;") == 1, (
        "setup: the unsynced window has more than the placeholder space"
    )
    with_spaces = zen.open_window()
    zen.use_window(first)
    zen.chrome("win.setTimeout(() => win.close(), 0);")
    zen.use_window(with_spaces)
    order = zen.chrome(
        """
        await waitFor(() => [...Services.wm.getEnumerator("navigator:browser")].length == 2,
                      "the first window to close");
        return [...Services.wm.getEnumerator("navigator:browser")].map(
          w => w.gZenWorkspaces.privateWindowOrDisabled);
        """
    )
    assert order == [True, False], f"setup: the unsynced window is not first: {order}"

    status = stays_active(zen, addon, seconds=1)
    assert [sorted(c["spaces"]) for c in status["conflicts"]] == [["Other", "Work"]], (
        f"the conflict was read from the window without spaces: {status}"
    )
    assert unsynced != with_spaces
