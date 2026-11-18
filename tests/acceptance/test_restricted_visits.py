"""Visits that Firefox does not store must not feed suggestions.

Firefox 160's history flooding prevention (History::VisitURI,
toolkit/components/places/History.cpp:2066-2082): once the latest user input
is more than 3 s old, the 4th visit of one host within 5 s is "restricted".
Firefox does not store it, and NotifyOriginRestrictedVisit (:1492-1497)
announces it with a `page-visited` event built from a bare VisitData, so
container 0 and visit id 0 whatever the tab's container. Defaults:
modules/libpref/init/StaticPrefList.yaml:18007-18031.

Real browsing hits this: sign-in redirect chains, pages that change their
address as you scroll, apps that route on a timer.
"""

import time

from test_scoping import two_spaces
from zen import urls

# Places stops restricting a host for 3 s after a user input
# (places.history.floodingPrevention.maxSecondsFromLastUserInteraction).
QUIET = 3.5

# Visits `urls` one after the other, each in a new tab of container `ucid`,
# closed once Places has announced the visit. Returns every `page-visited`
# event of those URLs and the visits stored in the database.
VISITS = """
const [urls, ucid] = args;
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs");
const events = [];
const listener = evs => {
  for (const e of evs) {
    if (e.type == "page-visited" && urls.includes(e.url)) {
      events.push({ url: e.url, ucid: e.userContextId ?? null, visitId: e.visitId });
    }
  }
};
PlacesObservers.addListener(["page-visited"], listener);
const t0 = Date.now();
try {
  for (const url of urls) {
    const before = events.length;
    const tab = win.gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      userContextId: ucid,
    });
    await waitFor(() => events.length > before, "Places to announce " + url);
    await waitFor(() => tab.linkedBrowser.currentURI.spec == url, "the tab on " + url);
    win.gBrowser.removeTab(tab, { animate: false });
  }
} finally {
  PlacesObservers.removeListener(["page-visited"], listener);
}
const elapsed = Date.now() - t0;
// Let Places commit and the add-on's listener run.
await new Promise(r => win.setTimeout(r, 300));
return { events, elapsed, stored: await storedVisits(PlacesUtils, urls) };
"""

STORED = """
async function storedVisits(PlacesUtils, urls) {
  const db = await PlacesUtils.promiseDBConnection();
  const rows = await db.execute(
    `SELECT h.url AS url, v.userContextId AS ucid
     FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id ORDER BY v.id`);
  return rows.map(r => [r.getResultByName("url"), r.getResultByName("ucid")])
             .filter(([url]) => urls.includes(url));
}
"""


def visits(zen, page_urls, ucid):
    return zen.chrome(STORED + VISITS, page_urls, ucid)


def quiet_after_input(zen):
    """A user input, then long enough without one for Firefox to restrict
    a host again."""
    zen.user_input()
    time.sleep(QUIET)


def test_firefox_reports_container_0_for_a_restricted_visit(zen, site):
    """Pins the Firefox behavior the add-on relies on: the 4th quick visit
    of a host is not stored, and its event says container 0 and visit id 0
    although the tab is in a container. Stored visits have a visit id."""
    zen.make_space("Work", None)
    zen.make_space("Perso", "Perso")
    ucid = zen.container_id("Perso")
    quiet_after_input(zen)
    pages = [site.url("shop.test", f"p{i}") for i in range(6)]
    got = visits(zen, pages, ucid)
    assert got["elapsed"] < 5000, f"setup: the visits took over 5 s: {got}"
    by_url = {e["url"]: (e["ucid"], e["visitId"]) for e in got["events"]}
    stored = [by_url[u] for u in pages[:3]]
    assert all(c == ucid and v > 0 for c, v in stored), got
    assert [by_url[u] for u in pages[3:]] == [(0, 0)] * 3, got
    assert got["stored"] == [[u, ucid] for u in pages[:3]], got


def test_restricted_visit_does_not_leak_into_the_space_without_a_container(
    zen, site, addon
):
    """Perso alone visits shop.test, and Firefox restricts one of its
    visits. Work, the space without a container, shows nothing of shop.test:
    no top site, no history row, no autofill. Perso keeps its page, title
    included, without a restart."""
    work, perso = two_spaces(zen)
    ucid = zen.container_id("Perso")
    private = site.url("shop.test", "private")
    own = site.url("wiki.test", "a")
    visits(zen, [own, own], 0)
    zen.switch_space(perso)
    quiet_after_input(zen)
    got = visits(zen, [private] * 4, ucid)
    assert got["stored"] == [[private, ucid]] * 3, f"setup: {got}"
    assert (0, 0) in [(e["ucid"], e["visitId"]) for e in got["events"]], f"setup: {got}"
    top = zen.refresh_top_sites()
    assert private in top and own in top, f"setup: not top sites yet: {top}"

    zen.switch_space(work)
    leaks = {}
    for text in ("", "private", "shop.test/pri"):
        rows = zen.query(text)
        # The typed address itself is not a leak.
        hit = [
            r
            for r in rows
            if r["url"] == private
            and r["provider"] != "UrlbarProviderHeuristicFallback"
        ]
        if hit:
            leaks[text] = hit
    assert not leaks, f"Perso's page shows in Work: {leaks}"
    assert own in urls(zen.query("")), "positive control: Work lost its own top site"

    zen.switch_space(perso)
    for text in ("", "private"):
        rows = zen.query(text)
        assert (private, "shop.test private") in [
            (r["url"], r["title"]) for r in rows
        ], f"Perso lost its own page or its title for {text!r}: {rows}"


def test_top_site_of_a_shared_host_keeps_its_title_after_a_restricted_visit(
    zen, site, addon
):
    """Both spaces use shop.test, and Firefox restricts Perso's last visit
    of its page. The restricted visit must not add container 0 to the page,
    or Perso's own top site loses its title."""
    work, perso = two_spaces(zen)
    ucid = zen.container_id("Perso")
    private, public = site.url("shop.test", "private"), site.url("shop.test", "public")
    own = site.url("wiki.test", "a")
    quiet_after_input(zen)
    visits(zen, [public, own, own], 0)
    zen.switch_space(perso)
    got = visits(zen, [private] * 3, ucid)
    assert (0, 0) in [(e["ucid"], e["visitId"]) for e in got["events"]], f"setup: {got}"
    top = zen.refresh_top_sites()
    assert private in top and own in top and public not in top, f"setup: {top}"

    rows = zen.query("")
    assert (private, "shop.test private") in [(r["url"], r["title"]) for r in rows], (
        f"Perso lost its own top site or its title: {rows}\n{got}"
    )
    zen.switch_space(work)
    assert private not in urls(zen.query("")), "Perso's page is in Work's empty bar"


APP = """<!doctype html><html><head><meta charset='utf-8'><title>app</title></head>
<body><script>
// A web app that updates its own address with no click: a slideshow, a
// scroll spy, a live page.
const steps = ["/app/s1", "/app/s2", "/app/s3", "/app/inbox", "/app/s4"];
setTimeout(() => {
  let i = 0;
  const timer = setInterval(() => {
    history.pushState({}, "", steps[i++]);
    document.title = "app step " + i;
    if (i == steps.length) clearInterval(timer);
  }, 150);
}, %d);
</script></body></html>"""

# Opens `app` in container `ucid` right after a click, as following a link
# does, and waits until the page has changed its address 5 times.
OPEN_APP = """
const [app, ucid] = args;
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs");
const events = [];
const listener = evs => {
  for (const e of evs) {
    if (e.type == "page-visited") {
      events.push({ url: e.url, ucid: e.userContextId ?? null, visitId: e.visitId });
    }
  }
};
PlacesObservers.addListener(["page-visited"], listener);
let tab;
try {
  tab = win.gBrowser.addTab(app, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    userContextId: ucid,
  });
  win.gBrowser.selectedTab = tab;
  await waitFor(() => events.some(e => e.url.endsWith("/app/s4")),
                "the page to change its address 5 times");
} finally {
  PlacesObservers.removeListener(["page-visited"], listener);
  if (tab) win.gBrowser.removeTab(tab, { animate: false });
}
await new Promise(r => win.setTimeout(r, 300));
return { events, stored: await storedVisits(PlacesUtils, events.map(e => e.url)) };
"""


def test_page_that_changes_its_own_address_does_not_leak(zen, site, addon):
    """No tab trick: Perso opened docs.test/app/inbox once, a normal stored
    visit. Later a page of that site, open in Perso, changes its own address
    a few times (pushState) with no click. Firefox restricts the 4th change,
    which lands on /app/inbox, and announces it as container 0."""
    work, perso = two_spaces(zen)
    ucid = zen.container_id("Perso")
    app, inbox = site.url("docs.test", "app"), site.url("docs.test", "app/inbox")
    site.serve(app, (APP % int(QUIET * 1000)).encode(), "text/html; charset=utf-8")
    try:
        zen.switch_space(perso)
        zen.visit(inbox)
        zen.close_tab(inbox)
        zen.user_input()  # the click that opens the app
        got = zen.chrome(STORED + OPEN_APP, app, ucid, timeout=20)
    finally:
        site.unserve(app)
    assert [inbox, 0] not in got["stored"], f"setup: Work visited the inbox: {got}"
    assert {"url": inbox, "ucid": 0, "visitId": 0} in got["events"], f"setup: {got}"

    zen.switch_space(work)
    rows = zen.query("inbox")
    assert inbox not in urls(rows), f"Perso's page shows in Work: {rows}"
    zen.switch_space(perso)
    rows = zen.query("inbox")
    assert inbox in urls(rows), f"positive control: Perso lost its page: {rows}"


def test_a_stored_container_visit_reaches_the_index_live(zen, site, addon):
    """Positive control for the filter: with flooding prevention live, a
    normal visit in a container is suggested right away in its space, with
    its title, and not in the other one."""
    work, perso = two_spaces(zen)
    page = site.url("zillow.test", "a")
    quiet_after_input(zen)
    zen.switch_space(perso)
    zen.visit(page)
    zen.close_tab(page)

    rows = zen.query("zillow")
    assert (page, "zillow.test a") in [(r["url"], r["title"]) for r in rows], (
        f"Perso does not see its new visit live: {rows}"
    )
    zen.switch_space(work)
    rows = zen.query("zillow")
    assert page not in urls(rows), f"Perso's new visit shows in Work: {rows}"
