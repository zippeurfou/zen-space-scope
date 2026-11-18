"""Places stores one title per URL for every container. A history row on a URL
used in two spaces must not show the title another space's page wrote."""

from test_bookmarks import wait_addon_caught_up
from test_cmd_t import ROWS_JS, two_spaces
from zen import wait_out_visit_window

# Types `text` from a blank tab of the active space and returns the rows with
# the title the view shows.
QUERY_JS = (
    ROWS_JS
    + """
const [text] = args;
const urlbar = win.gURLBar;
const gBrowser = win.gBrowser;
const previousTab = gBrowser.selectedTab;
const scratch = gBrowser.addTab("about:blank", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  userContextId: win.gZenWorkspaces.getCurrentSpaceContainerId(),
});
gBrowser.selectedTab = scratch;
await waitFor(() => gBrowser.selectedTab == scratch, "the blank tab");
let finished = null;
const l = { onQueryFinished(c) { if (c.searchString == text) finished = c; } };
urlbar.controller.addListener(l);
try {
  urlbar.search(text);
  await waitFor(() => finished, "the query");
  return viewRows().map(r => ({ type: r.type, source: r.source, url: r.url,
                                title: r.shownTitle }));
} finally {
  urlbar.controller.removeListener(l);
  urlbar.view.close();
  urlbar.handleRevert();
  gBrowser.selectedTab = previousTab;
  gBrowser.removeTab(scratch, { animate: false });
}
"""
)


def signed_in_visit(zen, site, account, url):
    """Visit `url` in the active space after signing in as `account` there."""
    login = site.url("mail.test", f"login-{account}")
    zen.visit(login)
    zen.close_tab(login)
    zen.visit(url)
    zen.close_tab(url)


def test_history_row_title_blank_when_shared(zen, site, addon):
    work, perso = two_spaces(zen)
    inbox = site.url("mail.test", "inbox")
    solo = site.url("wiki.test", "solo")

    zen.switch_space(perso)
    signed_in_visit(zen, site, "home", inbox)
    wait_out_visit_window()  # 4 visits of mail.test
    zen.switch_space(work)
    signed_in_visit(zen, site, "work", inbox)  # Places now says "Inbox - work"
    zen.visit(solo)
    zen.close_tab(solo)

    leaked_titles = {"Inbox - work", "Inbox - home"}
    for space, name in ((work, "Work"), (perso, "Perso")):
        zen.switch_space(space)
        rows = zen.chrome(QUERY_JS, "inbox")
        history = [r for r in rows if r["url"] == inbox and r["type"] == "URL"]
        assert history, f"setup: {name} shows no history row for the inbox: {rows}"
        for row in history:
            assert row["title"] not in leaked_titles, (
                f"{name}'s history row shows a page title shared across containers: {row}"
            )

    # The debug log says why a title was blanked: both containers visited it.
    zen.addon_call(addon, "setDebug", True)
    zen.chrome(QUERY_JS, "inbox")
    perso_ucid = zen.container_id("Perso")
    blanked = [
        line
        for line in zen.addon_call(addon, "getLog")
        if line.startswith(f"  title blanked HISTORY {inbox}:")
    ]
    assert blanked and all(line.endswith(f"[{perso_ucid}, 0]") for line in blanked), (
        f"no reason logged for the blanked title: {blanked}"
    )
    zen.addon_call(addon, "setDebug", False)

    zen.switch_space(work)
    rows = zen.chrome(QUERY_JS, "solo")
    own = [r for r in rows if r["url"] == solo and r["type"] == "URL"]
    assert [r["title"] for r in own] == ["wiki.test solo"], (
        f"a URL visited only in Work lost its title in Work: {rows}"
    )


def test_bookmark_row_keeps_its_own_title_on_a_shared_url(zen, site, addon):
    """Ruling R26: a bookmark's title is its own, not the shared page title,
    so it stays. A bookmark with no title of its own shows the page title
    instead (UrlbarProviderPlaces.sys.mjs:1213, bookmarkTitle || historyTitle),
    and that one is blanked like a history row."""
    work, perso = two_spaces(zen)
    named = site.url("mail.test", "inbox")
    untitled = site.url("mail.test", "sent")
    zen.add_bookmark(named, "My mail")
    zen.add_bookmark(untitled, "")

    zen.switch_space(perso)
    signed_in_visit(zen, site, "home", named)
    zen.visit(untitled)
    zen.close_tab(untitled)
    wait_out_visit_window()  # 6 visits of mail.test
    zen.switch_space(work)
    signed_in_visit(zen, site, "work", named)
    zen.visit(untitled)
    zen.close_tab(untitled)
    wait_addon_caught_up(zen, addon)

    leaked_titles = {"Inbox - work", "Inbox - home"}
    for space, name in ((work, "Work"), (perso, "Perso")):
        zen.switch_space(space)
        rows = zen.chrome(QUERY_JS, "mail.test/")
        marks = {r["url"]: r for r in rows if r["source"] == "BOOKMARKS"}
        assert set(marks) == {named, untitled}, (
            f"setup: {name} does not show both bookmarks: {rows}"
        )
        assert marks[named]["title"] == "My mail", (
            f"{name}'s bookmark lost its own title: {marks[named]}"
        )
        assert marks[untitled]["title"] not in leaked_titles, (
            f"{name}'s title-less bookmark shows a shared page title: {marks[untitled]}"
        )


HTML = "text/html; charset=utf-8"


def titled_page(title):
    return f"<!doctype html><title>{title}</title><h1>{title}</h1>".encode()


def visit_closed(zen, url, times=1, typed=False):
    for _ in range(times):
        zen.visit(url, typed=typed)
        zen.close_tab(url)


def autofill_rows(rows):
    return [
        (r["url"], r["title"])
        for r in rows
        if r["provider"] == "UrlbarProviderAutofill"
    ]


def test_origin_autofill_title_is_not_another_space_root_page(zen, site, addon):
    """Origin autofill shows the title of the origin's root page, from any of
    its http, https and www variants (UrlbarProviderAutofill.sys.mjs:225-246).
    Work visited another page of the origin, so the row is Work's, but the
    root page and its title are Perso's (ruling R36)."""
    work, perso = two_spaces(zen)
    perso_root, work_root = "http://shop.test/", "http://wiki.test/"
    site.serve(perso_root, titled_page("Perso private root"), HTML)
    site.serve(work_root, titled_page("Work wiki root"), HTML)
    try:
        # Origin autofill needs typed visits and an up-to-date frecency.
        zen.switch_space(perso)
        visit_closed(zen, perso_root, times=2, typed=True)
        wait_out_visit_window()  # 4 visits of shop.test
        zen.switch_space(work)
        visit_closed(zen, site.url("shop.test", "public"), times=2, typed=True)
        visit_closed(zen, work_root, times=2, typed=True)
        zen.recalculate_frecency()

        rows = zen.query("shop.t")
        autofill = autofill_rows(rows)
        assert [url for url, _ in autofill] == [perso_root], (
            f"setup: Work has no origin autofill for the shared origin: {rows}"
        )
        assert not [r for r in rows if "Perso private root" in (r["title"] or "")], (
            f"Work shows the title of a page only Perso visited: {rows}"
        )

        # Positive control: an origin only Work visited keeps its title.
        rows = zen.query("wiki.t")
        assert autofill_rows(rows) == [(work_root, "Work wiki root")], (
            f"Work lost the title of its own origin: {rows}"
        )
    finally:
        site.unserve(perso_root)
        site.unserve(work_root)


def test_url_autofill_title_is_not_another_space_page(zen, site, addon):
    """URL autofill completes to the next slash and shows the page's title
    when that prefix is itself a visited URL
    (UrlbarProviderAutofill.sys.mjs:996-1017). Work visited a page under the
    folder, so the row is Work's, but the folder page and its title are
    Perso's (ruling R36)."""
    work, perso = two_spaces(zen)
    folder = site.url("shop.test", "dir/")
    own = site.url("wiki.test", "solo")
    zen.switch_space(perso)
    visit_closed(zen, folder, times=3)
    wait_out_visit_window()  # 4 visits of shop.test
    zen.switch_space(work)
    visit_closed(zen, site.url("shop.test", "dir/page"))
    visit_closed(zen, own, times=2)

    rows = zen.query("shop.test/d")
    autofill = autofill_rows(rows)
    assert [url for url, _ in autofill] == [folder], (
        f"setup: Work has no autofill for the folder it visited under: {rows}"
    )
    assert not [r for r in rows if r["title"] == "shop.test dir/"], (
        f"Work shows the title of a page only Perso visited: {rows}"
    )
    # Positive controls: Work's own page keeps its title, and so does Perso's
    # folder page in Perso (which also shows the row above was that page's).
    rows = zen.query("wiki.test/s")
    assert autofill_rows(rows) == [(own, "wiki.test solo")], (
        f"Work lost the title of its own page: {rows}"
    )
    zen.switch_space(perso)
    rows = zen.query("shop.test/d")
    assert autofill_rows(rows) == [(folder, "shop.test dir/")], (
        f"Perso lost the title of its own page: {rows}"
    )


# With bookmarks on, an autofill row's title is the title of any bookmark of
# the page, whatever its space (UrlbarProviderAutofill.sys.mjs:164-172,
# :259-261, ifnull(b.title, ...)). Ruling R43: that title shows only where the
# page's bookmarks show.
LABEL = "Perso bank login"


def bookmark_title_setup(zen, site, addon, owner):
    """A page visited only in Work, bookmarked as LABEL in space `owner`."""
    work, perso = two_spaces(zen)
    page = site.url("shop.test", "account")
    zen.visit(page)
    zen.close_tab(page)
    guid = zen.add_bookmark(page, LABEL)
    zen.assign_bookmark(guid, [{"work": work, "perso": perso}[owner]])
    wait_addon_caught_up(zen, addon)
    return page


def test_url_autofill_title_is_not_another_space_bookmark(zen, site, addon):
    page = bookmark_title_setup(zen, site, addon, "perso")
    rows = zen.query("shop.test/acc")
    autofill = autofill_rows(rows)
    assert [url for url, _ in autofill] == [page], f"setup: no autofill in Work: {rows}"
    assert not [r for r in rows if LABEL in (r["title"] or "")], (
        f"Work shows the title of a bookmark only Perso has: {rows}"
    )


def test_url_autofill_title_is_the_space_own_bookmark(zen, site, addon):
    """Positive control: the same bookmark in Work shows its title there."""
    page = bookmark_title_setup(zen, site, addon, "work")
    rows = zen.query("shop.test/acc")
    assert autofill_rows(rows) == [(page, LABEL)], (
        f"Work lost the title of its own bookmark: {rows}"
    )


def origin_bookmark_setup(zen, site, addon, owner):
    """The root of shop.test, visited (typed) only in Work, bookmarked as
    LABEL in space `owner`."""
    work, perso = two_spaces(zen)
    root = "http://shop.test/"
    site.serve(root, titled_page("shop home"), HTML)
    visit_closed(zen, root, times=2, typed=True)
    zen.recalculate_frecency()
    guid = zen.add_bookmark(root, LABEL)
    zen.assign_bookmark(guid, [{"work": work, "perso": perso}[owner]])
    wait_addon_caught_up(zen, addon)
    return root


def test_origin_autofill_title_is_not_another_space_bookmark(zen, site, addon):
    try:
        root = origin_bookmark_setup(zen, site, addon, "perso")
        rows = zen.query("shop.t")
        autofill = autofill_rows(rows)
        assert [url for url, _ in autofill] == [root], f"setup: no autofill: {rows}"
        assert not [r for r in rows if LABEL in (r["title"] or "")], (
            f"Work shows the title of a bookmark only Perso has: {rows}"
        )
    finally:
        site.unserve("http://shop.test/")


def test_origin_autofill_title_is_the_space_own_bookmark(zen, site, addon):
    """Positive control: the same bookmark in Work shows its title there."""
    try:
        root = origin_bookmark_setup(zen, site, addon, "work")
        rows = zen.query("shop.t")
        assert autofill_rows(rows) == [(root, LABEL)], (
            f"Work lost the title of its own bookmark: {rows}"
        )
    finally:
        site.unserve("http://shop.test/")
