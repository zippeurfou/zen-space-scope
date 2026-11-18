"""Each kind of address-bar suggestion stays in the space whose container it
came from. Every "nothing leaks" check comes with a positive control on the
same setup, so a filter that dropped everything would fail."""

import json

from zen import hosts, urls, wait_out_visit_window


def two_spaces(zen):
    """Work (no container) and Perso (container "Perso"); Work is active."""
    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")
    zen.switch_space(work)
    return work, perso


def visit_closed(zen, url, container=None):
    """Visit `url` in the active space, then close its tab."""
    zen.visit(url, container)
    zen.close_tab(url)


def test_autofill_exact_page(zen, site, addon):
    work, perso = two_spaces(zen)
    page_a, secret = site.url("lemonde.test", "a"), site.url("lemonde.test", "secret")
    visit_closed(zen, page_a)
    zen.switch_space(perso)
    visit_closed(zen, secret)

    zen.switch_space(work)
    rows = zen.query("lemonde.test/se")
    assert secret not in urls(rows), f"Work autofills or suggests Perso's page: {rows}"
    # By provider: the typed address alone would also carry this URL.
    rows = zen.query("lemonde.test/a")
    autofill = [r for r in rows if r["provider"] == "UrlbarProviderAutofill"]
    assert [r["url"] for r in autofill] == [page_a], f"Work lost its autofill: {rows}"

    zen.switch_space(perso)
    rows = zen.query("lemonde.test/se")
    autofill = [r for r in rows if r["provider"] == "UrlbarProviderAutofill"]
    assert [r["url"] for r in autofill] == [secret], f"Perso lost its autofill: {rows}"


def test_autofill_next_slash(zen, site, addon):
    """Firefox autofills up to the next slash, so the autofilled URL is a
    prefix of the visited one (UrlbarProviderAutofill.sys.mjs:996-1018)."""
    work, perso = two_spaces(zen)
    visit_closed(zen, site.url("wiki.test", "foo/bar"))
    zen.switch_space(perso)
    visit_closed(zen, site.url("lemonde.test", "foo/bar"))

    zen.switch_space(work)
    rows = zen.query("wiki.test/f")
    autofill = [r["url"] for r in rows if r["provider"] == "UrlbarProviderAutofill"]
    assert autofill == ["http://wiki.test/foo/"], f"Work lost its own autofill: {rows}"
    rows = zen.query("lemonde.test/f")
    # Only the typed address itself (HeuristicFallback) may name the host.
    leaked = [u for u in urls(rows) if u.startswith("http://lemonde.test/foo")]
    assert not leaked, f"Perso's page autofills or shows in Work: {rows}"

    zen.switch_space(perso)
    rows = zen.query("lemonde.test/f")
    autofill = [r["url"] for r in rows if r["provider"] == "UrlbarProviderAutofill"]
    assert autofill == ["http://lemonde.test/foo/"], (
        f"Perso lost its own autofill: {rows}"
    )


def test_top_sites_scoped(zen, site, addon):
    work, perso = two_spaces(zen)
    wiki, zillow = site.url("wiki.test", "a"), site.url("zillow.test", "a")
    zen.visit(wiki)
    visit_closed(zen, wiki)
    zen.switch_space(perso)
    zen.visit(zillow)
    visit_closed(zen, zillow)
    top = zen.refresh_top_sites()
    assert wiki in top and zillow in top, f"setup: not top sites yet: {top}"

    rows = zen.query("")
    assert "zillow.test" in hosts(rows), f"Perso lost its top site: {rows}"
    assert "wiki.test" not in hosts(rows), f"Work's top site leaks into Perso: {rows}"

    zen.switch_space(work)
    rows = zen.query("")
    assert "wiki.test" in hosts(rows), f"Work lost its top site: {rows}"
    assert "zillow.test" not in hosts(rows), f"Perso's top site leaks into Work: {rows}"


def test_top_site_of_a_shared_host_stays_in_its_space(zen, site, addon):
    """A top site is the most frecent page of its host
    (NewTabUtils.sys.mjs:1026-1081), and its row carries that page's URL and
    title (UrlbarProviderTopSites.sys.mjs:172-181). When both spaces use a
    host, Perso's page must not show in Work's empty bar (ruling R36)."""
    work, perso = two_spaces(zen)
    private, public = site.url("shop.test", "private"), site.url("shop.test", "public")
    own = site.url("wiki.test", "a")
    visit_closed(zen, public)
    visit_closed(zen, own)
    visit_closed(zen, own)
    wait_out_visit_window()  # 4 visits of shop.test
    zen.switch_space(perso)
    for _ in range(3):
        visit_closed(zen, private)
    top = zen.refresh_top_sites()
    assert private in top and own in top and public not in top, (
        f"setup: Perso's page is not the host's top site: {top}"
    )

    rows = zen.query("")
    assert (private, "shop.test private") in [(r["url"], r["title"]) for r in rows], (
        f"Perso lost its own top site or its title: {rows}"
    )

    zen.switch_space(work)
    rows = zen.query("")
    assert private not in urls(rows), f"Perso's page is in Work's empty bar: {rows}"
    assert not [r for r in rows if "private" in (r["title"] or "")], (
        f"Perso's page title is in Work's empty bar: {rows}"
    )
    # Positive control: a page Work owns is still a top site in Work.
    assert (own, "wiki.test a") in [(r["url"], r["title"]) for r in rows], (
        f"Work lost its own top site or its title: {rows}"
    )


def test_switch_tab_scoped(zen, site, addon):
    work, perso = two_spaces(zen)
    zillow, wiki = site.url("zillow.test", "a"), site.url("wiki.test", "a")
    zen.visit(wiki)
    zen.switch_space(perso)
    zen.visit(zillow)

    rows = zen.query("zillow")
    assert zillow in urls(rows, type="TAB_SWITCH"), f"Perso lost its open tab: {rows}"

    zen.switch_space(work)
    rows = zen.query("zillow")
    assert not urls(rows, type="TAB_SWITCH"), (
        f"Perso's open tab leaks into Work: {rows}"
    )
    assert "zillow.test" not in hosts(rows), f"Perso's page leaks into Work: {rows}"
    rows = zen.query("wiki")
    assert wiki in urls(rows, type="TAB_SWITCH"), f"Work lost its open tab: {rows}"


def test_two_windows(zen, site, addon):
    """Each window's query uses its own active space, not the most recent
    window's."""
    work, perso = two_spaces(zen)
    lemonde, wiki = site.url("lemonde.test", "a"), site.url("wiki.test", "a")
    visit_closed(zen, wiki)
    zen.switch_space(perso)
    visit_closed(zen, lemonde)
    zen.switch_space(work)

    window_a = zen.window
    window_b = zen.open_window()
    zen.switch_space(perso)
    zen.use_window(window_a)
    assert zen.active_space()["uuid"] == work, "window A no longer shows Work"
    zen.use_window(window_b)
    assert zen.active_space()["uuid"] == perso, "window B does not show Perso"

    for focused, other in ((window_b, window_a), (window_a, window_b)):
        zen.use_window(focused, focus=True)
        # Query the window that is NOT the most recent one first.
        zen.use_window(other)
        most_recent = zen.chrome(
            'return Services.wm.getMostRecentWindow("navigator:browser") == win'
        )
        assert not most_recent, (
            "precondition: the queried window is not the most recent"
        )
        for window in (other, focused):
            zen.use_window(window)
            in_work = window == window_a
            rows = zen.query("lemonde")
            assert (lemonde in urls(rows)) == (not in_work), (
                f"window {'A (Work)' if in_work else 'B (Perso)'}, lemonde: {rows}"
            )
            rows = zen.query("wiki")
            assert (wiki in urls(rows)) == in_work, (
                f"window {'A (Work)' if in_work else 'B (Perso)'}, wiki: {rows}"
            )


def test_history_cleared(zen, site, addon):
    """The index forgets cleared history and removed pages, and learns the
    visits that come after."""
    work, perso = two_spaces(zen)
    lemonde, zillow = site.url("lemonde.test", "a"), site.url("zillow.test", "a")

    visit_closed(zen, lemonde)
    assert lemonde in urls(zen.query("lemonde")), "Work lost its own page"
    zen.chrome(
        """
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs");
        await PlacesUtils.history.clear();
        """
    )
    zen.switch_space(perso)
    visit_closed(zen, lemonde)
    assert lemonde in urls(zen.query("lemonde")), "Perso does not see its new visit"
    zen.switch_space(work)
    rows = zen.query("lemonde")
    assert "lemonde.test" not in hosts(rows), f"Work still sees a cleared visit: {rows}"

    visit_closed(zen, zillow)
    assert zillow in urls(zen.query("zillow")), "Work lost its own page"
    zen.chrome(
        """
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs");
        await PlacesUtils.history.remove(args[0]);
        """,
        zillow,
    )
    zen.switch_space(perso)
    visit_closed(zen, zillow)
    assert zillow in urls(zen.query("zillow")), "Perso does not see its new visit"
    zen.switch_space(work)
    rows = zen.query("zillow")
    assert "zillow.test" not in hosts(rows), f"Work still sees a removed page: {rows}"


def test_tab_container_not_space(zen, site, addon):
    """A container-0 tab opened inside Perso counts for Work, the space
    without a container."""
    work, perso = two_spaces(zen)
    docs = site.url("docs.test", "a")
    zen.switch_space(perso)
    visit_closed(zen, docs, container=0)

    rows = zen.query("docs")
    assert "docs.test" not in hosts(rows), f"a container-0 visit shows in Perso: {rows}"
    zen.switch_space(work)
    rows = zen.query("docs")
    assert docs in urls(rows), f"Work does not see its container's visit: {rows}"


def test_no_unknown_kinds(zen, site, addon):
    """Everyday queries produce only result kinds the rules know."""
    assert addon is not None, "the add-on is not built"
    work, perso = two_spaces(zen)
    visit_closed(zen, site.url("wiki.test", "a"))
    zen.switch_space(perso)
    visit_closed(zen, site.url("lemonde.test", "a"))
    zen.switch_space(work)
    alias = zen.chrome(
        """
        const { UrlbarSearchUtils } = ChromeUtils.importESModule(
          "moz-src:///browser/components/urlbar/UrlbarSearchUtils.sys.mjs");
        const engines = await UrlbarSearchUtils.tokenAliasEngines();
        return engines.length ? engines[0].tokenAliases[0] : null;
        """
    )
    assert alias, "no search engine has an alias"

    zen.addon_call(addon, "setDebug", True)
    queries = [
        "",
        "wiki",
        "lemonde",
        "wiki.test",
        "http://wiki.test/a",
        "2+2",
        "@",
        # An alias followed by a space enters search mode, which restarts
        # the query under another search string, so type the alias alone.
        alias,
        "about:con",
    ]
    rows_by_query = {text: zen.query(text) for text in queries}
    log = zen.addon_call(addon, "getLog")

    assert "about:config" in urls(rows_by_query["about:con"]), (
        f"the about:config suggestion is gone: {rows_by_query['about:con']}"
    )

    for text in queries:
        assert any(line.startswith(f"query {json.dumps(text)} ") for line in log), (
            f"no log entry for query {text!r}: {log}"
        )
    assert any(" keep HISTORY " in line for line in log), f"no history row kept: {log}"
    assert any(" keep ABOUT_PAGE " in line for line in log), (
        f"no about page kept: {log}"
    )
    assert any(" drop HISTORY " in line for line in log), (
        f"no history row dropped: {log}"
    )
    unknown = [line for line in log if "UNKNOWN" in line]
    assert not unknown, "result kinds the rules do not know:\n" + "\n".join(unknown)
    errors = [line for line in log if line.startswith("error:")]
    assert not errors, "the add-on logged errors:\n" + "\n".join(errors)


def test_uninstall_restores_the_address_bar(zen, site, addon):
    """Removing the add-on puts Firefox's own Query methods back and leaves
    history-based suggestions off (fail closed), so nothing unscoped shows."""
    assert addon is not None, "the add-on is not built"
    work, perso = two_spaces(zen)
    lemonde, wiki = site.url("lemonde.test", "a"), site.url("wiki.test", "a")
    zen.switch_space(perso)
    visit_closed(zen, lemonde)
    zen.switch_space(work)
    visit_closed(zen, wiki)
    assert "lemonde.test" not in hosts(zen.query("lemonde")), "precondition: scoped"
    assert wiki in urls(zen.query("wiki")), "positive control: Work lost its own page"

    restored = zen.chrome(
        """
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs");
        await (await AddonManager.getAddonByID(args[0])).uninstall();
        const { Query } = ChromeUtils.importESModule(
          "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");
        // Firefox's own methods, not wrappers (UrlbarProvidersManager.sys.mjs:754,914).
        return String(Query.prototype.add).includes("Invalid provider passed to the add callback")
            && String(Query.prototype.start).includes("This Query has been started already");
        """,
        addon,
    )
    assert restored, "Query.prototype.add/start are not Firefox's own after uninstall"
    for text in ("lemonde", "wiki"):
        rows = zen.query(text)
        assert not [r for r in rows if r["source"] == "HISTORY"], (
            f"history rows after uninstall: {rows}"
        )
