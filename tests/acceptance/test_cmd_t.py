"""Zen's Cmd+T opens the floating address bar with nothing typed. What that
panel shows must stay in the active space, from the first frame on."""

import pytest
from zen import urls, wait_out_visit_window

# viewRows(): the rows the open result view shows, with the title it displays.
ROWS_JS = """
const { UrlbarShared } = ChromeUtils.importESModule(
  "chrome://browser/content/urlbar/UrlbarShared.mjs", { global: "current" });
const nameOf = (table, v) => Object.keys(table).find(k => table[k] === v) ?? String(v);
function viewRows() {
  const rows = Array.from(win.gURLBar.view.panel.querySelector(".urlbarView-results").children);
  return rows.filter(r => r.style.display != "none" && r.result).map(r => ({
    provider: r.result.providerName,
    type: nameOf(UrlbarShared.RESULT_TYPE, r.result.type),
    source: nameOf(UrlbarShared.RESULT_SOURCE, r.result.source),
    url: r.result.payload.url ?? null,
    title: r.result.payload.title ?? null,
    shownTitle: r.querySelector(".urlbarView-title")?.textContent ?? null,
    userContext: r.result.payload.userContext ?? null,
  }));
}
"""

# Cmd+T as Zen runs it: key_newNavigatorTab -> cmd_newNavigatorTabNoEvent ->
# BrowserCommands.openTab -> ZenUrlbarController.handleNewTab, which runs
# Browser:OpenLocation -> openLocation -> UrlbarView.autoOpen. Returns every
# set of rows the open panel showed, from right after the command until the
# empty query finished.
CMD_T = (
    ROWS_JS
    + """
const urlbar = win.gURLBar;
let finished = null;
const l = { onQueryFinished(c) { if (c.searchString == "") finished = c; } };
urlbar.controller.addListener(l);
const seen = [];
const sample = () => {
  if (urlbar.view.isOpen) {
    seen.push(viewRows().map(r => ({ type: r.type, url: r.url, title: r.shownTitle,
                                     container: r.userContext?.id ?? null })));
  }
};
try {
  win.document.getElementById("cmd_newNavigatorTabNoEvent").doCommand();
  sample();
  while (!finished) {
    await new Promise(r => win.setTimeout(r, 5));
    sample();
  }
  await new Promise(r => win.setTimeout(r, 50));
  sample();
} finally {
  urlbar.controller.removeListener(l);
  if (urlbar._zenHandleUrlbarClose) urlbar._zenHandleUrlbarClose();
  urlbar.view.close();
  await new Promise(r => win.setTimeout(r, 300));
}
return seen;
"""
)


def two_spaces(zen):
    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")
    return work, perso


def test_cmd_t_never_shows_another_space_rows(zen, site, addon):
    """The view caches the last top-sites results per window
    (UrlbarView.mjs QueryContextCache) and replays them when Cmd+T opens the
    panel (autoOpen, :853-854), before the new query runs and without going
    through the providers. Work's open tab must not show up in Perso."""
    work, perso = two_spaces(zen)
    zen.switch_space(work)
    wiki = site.url("wiki.test", "a")
    zen.visit(wiki)
    zen.close_tab(wiki)
    zen.visit(wiki)  # a top site, open in a Work tab
    zen.visit(site.url("wiki.test", "b"))
    zen.switch_space(perso)
    zen.visit(site.url("zillow.test", "a"))
    assert wiki in zen.refresh_top_sites(), "setup: wiki.test/a is not a top site"

    zen.switch_space(work)
    seen = zen.chrome(CMD_T)
    assert any(r["url"] == wiki for rows in seen for r in rows), (
        f"setup: Work's Cmd+T does not show its own tab: {seen}"
    )

    zen.switch_space(perso)
    seen = zen.chrome(CMD_T)
    leaked = [r for rows in seen for r in rows if r["url"] == wiki]
    assert not leaked, f"Perso's Cmd+T panel showed Work's tab: {leaked} (all: {seen})"


# Opens a blank tab in the active space and selects it.
BLANK_TAB = """
const gBrowser = win.gBrowser;
const tab = gBrowser.addTab("about:blank", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  userContextId: win.gZenWorkspaces.getCurrentSpaceContainerId(),
});
gBrowser.selectedTab = tab;
await waitFor(() => gBrowser.selectedTab == tab &&
                    gBrowser.currentURI.spec == "about:blank", "the blank tab");
"""

# Types `args[0]` in a new blank tab of the active space and closes the panel
# the way Escape does: the rows stay in the closed view (an abandoned search).
# Returns the URLs of the rows it showed.
ABANDONED_SEARCH = (
    ROWS_JS
    + BLANK_TAB
    + """
const [text] = args;
const urlbar = win.gURLBar;
let finished = null;
const l = { onQueryFinished(c) { if (c.searchString == text) finished = c; } };
urlbar.controller.addListener(l);
try {
  urlbar.search(text);
  await waitFor(() => finished, "the query");
  return viewRows().map(r => r.url);
} finally {
  urlbar.controller.removeListener(l);
  urlbar.view.close();
}
"""
)

# Presses Cmd+L (Browser:OpenLocation -> openLocation -> UrlbarView.autoOpen,
# browser.js:1403-1408) in a new blank tab of the active space whose input
# holds `args[0]`, as an abandoned search leaves it. Returns every set of row
# URLs the open panel showed until the reopened query finished.
CMD_L_ON_ABANDONED_SEARCH = (
    ROWS_JS
    + BLANK_TAB
    + """
const [text] = args;
const urlbar = win.gURLBar;
const sleep = ms => new Promise(r => win.setTimeout(r, ms));
const seen = [];
const sample = () => {
  if (urlbar.view.isOpen) {
    seen.push(viewRows().map(r => r.url));
  }
};
urlbar.view.close();
urlbar.value = text;
let finished = false;
const l = { onQueryFinished() { finished = true; } };
urlbar.controller.addListener(l);
try {
  win.document.getElementById("Browser:OpenLocation").doCommand();
  sample();
  const end = Date.now() + 3000;
  while (!finished && Date.now() < end) {
    await sleep(5);
    sample();
  }
  await sleep(50);
  sample();
} finally {
  urlbar.controller.removeListener(l);
  urlbar.view.close();
  urlbar.handleRevert();
}
return seen;
"""
)


def turn_off(zen, addon, how):
    if how == "switched off":
        assert zen.addon_call(addon, "setEnabled", False)["state"] == "disabled"
    else:
        zen.chrome(
            """
            const { AddonManager } = ChromeUtils.importESModule(
              "resource://gre/modules/AddonManager.sys.mjs");
            await (await AddonManager.getAddonByID(args[0])).disable();
            """,
            addon,
        )
    assert not zen.chrome(GUARDED), "setup: the view is still guarded"


TURNED_OFF = ["switched off", "disabled in the add-on manager"]


@pytest.mark.parametrize("how", TURNED_OFF)
def test_turned_off_addon_leaves_no_rows_to_reopen_in_another_space(
    zen, site, addon, how
):
    """Turning the add-on off removes its view guards. The rows of the last
    query stay in the closed view, and the view reopens them without a query
    when the input holds the same text on the same page
    (UrlbarView.mjs:158-163, :884-889, :927-933), which nothing would drop
    any more. They must go with the guards."""
    work, perso = two_spaces(zen)
    wiki = site.url("wiki.test", "a")
    zen.switch_space(work)
    zen.visit(wiki)
    zen.close_tab(wiki)

    # Positive control, in Work with the add-on on: the view reopens an
    # abandoned search's rows, Work's own.
    rows = zen.chrome(ABANDONED_SEARCH, "wiki")
    assert wiki in rows, f"setup: Work does not show its own page: {rows}"
    seen = zen.chrome(CMD_L_ON_ABANDONED_SEARCH, "wiki")
    assert seen and wiki in seen[0], (
        f"setup: Cmd+L does not reopen the rows of an abandoned search: {seen}"
    )

    rows = zen.chrome(ABANDONED_SEARCH, "wiki")
    assert wiki in rows, f"setup: Work does not show its own page: {rows}"
    turn_off(zen, addon, how)
    zen.switch_space(perso)
    seen = zen.chrome(CMD_L_ON_ABANDONED_SEARCH, "wiki")
    leaked = [rows for rows in seen if wiki in rows]
    assert not leaked, f"Perso's panel showed Work's rows: {seen}"


@pytest.mark.parametrize("how", TURNED_OFF)
def test_turned_off_addon_leaves_no_replay_for_another_space(zen, site, addon, how):
    """Turning the add-on off removes its view guards. What the view cached
    while it was on (Work's empty-bar rows) must go with them, or Cmd+T in
    Perso replays it (UrlbarView.mjs:853-854) with nothing left to drop it."""
    work, perso = two_spaces(zen)
    zen.switch_space(work)
    wiki = site.url("wiki.test", "a")
    zen.visit(wiki)
    zen.close_tab(wiki)
    zen.visit(wiki)  # a top site, open in a Work tab
    zen.visit(site.url("wiki.test", "b"))
    zen.switch_space(perso)
    zen.visit(site.url("zillow.test", "a"))
    assert wiki in zen.refresh_top_sites(), "setup: wiki.test/a is not a top site"

    zen.switch_space(work)
    seen = zen.chrome(CMD_T)
    assert any(r["url"] == wiki for rows in seen for r in rows), (
        f"setup: Work's Cmd+T does not show its own tab: {seen}"
    )
    assert zen.chrome("return !!win.gURLBar.view.queryContextCache.topSitesContext;"), (
        "setup: Work's Cmd+T left no cached top sites"
    )

    turn_off(zen, addon, how)

    zen.switch_space(perso)
    seen = zen.chrome(CMD_T)
    leaked = [r for rows in seen for r in rows if "wiki.test" in (r["url"] or "")]
    assert not leaked, f"Perso's Cmd+T panel showed Work's rows: {leaked} (all: {seen})"


def test_switch_tab_title_is_the_tab_own(zen, site, addon):
    """Places keeps one title per URL for every container. Two essentials on
    the same URL in two containers (a webmail signed into two accounts) must
    each show their own title, never the other space's."""
    zen.chrome(
        'Services.prefs.setBoolPref("zen.workspaces.separate-essentials", true);'
    )
    work, perso = two_spaces(zen)
    inbox = site.url("mail.test", "inbox")

    def essential_inbox(account):
        zen.visit(site.url("mail.test", f"login-{account}"))
        zen.close_tab(site.url("mail.test", f"login-{account}"))
        zen.visit(inbox)
        zen.chrome(
            """
            const t = win.gBrowser.selectedTab;
            win.gZenPinnedTabManager.addToEssentials(t);
            await waitFor(() => t.hasAttribute("zen-essential"), "an essential");
            """
        )

    zen.switch_space(perso)
    essential_inbox("home")
    zen.visit(site.url("zillow.test", "a"))
    wait_out_visit_window()  # 4 visits of mail.test
    zen.switch_space(work)
    essential_inbox("work")  # loaded last: Places now titles the URL "Inbox - work"
    zen.visit(site.url("wiki.test", "a"))

    for space, name, ucid, title in (
        (perso, "Perso", zen.container_id("Perso"), "Inbox - home"),
        # Positive control: Work's own row keeps Work's title.
        (work, "Work", 0, "Inbox - work"),
    ):
        zen.switch_space(space)
        rows = zen.chrome(
            ROWS_JS
            + """
            const urlbar = win.gURLBar;
            let finished = null;
            const l = { onQueryFinished(c) { if (c.searchString == "inbox") finished = c; } };
            urlbar.controller.addListener(l);
            urlbar.search("inbox");
            await waitFor(() => finished, "the query");
            urlbar.controller.removeListener(l);
            const rows = viewRows();
            urlbar.view.close();
            urlbar.handleRevert();
            return rows.map(r => ({ type: r.type, url: r.url, title: r.shownTitle,
                                    container: r.userContext?.id ?? null }));
            """
        )
        tabs = [r for r in rows if r["type"] == "TAB_SWITCH" and r["url"] == inbox]
        assert [r["container"] for r in tabs] == [ucid], (
            f"setup: {name} should see exactly its own inbox tab: {rows}"
        )
        assert tabs[0]["title"] == title, (
            f"{name}'s own inbox tab shows another space's page title: {tabs[0]}"
        )


def test_space_switch_drops_the_cached_replay(zen, site, addon):
    """Zen reports the end of every space switch to its change listeners
    (ZenSpaceManager.mjs:2728-2736, in registration order); the add-on's
    listener empties the window's replay caches there. Other paths clear the
    cache earlier in a switch, so a listener registered before the add-on's
    puts Work's context back, and one registered after it reads the cache."""
    work, perso = two_spaces(zen)
    zen.switch_space(work)
    wiki = site.url("wiki.test", "a")
    zen.visit(wiki)
    zen.close_tab(wiki)
    zen.visit(wiki)
    zen.visit(site.url("wiki.test", "b"))
    assert wiki in zen.refresh_top_sites(), "setup: wiki.test/a is not a top site"
    zen.chrome(CMD_T)
    assert zen.chrome(
        """
        win.savedTopSites = win.gURLBar.view.queryContextCache.topSitesContext;
        return !!win.savedTopSites;
        """
    ), "setup: Work's Cmd+T left no cached top sites"

    zen.addon_call(addon, "setEnabled", False)
    zen.chrome(
        """
        const cache = win.gURLBar.view.queryContextCache;
        win.gZenWorkspaces.addChangeListeners(() => cache.put(win.savedTopSites));
        """
    )
    zen.addon_call(addon, "setEnabled", True)
    zen.chrome(
        """
        const cache = win.gURLBar.view.queryContextCache;
        win.seenAfterAddon = [];
        win.gZenWorkspaces.addChangeListeners(() => {
          win.seenAfterAddon.push(!!cache.topSitesContext);
        });
        """
    )
    zen.switch_space(perso)
    assert zen.chrome("return win.seenAfterAddon;") == [False], (
        "the add-on's change listener left Work's cached top sites"
    )


GUARDED = 'return Object.hasOwn(win.gURLBar.view, "onQueryResults");'


def test_view_guard_on_every_window_and_off_when_disabled(zen, addon):
    first = zen.window
    assert zen.chrome(GUARDED), "the first window's view is not guarded"
    second = zen.open_window()
    assert zen.chrome(GUARDED), "a window opened later is not guarded"

    zen.addon_call(addon, "setEnabled", False)
    for handle in (first, second):
        zen.use_window(handle)
        assert not zen.chrome(GUARDED), f"window {handle} still guarded when disabled"
    zen.addon_call(addon, "setEnabled", True)
    for handle in (first, second):
        zen.use_window(handle)
        assert zen.chrome(GUARDED), f"window {handle} not guarded after re-enable"


# Types `text` with the address bar focused, leaves the panel open, then
# switches to space `args[1]` and returns every set of rows the open panel
# showed from the switch until it settled.
SWITCH_WITH_PANEL_OPEN = (
    ROWS_JS
    + """
const [text, target] = args;
const urlbar = win.gURLBar;
let finished = null;
const l = { onQueryFinished(c) { if (c.searchString == text) finished = c; } };
urlbar.controller.addListener(l);
const rowsNow = () => viewRows().map(r => ({ type: r.type, url: r.url,
                                             container: r.userContext?.id ?? null }));
try {
  urlbar.focus();
  urlbar.search(text);
  await waitFor(() => finished, "the query");
  const before = { open: urlbar.view.isOpen, rows: rowsNow() };
  const seen = [];
  let done = false;
  win.gZenWorkspaces.changeWorkspaceWithID(target).then(() => { done = true; });
  // What the open panel shows once the window is in the target space.
  const sample = () => {
    if (urlbar.view.isOpen &&
        win.gZenWorkspaces.getActiveWorkspaceFromCache()?.uuid == target) {
      seen.push(rowsNow());
    }
  };
  while (!done) {
    sample();
    await new Promise(r => win.setTimeout(r, 5));
  }
  for (let i = 0; i < 20; i++) {
    sample();
    await new Promise(r => win.setTimeout(r, 10));
  }
  return { before, seen };
} finally {
  urlbar.controller.removeListener(l);
  urlbar.view.close();
  urlbar.handleRevert();
}
"""
)


def test_open_panel_drops_rows_on_space_switch(zen, site, addon):
    """A space switch does not close an open address-bar panel (only
    ZenSpaceCreation.mjs:183 closes it), and the rows on screen never pass
    through onQueryResults again. Work's rows must not stay in Perso."""
    work, perso = two_spaces(zen)
    work_page = site.url("wiki.test", "a")
    perso_page = site.url("wiki.test", "p")
    zen.switch_space(perso)
    zen.visit(perso_page)
    zen.close_tab(perso_page)
    zen.switch_space(work)
    zen.visit(work_page)
    zen.close_tab(work_page)

    out = zen.chrome(SWITCH_WITH_PANEL_OPEN, "wiki", perso)
    assert out["before"]["open"] and any(
        r["url"] == work_page for r in out["before"]["rows"]
    ), f"setup: Work's panel does not show Work's page: {out['before']}"
    leaked = [r for rows in out["seen"] for r in rows if r["url"] == work_page]
    assert not leaked, (
        f"Perso's open panel kept Work's rows: {leaked} (all: {out['seen']})"
    )

    # Positive control: Perso's own page still shows in Perso.
    rows = zen.query("wiki")
    assert perso_page in urls(rows), f"Perso lost its own page: {rows}"
    assert work_page not in urls(rows), f"Perso shows Work's page: {rows}"
