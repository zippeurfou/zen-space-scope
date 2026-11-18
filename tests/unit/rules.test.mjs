import test from "node:test";
import assert from "node:assert/strict";
import { ContainerIndex } from "../../src/lib/index.mjs";
import {
  KIND,
  bookmarkVisible,
  classify,
  decide,
  titleBookmarkUrls,
  titlePolicy,
  unassignedBookmark,
} from "../../src/lib/rules.mjs";

const desc = (o) => ({
  provider: "",
  type: "URL",
  source: "HISTORY",
  heuristic: false,
  autofillType: null,
  url: null,
  tabContainer: null,
  ...o,
});

const A = "https://www.example.com/a";
const B = "https://www.example.com/b";
const LEMONDE = "https://www.lemonde.fr/";

// bookmarkSpaces(url) answers { spaces, unassigned } (R21): the union of the
// spaces its bookmarks are assigned to, and whether one of them is in none.
const noSpace = () => ({ spaces: new Set(), unassigned: true });
const inSpaces = (...spaces) => () => ({ spaces: new Set(spaces), unassigned: false });
const mixed = (...spaces) => () => ({ spaces: new Set(spaces), unassigned: true });

function makeCtx(bookmarkSpaces = noSpace, ucid = 6, spaceId = "space-a") {
  const index = new ContainerIndex();
  index.addVisit(A, 6);
  index.addVisit(B, 2);
  index.addVisit("https://other.example.org/x", 6);
  index.addVisit(LEMONDE, 6);
  return { ucid, spaceId, index, bookmarkSpaces };
}

test("KIND is frozen and has every documented value", () => {
  assert.ok(Object.isFrozen(KIND));
  for (const k of [
    "SEARCH", "TYPED_URL", "CALCULATOR", "UNIT_CONVERSION", "ZEN_ACTION",
    "HISTORY", "ADAPTIVE", "AUTOFILL_ORIGIN", "AUTOFILL_URL", "TOP_SITE",
    "SWITCH_TAB", "BOOKMARK", "RECENT_SEARCH", "FORM_HISTORY", "REMOTE_TAB",
    "UNKNOWN", "RESTRICT_KEYWORD",
  ]) {
    assert.equal(typeof KIND[k], "string", k);
  }
});

const classifyRows = [
  ["engine suggestion", { provider: "UrlbarProviderSearchSuggestions", type: "SEARCH", source: "SEARCH" }, KIND.SEARCH],
  ["heuristic search", { provider: "UrlbarProviderHeuristicFallback", type: "SEARCH", source: "OTHER_LOCAL", heuristic: true }, KIND.SEARCH],
  ["token alias engine", { provider: "UrlbarProviderTokenAliasEngines", type: "SEARCH", source: "SEARCH" }, KIND.SEARCH],
  ["typed url", { provider: "UrlbarProviderHeuristicFallback", type: "URL", source: "OTHER_LOCAL", heuristic: true }, KIND.TYPED_URL],
  ["history url heuristic", { provider: "UrlbarProviderHistoryUrlHeuristic", type: "URL", source: "HISTORY", heuristic: true }, KIND.HISTORY],
  ["alias engine heuristic", { provider: "UrlbarProviderAliasEngines", type: "SEARCH", source: "SEARCH", heuristic: true }, KIND.SEARCH],
  ["bookmark keyword", { provider: "UrlbarProviderBookmarkKeywords", type: "KEYWORD", source: "BOOKMARKS", heuristic: true }, KIND.BOOKMARK],
  ["restrict keyword", { provider: "UrlbarProviderRestrictKeywords", type: "RESTRICT", source: "OTHER_LOCAL" }, KIND.RESTRICT_KEYWORD],
  ["restrict keyword autofill", { provider: "UrlbarProviderRestrictKeywordsAutofill", type: "RESTRICT", source: "OTHER_LOCAL", heuristic: true }, KIND.RESTRICT_KEYWORD],
  ["restrict type from another provider", { provider: "UrlbarProviderFutureThing", type: "RESTRICT", source: "OTHER_LOCAL" }, KIND.UNKNOWN],
  ["calculator", { provider: "UrlbarProviderCalculator", type: "DYNAMIC", source: "OTHER_LOCAL" }, KIND.CALCULATOR],
  ["unit conversion", { provider: "UrlbarProviderUnitConversion", type: "DYNAMIC", source: "OTHER_LOCAL" }, KIND.UNIT_CONVERSION],
  ["zen action", { provider: "ZenUrlbarProviderGlobalActions", type: "DYNAMIC", source: "ZEN_ACTIONS" }, KIND.ZEN_ACTION],
  ["zen workspace", { provider: "ZenUrlbarProviderGlobalActions", type: "DYNAMIC", source: "WORKSPACES" }, KIND.ZEN_ACTION],
  ["places history", { provider: "UrlbarProviderPlaces", type: "URL", source: "HISTORY" }, KIND.HISTORY],
  ["semantic history", { provider: "UrlbarProviderSemanticHistorySearch", type: "URL", source: "HISTORY" }, KIND.HISTORY],
  ["places bookmark", { provider: "UrlbarProviderPlaces", type: "URL", source: "BOOKMARKS" }, KIND.BOOKMARK],
  ["places tab switch", { provider: "UrlbarProviderPlaces", type: "TAB_SWITCH", source: "TABS" }, KIND.SWITCH_TAB],
  ["open tabs", { provider: "UrlbarProviderOpenTabs", type: "TAB_SWITCH", source: "TABS" }, KIND.SWITCH_TAB],
  ["zen sidebar tab switch", { provider: "ZenUrlbarProviderSidebar", type: "TAB_SWITCH", source: "TABS" }, KIND.SWITCH_TAB],
  ["input history", { provider: "UrlbarProviderInputHistory", type: "URL", source: "HISTORY" }, KIND.ADAPTIVE],
  ["input history bookmark", { provider: "UrlbarProviderInputHistory", type: "URL", source: "BOOKMARKS" }, KIND.BOOKMARK],
  ["autofill origin", { provider: "UrlbarProviderAutofill", type: "URL", source: "HISTORY", heuristic: true, autofillType: "origin" }, KIND.AUTOFILL_ORIGIN],
  ["autofill url", { provider: "UrlbarProviderAutofill", type: "URL", source: "HISTORY", heuristic: true, autofillType: "url" }, KIND.AUTOFILL_URL],
  ["autofill without type", { provider: "UrlbarProviderAutofill", type: "URL", source: "HISTORY", heuristic: true }, KIND.UNKNOWN],
  ["top site url", { provider: "UrlbarProviderTopSites", type: "URL", source: "OTHER_LOCAL" }, KIND.TOP_SITE],
  ["top site from history", { provider: "UrlbarProviderTopSites", type: "URL", source: "HISTORY" }, KIND.TOP_SITE],
  ["top site tab", { provider: "UrlbarProviderTopSites", type: "TAB_SWITCH", source: "TABS" }, KIND.SWITCH_TAB],
  ["recent search", { provider: "UrlbarProviderRecentSearches", type: "SEARCH", source: "HISTORY" }, KIND.RECENT_SEARCH],
  ["form history", { provider: "UrlbarProviderSearchSuggestions", type: "SEARCH", source: "HISTORY" }, KIND.FORM_HISTORY],
  ["places form history", { provider: "UrlbarProviderPlaces", type: "SEARCH", source: "HISTORY" }, KIND.FORM_HISTORY],
  ["remote tab", { provider: "UrlbarProviderRemoteTabs", type: "REMOTE_TAB", source: "OTHER_NETWORK" }, KIND.REMOTE_TAB],
  ["unseen provider", { provider: "UrlbarProviderFutureThing", type: "URL", source: "HISTORY" }, KIND.UNKNOWN],
  ["unseen provider, safe-looking type", { provider: "SomethingNew", type: "SEARCH", source: "SEARCH" }, KIND.UNKNOWN],
  ["quick suggest", { provider: "UrlbarProviderQuickSuggest", type: "URL", source: "SEARCH" }, KIND.UNKNOWN],
  ["history provider with an unseen type", { provider: "UrlbarProviderPlaces", type: "WHATEVER", source: "HISTORY" }, KIND.UNKNOWN],
];

for (const [name, fields, kind] of classifyRows) {
  test(`classify: ${name} -> ${kind}`, () => {
    assert.equal(classify(desc(fields)), kind);
  });
}

test("classify: UrlbarProviderRecentSearches maps to RECENT_SEARCH", () => {
  assert.equal(
    classify(desc({ provider: "UrlbarProviderRecentSearches", type: "SEARCH", source: "HISTORY" })),
    KIND.RECENT_SEARCH,
  );
});


// [kind, descriptor for a row that should be kept, descriptor for one dropped, ctx overrides]
const decideRows = [
  // allowlist: always kept, container never consulted
  ["SEARCH", { provider: "UrlbarProviderSearchSuggestions", type: "SEARCH", source: "SEARCH" }],
  ["TYPED_URL", { provider: "UrlbarProviderHeuristicFallback", type: "URL", source: "OTHER_LOCAL", heuristic: true, url: "https://never-visited.test/" }],
  ["CALCULATOR", { provider: "UrlbarProviderCalculator", type: "DYNAMIC", source: "OTHER_LOCAL" }],
  ["UNIT_CONVERSION", { provider: "UrlbarProviderUnitConversion", type: "DYNAMIC", source: "OTHER_LOCAL" }],
  ["RESTRICT_KEYWORD", { provider: "UrlbarProviderRestrictKeywords", type: "RESTRICT", source: "OTHER_LOCAL" }],
  ["SEARCH", { provider: "UrlbarProviderAliasEngines", type: "SEARCH", source: "SEARCH", heuristic: true }],
  ["ZEN_ACTION", { provider: "ZenUrlbarProviderGlobalActions", type: "DYNAMIC", source: "ZEN_ACTIONS" }],
];

for (const [kind, fields] of decideRows) {
  test(`decide: allowlisted ${kind} is kept`, () => {
    const r = decide(desc(fields), makeCtx());
    assert.equal(r.kind, KIND[kind]);
    assert.equal(r.keep, true);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
  });
}

test("decide: allowlisted kinds are kept even with a container nobody visited", () => {
  const r = decide(desc(decideRows[0][1]), makeCtx(noSpace, 99));
  assert.equal(r.keep, true);
});

const checked = [
  ["HISTORY", { provider: "UrlbarProviderPlaces", type: "URL", source: "HISTORY" }],
  ["ADAPTIVE", { provider: "UrlbarProviderInputHistory", type: "URL", source: "HISTORY" }],
];
for (const [kind, fields] of checked) {
  test(`decide: ${kind} kept when the url was visited in the container`, () => {
    const r = decide(desc({ ...fields, url: A }), makeCtx());
    assert.equal(r.kind, KIND[kind]);
    assert.equal(r.keep, true);
  });
  test(`decide: ${kind} dropped when the url was only visited elsewhere`, () => {
    const r = decide(desc({ ...fields, url: B }), makeCtx());
    assert.equal(r.keep, false);
  });
  test(`decide: ${kind} dropped when the url was never visited`, () => {
    assert.equal(decide(desc({ ...fields, url: "https://nope.test/" }), makeCtx()).keep, false);
  });
  test(`decide: ${kind} dropped when there is no url`, () => {
    assert.equal(decide(desc({ ...fields, url: null }), makeCtx()).keep, false);
  });
}

test("decide: HistoryUrlHeuristic row is checked by exact url", () => {
  const f = { provider: "UrlbarProviderHistoryUrlHeuristic", type: "URL", source: "HISTORY", heuristic: true };
  const same = decide(desc({ ...f, url: A }), makeCtx());
  assert.equal(same.kind, KIND.HISTORY);
  assert.equal(same.keep, true);
  assert.equal(decide(desc({ ...f, url: B }), makeCtx()).keep, false);
  assert.equal(decide(desc({ ...f, url: LEMONDE }), makeCtx(noSpace, 0)).keep, false);
});

test("decide: BookmarkKeywords row follows the bookmark rules", () => {
  const f = { provider: "UrlbarProviderBookmarkKeywords", type: "KEYWORD", source: "BOOKMARKS", heuristic: true, url: A };
  assert.equal(decide(desc(f), makeCtx(noSpace)).keep, true);
  assert.equal(decide(desc(f), makeCtx(inSpaces("space-a"))).keep, true);
  assert.equal(decide(desc(f), makeCtx(inSpaces("space-z"))).keep, false);
});

test("decide: AUTOFILL_ORIGIN is checked by origin", () => {
  const f = { provider: "UrlbarProviderAutofill", type: "URL", source: "HISTORY", heuristic: true, autofillType: "origin" };
  // A page on example.com was visited with 6, so the origin is allowed even for an unvisited path.
  const keep = decide(desc({ ...f, url: "https://www.example.com/" }), makeCtx());
  assert.equal(keep.kind, KIND.AUTOFILL_ORIGIN);
  assert.equal(keep.keep, true);
  const drop = decide(desc({ ...f, url: "https://www.example.com/" }), makeCtx(noSpace, 3));
  assert.equal(drop.keep, false);
  assert.equal(decide(desc({ ...f, url: "https://never.test/" }), makeCtx()).keep, false);
});

test("decide: AUTOFILL_URL is checked by the exact url, not the origin", () => {
  const f = { provider: "UrlbarProviderAutofill", type: "URL", source: "HISTORY", heuristic: true, autofillType: "url" };
  assert.equal(decide(desc({ ...f, url: A }), makeCtx()).keep, true);
  // origin example.com was visited with 6 (via A), but this exact url only with 2.
  const r = decide(desc({ ...f, url: B }), makeCtx());
  assert.equal(r.kind, KIND.AUTOFILL_URL);
  assert.equal(r.keep, false);
});

// R36: a top site is the most frecent page of its host, so the row is that
// page's, not the host's.
test("decide: TOP_SITE is checked by the exact url, not the origin", () => {
  const f = { provider: "UrlbarProviderTopSites", type: "URL", source: "HISTORY" };
  const kept = decide(desc({ ...f, url: A }), makeCtx());
  assert.equal(kept.kind, KIND.TOP_SITE);
  assert.equal(kept.keep, true);
  // example.com was visited with 6 (through A), but B only with 2.
  assert.equal(decide(desc({ ...f, url: B }), makeCtx()).keep, false);
  assert.equal(decide(desc({ ...f, url: "https://www.example.com/never-seen-path" }), makeCtx()).keep, false);
  assert.equal(decide(desc({ ...f, url: A }), makeCtx(noSpace, 3)).keep, false);
  assert.equal(decide(desc({ ...f, url: "https://never.test/" }), makeCtx()).keep, false);
  assert.equal(decide(desc({ ...f, url: null }), makeCtx()).keep, false);
  // The source Firefox falls back to with history suggestions off is judged the same.
  assert.equal(decide(desc({ ...f, source: "OTHER_LOCAL", url: A }), makeCtx()).keep, true);
  assert.equal(decide(desc({ ...f, source: "OTHER_LOCAL", url: B }), makeCtx()).keep, false);
});

// R36: a bookmarked top site (source BOOKMARKS,
// UrlbarProviderTopSites.sys.mjs:286-302) follows the bookmark rules R20/R21
// on its exact url.
for (const [name, bookmarkSpaces, url, ucid, keep] of [
  ["assigned to the active space", inSpaces("space-a"), B, 6, true],
  ["assigned only to another space, even when visited here", inSpaces("space-z"), A, 6, false],
  ["unassigned and visited here", noSpace, A, 6, true],
  ["unassigned and visited only elsewhere, on an origin visited here", noSpace, B, 6, false],
  ["unassigned and never visited, in the space without a container", noSpace, "https://never.test/", 0, true],
  ["unassigned and never visited, in a container space", noSpace, "https://never.test/", 6, false],
]) {
  test(`decide: bookmarked TOP_SITE ${name}`, () => {
    const f = { provider: "UrlbarProviderTopSites", type: "URL", source: "BOOKMARKS", url };
    const r = decide(desc(f), makeCtx(bookmarkSpaces, ucid));
    assert.equal(r.kind, KIND.TOP_SITE);
    assert.equal(r.keep, keep);
  });
}

test("decide: SWITCH_TAB is kept only for a tab in the active container", () => {
  const f = { provider: "UrlbarProviderOpenTabs", type: "TAB_SWITCH", source: "TABS", url: A };
  assert.equal(decide(desc({ ...f, tabContainer: 6 }), makeCtx()).keep, true);
  assert.equal(decide(desc({ ...f, tabContainer: 2 }), makeCtx()).keep, false);
  assert.equal(decide(desc({ ...f, tabContainer: null }), makeCtx()).keep, false);
  assert.equal(decide(desc({ ...f, tabContainer: 0 }), makeCtx(noSpace, 0)).keep, true);
});

test("decide: BOOKMARK kept when unassigned or assigned to the active space", () => {
  const f = { provider: "UrlbarProviderPlaces", type: "URL", source: "BOOKMARKS", url: A };
  const calls = [];
  const spy = (u) => { calls.push(u); return noSpace(); };
  const unassigned = decide(desc(f), makeCtx(spy));
  assert.equal(unassigned.kind, KIND.BOOKMARK);
  assert.equal(unassigned.keep, true);
  assert.deepEqual(calls, [A]);
  assert.equal(decide(desc(f), makeCtx(inSpaces("space-a", "space-z"))).keep, true);
  assert.equal(decide(desc(f), makeCtx(inSpaces("space-z"))).keep, false);
  assert.equal(decide(desc(f), makeCtx(inSpaces())).keep, false);
});

test("decide: BOOKMARK without a url is dropped", () => {
  const f = { provider: "UrlbarProviderPlaces", type: "URL", source: "BOOKMARKS", url: null };
  assert.equal(decide(desc(f), makeCtx()).keep, false);
});

const alwaysDropped = [
  ["RECENT_SEARCH", { provider: "UrlbarProviderRecentSearches", type: "SEARCH", source: "HISTORY" }],
  ["FORM_HISTORY", { provider: "UrlbarProviderSearchSuggestions", type: "SEARCH", source: "HISTORY" }],
  ["REMOTE_TAB", { provider: "UrlbarProviderRemoteTabs", type: "REMOTE_TAB", source: "OTHER_NETWORK", url: A }],
  ["UNKNOWN", { provider: "UrlbarProviderFutureThing", type: "URL", source: "HISTORY", url: A }],
];
for (const [kind, fields] of alwaysDropped) {
  test(`decide: ${kind} is always dropped`, () => {
    const r = decide(desc(fields), makeCtx());
    assert.equal(r.kind, KIND[kind]);
    assert.equal(r.keep, false);
    assert.ok(r.reason.length > 0);
  });
}

test("lemonde: a url visited only in container 6 is dropped for ucid 0 and kept for ucid 6", () => {
  const f = desc({ provider: "UrlbarProviderPlaces", type: "URL", source: "HISTORY", url: LEMONDE });
  assert.equal(decide(f, makeCtx(noSpace, 0)).keep, false);
  assert.equal(decide(f, makeCtx(noSpace, 6)).keep, true);
});

test("decide does not mutate the index", () => {
  const ctx = makeCtx();
  const before = [...ctx.index.urlContainers(A)];
  decide(desc({ provider: "UrlbarProviderPlaces", type: "URL", source: "HISTORY", url: A }), ctx);
  assert.deepEqual([...ctx.index.urlContainers(A)], before);
});

// R14: about: pages, adaptive autofill and the autofill fallback row.
const AF = { provider: "UrlbarProviderAutofill", type: "URL", source: "HISTORY" };
const r14Rows = [
  ["about page", { provider: "UrlbarProviderAboutPages", type: "URL", source: "OTHER_LOCAL", url: "about:config" }, KIND.ABOUT_PAGE],
  ["about page with a non-about url", { provider: "UrlbarProviderAboutPages", type: "URL", source: "OTHER_LOCAL", url: "http://a.test/" }, KIND.UNKNOWN],
  ["about pages, other type", { provider: "UrlbarProviderAboutPages", type: "SEARCH", source: "OTHER_LOCAL", url: "about:config" }, KIND.UNKNOWN],
  ["about autofill", { ...AF, heuristic: true, autofillType: "about", url: "about:config" }, KIND.ABOUT_PAGE],
  ["about autofill with a non-about url", { ...AF, heuristic: true, autofillType: "about", url: "http://a.test/" }, KIND.UNKNOWN],
  ["adaptive origin autofill", { ...AF, heuristic: true, autofillType: "adaptive_origin" }, KIND.AUTOFILL_ORIGIN],
  ["adaptive url autofill", { ...AF, heuristic: true, autofillType: "adaptive_url" }, KIND.AUTOFILL_URL],
  ["autofill fallback row", { ...AF, heuristic: false, autofillFallback: true }, KIND.AUTOFILL_URL],
  ["non-heuristic autofill row that is not the fallback", { ...AF, heuristic: false }, KIND.UNKNOWN],
];
for (const [name, fields, kind] of r14Rows) {
  test(`classify: ${name} -> ${kind}`, () => {
    assert.equal(classify(desc(fields)), kind);
  });
}

test("decide: ABOUT_PAGE is allowlisted", () => {
  const r = decide(desc(r14Rows[0][1]), makeCtx(noSpace, 99));
  assert.equal(r.kind, KIND.ABOUT_PAGE);
  assert.equal(r.keep, true);
});

test("decide: adaptive origin autofill is checked by origin", () => {
  const f = { ...AF, heuristic: true, autofillType: "adaptive_origin", url: "https://www.example.com/" };
  assert.equal(decide(desc(f), makeCtx()).keep, true);
  assert.equal(decide(desc(f), makeCtx(noSpace, 3)).keep, false);
});

// R15: Firefox autofills "to the next slash", so the autofilled url is a
// prefix of the visited one.
const NEXT = "https://www.example.com/foo/";
function prefixCtx(ucid) {
  const ctx = makeCtx(noSpace, ucid);
  ctx.index.addVisit("https://www.example.com/foo/bar", 6);
  ctx.index.addVisit("https://www.example.com/zed/bar", 2);
  return ctx;
}
for (const [name, fields] of [
  ["AUTOFILL_URL", { ...AF, heuristic: true, autofillType: "url" }],
  ["adaptive url", { ...AF, heuristic: true, autofillType: "adaptive_url" }],
  ["fallback row", { ...AF, heuristic: false, autofillFallback: true }],
]) {
  test(`decide: ${name} kept when a url visited in the container starts with it`, () => {
    const r = decide(desc({ ...fields, url: NEXT }), prefixCtx(6));
    assert.equal(r.kind, KIND.AUTOFILL_URL);
    assert.equal(r.keep, true);
  });
  test(`decide: ${name} dropped when only another container visited under it`, () => {
    assert.equal(decide(desc({ ...fields, url: NEXT }), prefixCtx(2)).keep, false);
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/zed/" }), prefixCtx(6)).keep, false);
  });
  test(`decide: ${name} dropped without a url`, () => {
    assert.equal(decide(desc({ ...fields, url: null }), prefixCtx(6)).keep, false);
  });
}

// R20: the policy for bookmarks in no space lives in one function so it can
// be swapped on its own. makeCtx's index: A visited in 6, B in 2, LEMONDE in 6;
// NEVER visited nowhere.
const NEVER = "https://never.example.net/";
const ZERO = "https://zero.example.net/";
for (const [name, url, ucid, keep, reason] of [
  ["(b) visited in the active container", A, 6, true, "unassigned bookmark visited in this container"],
  ["(b) visited in the active container 0", ZERO, 0, true, "unassigned bookmark visited in this container"],
  ["visited only in another container", B, 6, false, "unassigned bookmark visited only in other containers"],
  ["visited only in a container, active space has none", A, 0, false, "unassigned bookmark visited only in other containers"],
  ["visited only in container 0, active space has one", ZERO, 6, false, "unassigned bookmark visited only in other containers"],
  ["(c) never visited, active space has no container", NEVER, 0, true, "unassigned bookmark never visited, kept in the space without a container"],
  ["never visited, active space has a container", NEVER, 6, false, "unassigned bookmark never visited, only the space without a container shows it"],
]) {
  test(`unassignedBookmark: ${name}`, () => {
    const ctx = makeCtx(noSpace, ucid, "space-x");
    ctx.index.addVisit(ZERO, 0);
    const d = desc({ provider: "UrlbarProviderPlaces", source: "BOOKMARKS", url });
    assert.deepEqual(unassignedBookmark(d, ctx), { keep, reason });
    assert.deepEqual(decide(d, ctx), { kind: KIND.BOOKMARK, keep, reason });
  });
}

test("unassignedBookmark: a url whose visits were all removed counts as never visited", () => {
  const ctx = makeCtx(noSpace, 0, "space-x");
  ctx.index.addVisit(NEVER, 6);
  ctx.index.removeUrl(NEVER);
  const d = desc({ provider: "UrlbarProviderPlaces", source: "BOOKMARKS", url: NEVER });
  assert.equal(unassignedBookmark(d, ctx).keep, true);
});

for (const [name, spaces, keep] of [
  ["(a) assigned to the active space", new Set(["space-x", "space-y"]), true],
  ["assigned only to other spaces", new Set(["space-y"]), false],
  ["assigned to no space that exists (empty set)", new Set(), false],
]) {
  test(`decide: bookmark ${name}`, () => {
    // Visited in the active container, so only the assignment decides.
    const ctx = makeCtx(() => ({ spaces, unassigned: false }), 6, "space-x");
    const d = desc({ provider: "UrlbarProviderPlaces", source: "BOOKMARKS", url: A });
    assert.equal(decide(d, ctx).keep, keep);
  });
}

// R21: a url bookmarked more than once is judged over all its bookmarks.
for (const [name, bookmarkSpaces, url, ucid, keep] of [
  ["in Perso and in no space, never visited: shown in Perso", mixed("space-x"), "https://never.example.net/", 6, true],
  ["in Perso and in no space, never visited: hidden in a container space without it", mixed("space-y"), "https://never.example.net/", 6, false],
  ["in Perso and in no space, never visited: the no-space bookmark shows it in the space without a container", mixed("space-y"), "https://never.example.net/", 0, true],
  ["in Work and in no space, visited in Perso: shown in Perso by the unassigned rule", mixed("space-y"), A, 6, true],
  ["in Work and in no space, visited only in another container: hidden", mixed("space-y"), B, 6, false],
]) {
  test(`decide: bookmark ${name}`, () => {
    const ctx = makeCtx(bookmarkSpaces, ucid, "space-x");
    const d = desc({ provider: "UrlbarProviderPlaces", source: "BOOKMARKS", url });
    assert.equal(decide(d, ctx).keep, keep);
  });
}

// R36: Places keeps one title per url for every container, so a Places title
// is kept only when the containers of the title's source are exactly the
// active one.
const URL_TITLED = [KIND.HISTORY, KIND.ADAPTIVE, KIND.AUTOFILL_URL, KIND.TOP_SITE, KIND.BOOKMARK];
const ROOT = "https://www.example.com/";

test("titlePolicy: a url visited only in the active container keeps its title", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 6);
  index.addVisit(A, 6);
  for (const kind of URL_TITLED) {
    assert.equal(titlePolicy(kind, A, index, { ucid: 6 }), "keep", kind);
  }
});

test("titlePolicy: a url visited in the active container and another one is blanked", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 0);
  index.addVisit(A, 6);
  for (const kind of URL_TITLED) {
    assert.equal(titlePolicy(kind, A, index, { ucid: 6 }), "blank", kind);
    assert.equal(titlePolicy(kind, A, index, { ucid: 0 }), "blank", kind);
  }
});

test("titlePolicy: a url visited only in another container is blanked", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 2);
  for (const kind of URL_TITLED) {
    assert.equal(titlePolicy(kind, A, index, { ucid: 6 }), "blank", kind);
  }
});

test("titlePolicy: a url no container visited, or no url, is blanked", () => {
  const index = new ContainerIndex();
  index.addVisit("https://other.example.org/x", 6);
  for (const kind of [...URL_TITLED, KIND.AUTOFILL_ORIGIN]) {
    assert.equal(titlePolicy(kind, A, index, { ucid: 6 }), "blank", kind);
    assert.equal(titlePolicy(kind, null, index, { ucid: 6 }), "blank", kind);
  }
});

test("titlePolicy: without an active container every Places title is blanked", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 6);
  for (const kind of [...URL_TITLED, KIND.AUTOFILL_ORIGIN]) {
    assert.equal(titlePolicy(kind, A, index), "blank", kind);
    assert.equal(titlePolicy(kind, A, index, {}), "blank", kind);
  }
});

test("titlePolicy: container 0 is a container like any other", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 0);
  assert.equal(titlePolicy(KIND.HISTORY, A, index, { ucid: 0 }), "keep");
  assert.equal(titlePolicy(KIND.HISTORY, A, index, { ucid: 6 }), "blank");
});

// The origin row's title comes from the root page, in any of its http, https
// and www variants (UrlbarProviderAutofill.sys.mjs:225-246), which need not be
// the row's url.
test("titlePolicy: AUTOFILL_ORIGIN is judged over the whole origin", () => {
  const onlyHere = new ContainerIndex();
  onlyHere.addVisit("https://www.example.com/page", 6);
  onlyHere.addVisit("http://example.com/", 6);
  assert.equal(titlePolicy(KIND.AUTOFILL_ORIGIN, ROOT, onlyHere, { ucid: 6 }), "keep");

  // The root was visited only in container 2, another page only in 6: the
  // row is kept in 6 (decide), but its title is the root page's.
  const rootElsewhere = new ContainerIndex();
  rootElsewhere.addVisit(ROOT, 2);
  rootElsewhere.addVisit("https://www.example.com/page", 6);
  assert.equal(titlePolicy(KIND.AUTOFILL_ORIGIN, ROOT, rootElsewhere, { ucid: 6 }), "blank");
  assert.equal(titlePolicy(KIND.AUTOFILL_ORIGIN, ROOT, rootElsewhere, { ucid: 2 }), "blank");

  // A www or http variant of the root, visited in another container.
  const variantElsewhere = new ContainerIndex();
  variantElsewhere.addVisit(ROOT, 6);
  variantElsewhere.addVisit("http://example.com/", 2);
  assert.equal(titlePolicy(KIND.AUTOFILL_ORIGIN, ROOT, variantElsewhere, { ucid: 6 }), "blank");
});

test("titlePolicy: AUTOFILL_URL is judged on its exact url, not on what lies under it", () => {
  const index = new ContainerIndex();
  index.addVisit("https://www.example.com/dir/", 2);
  index.addVisit("https://www.example.com/dir/page", 6);
  // decide keeps the row in 6 (a url under it was visited there, R38), but
  // the title is the folder page's, which only 2 visited.
  assert.equal(titlePolicy(KIND.AUTOFILL_URL, "https://www.example.com/dir/", index, { ucid: 6 }), "blank");
  assert.equal(titlePolicy(KIND.AUTOFILL_URL, "https://www.example.com/dir/", index, { ucid: 2 }), "keep");
  assert.equal(titlePolicy(KIND.AUTOFILL_URL, "https://www.example.com/dir/page", index, { ucid: 6 }), "keep");
});

test("titlePolicy: TOP_SITE on a host the active container uses, for a page it never opened, is blanked", () => {
  const index = new ContainerIndex();
  index.addVisit("https://www.example.com/private", 2);
  index.addVisit("https://www.example.com/public", 6);
  assert.equal(titlePolicy(KIND.TOP_SITE, "https://www.example.com/private", index, { ucid: 6 }), "blank");
  assert.equal(titlePolicy(KIND.TOP_SITE, "https://www.example.com/public", index, { ucid: 6 }), "keep");
});

test("titlePolicy: kinds without a Places title keep theirs whatever the containers", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 0);
  index.addVisit(A, 6);
  for (const kind of [KIND.SWITCH_TAB, KIND.SEARCH, KIND.TYPED_URL, KIND.ABOUT_PAGE, KIND.UNKNOWN]) {
    assert.equal(titlePolicy(kind, A, index, { ucid: 6 }), "keep", kind);
    assert.equal(titlePolicy(kind, A, index), "keep", kind);
  }
});

// R26: a bookmark row's own title (moz_bookmarks.title) is per bookmark.
test("titlePolicy: a bookmark row showing one of its bookmark titles keeps it", () => {
  const bookmarkTitles = new Set(["My page"]);
  const shared = new ContainerIndex();
  shared.addVisit(A, 0);
  shared.addVisit(A, 6);
  assert.equal(titlePolicy(KIND.BOOKMARK, A, shared, { ucid: 6, title: "My page", bookmarkTitles }), "keep");
  // Also on a url only another container visited, or nobody did.
  const elsewhere = new ContainerIndex();
  elsewhere.addVisit(A, 2);
  assert.equal(titlePolicy(KIND.BOOKMARK, A, elsewhere, { ucid: 6, title: "My page", bookmarkTitles }), "keep");
  assert.equal(
    titlePolicy(KIND.BOOKMARK, A, new ContainerIndex(), { ucid: 0, title: "My page", bookmarkTitles }),
    "keep"
  );
});

test("titlePolicy: a bookmark row showing the page title (no title of its own) follows the url's containers", () => {
  const shared = new ContainerIndex();
  shared.addVisit(A, 0);
  shared.addVisit(A, 6);
  for (const bookmarkTitles of [new Set(), new Set(["Other"]), undefined]) {
    assert.equal(
      titlePolicy(KIND.BOOKMARK, A, shared, { ucid: 6, title: "Inbox - work", bookmarkTitles }),
      "blank"
    );
  }
  assert.equal(titlePolicy(KIND.BOOKMARK, A, shared, { ucid: 6, title: "", bookmarkTitles: new Set([""]) }), "blank");

  const own = new ContainerIndex();
  own.addVisit(A, 6);
  assert.equal(titlePolicy(KIND.BOOKMARK, A, own, { ucid: 6, title: "Inbox - work", bookmarkTitles: new Set() }), "keep");
  // Assigned to this space but visited only in another one: the page title is the other one's.
  assert.equal(titlePolicy(KIND.BOOKMARK, A, own, { ucid: 0, title: "Inbox - work", bookmarkTitles: new Set() }), "blank");
});

test("titlePolicy: a bookmark title does not keep the title of a row of another kind", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 0);
  index.addVisit(A, 6);
  const bookmarkTitles = new Set(["My page"]);
  for (const kind of [KIND.HISTORY, KIND.TOP_SITE, KIND.AUTOFILL_URL, KIND.AUTOFILL_ORIGIN]) {
    assert.equal(titlePolicy(kind, A, index, { ucid: 6, title: "My page", bookmarkTitles }), "blank", kind);
  }
});

// R38: an autofilled url is kept on an exact match, or under it when it ends
// in "/". A raw string prefix kept ".../doc" where only ".../docs/x" was visited.
function r38Ctx(ucid) {
  const index = new ContainerIndex();
  index.addVisit("https://www.example.com/doc", 6); // "Perso" only
  index.addVisit("https://www.example.com/docs/x", 0); // "Work" only
  index.addVisit("https://www.example.com/exact", 0);
  return { ucid, spaceId: "space-a", index, bookmarkSpaces: noSpace };
}
for (const [name, fields] of [
  ["AUTOFILL_URL", { ...AF, heuristic: true, autofillType: "url" }],
  ["adaptive url", { ...AF, heuristic: true, autofillType: "adaptive_url" }],
  ["fallback row", { ...AF, heuristic: false, autofillFallback: true }],
]) {
  test(`decide (R38): ${name} ".../doc" visited only elsewhere is dropped where ".../docs/x" was visited`, () => {
    const r = decide(desc({ ...fields, url: "https://www.example.com/doc" }), r38Ctx(0));
    assert.equal(r.kind, KIND.AUTOFILL_URL);
    assert.equal(r.keep, false);
    // Positive control: the container that visited ".../doc" keeps it.
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/doc" }), r38Ctx(6)).keep, true);
  });
  test(`decide (R38): ${name} ending in "/" is kept when a url under it was visited here`, () => {
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/docs/" }), r38Ctx(0)).keep, true);
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/" }), r38Ctx(0)).keep, true);
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/docs/" }), r38Ctx(6)).keep, false);
  });
  test(`decide (R38): ${name} on an exact match is kept`, () => {
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/exact" }), r38Ctx(0)).keep, true);
    assert.equal(decide(desc({ ...fields, url: "https://www.example.com/exact" }), r38Ctx(6)).keep, false);
  });
}

// R43: with bookmarks on, an autofill row's title is ifnull(b.title, ...), a
// title of any bookmark of the title's source url, whatever its space
// (UrlbarProviderAutofill.sys.mjs:164-172, :259-261, :857-860).
// `titleBookmarks` lists, per url the title can come from, its bookmark
// titles and whether its bookmarks pass R20/R21 in the active space.
const hidden = titles => ({ titles: new Set(titles), visible: false });
const shown = titles => ({ titles: new Set(titles), visible: true });
const AUTOFILLS = [KIND.AUTOFILL_URL, KIND.AUTOFILL_ORIGIN];

test("titlePolicy (R43): an autofill title from a bookmark hidden in this space is blanked", () => {
  const index = new ContainerIndex();
  index.addVisit(ROOT, 0); // the url was visited only here: R36 alone would keep it
  for (const kind of AUTOFILLS) {
    const about = { ucid: 0, title: "Perso label", titleBookmarks: [hidden(["Perso label"])] };
    assert.equal(titlePolicy(kind, ROOT, index, about), "blank", kind);
  }
});

test("titlePolicy (R43): an autofill title from a bookmark shown in this space is kept", () => {
  const index = new ContainerIndex();
  index.addVisit(ROOT, 0);
  for (const kind of AUTOFILLS) {
    const about = { ucid: 0, title: "Work label", titleBookmarks: [shown(["Work label"])] };
    assert.equal(titlePolicy(kind, ROOT, index, about), "keep", kind);
  }
  // Also on a url another container visited too: the space shows that bookmark anyway.
  index.addVisit(ROOT, 6);
  for (const kind of AUTOFILLS) {
    const about = { ucid: 0, title: "Work label", titleBookmarks: [shown(["Work label"])] };
    assert.equal(titlePolicy(kind, ROOT, index, about), "keep", kind);
  }
});

test("titlePolicy (R43): one shown bookmark with that title is enough", () => {
  const index = new ContainerIndex();
  index.addVisit(ROOT, 6);
  const about = {
    ucid: 0,
    title: "Shared label",
    titleBookmarks: [hidden(["Shared label"]), shown(["Shared label", "Other"])],
  };
  assert.equal(titlePolicy(KIND.AUTOFILL_ORIGIN, ROOT, index, about), "keep");
  about.titleBookmarks = [hidden(["Shared label"]), shown(["Other"])];
  assert.equal(titlePolicy(KIND.AUTOFILL_ORIGIN, ROOT, index, about), "blank");
});

test("titlePolicy (R43): an autofill title that is no bookmark's follows R36", () => {
  const only = new ContainerIndex();
  only.addVisit(ROOT, 0);
  const both = new ContainerIndex();
  both.addVisit(ROOT, 0);
  both.addVisit(ROOT, 6);
  for (const kind of AUTOFILLS) {
    for (const titleBookmarks of [[], [hidden(["Other"])], [shown(["Other"])]]) {
      const about = { ucid: 0, title: "Page title", titleBookmarks };
      assert.equal(titlePolicy(kind, ROOT, only, about), "keep", kind);
      assert.equal(titlePolicy(kind, ROOT, both, about), "blank", kind);
    }
  }
});

test("titlePolicy (R43): an autofill title is blanked while the bookmark titles are unknown", () => {
  const index = new ContainerIndex();
  index.addVisit(ROOT, 0);
  for (const kind of AUTOFILLS) {
    assert.equal(titlePolicy(kind, ROOT, index, { ucid: 0, title: "Any", titleBookmarks: null }), "blank", kind);
  }
});

test("titlePolicy (R43): bookmarks of the title's source do not change other kinds", () => {
  const index = new ContainerIndex();
  index.addVisit(A, 0);
  for (const kind of [KIND.HISTORY, KIND.ADAPTIVE, KIND.TOP_SITE]) {
    for (const titleBookmarks of [[hidden(["Label"])], null]) {
      assert.equal(titlePolicy(kind, A, index, { ucid: 0, title: "Label", titleBookmarks }), "keep", kind);
    }
  }
});

// Where an autofill row's title can come from: the url itself, or for an
// origin row the root page in its http, https and www variants
// (UrlbarProviderAutofill.sys.mjs:225-246, matched_place).
test("titleBookmarkUrls: an origin row's title comes from any root variant", () => {
  const variants = [
    "http://example.com/",
    "http://www.example.com/",
    "https://example.com/",
    "https://www.example.com/",
  ];
  assert.deepEqual(titleBookmarkUrls(KIND.AUTOFILL_ORIGIN, "https://www.example.com/").sort(), variants);
  assert.deepEqual(titleBookmarkUrls(KIND.AUTOFILL_ORIGIN, "http://example.com/").sort(), variants);
  assert.deepEqual(titleBookmarkUrls(KIND.AUTOFILL_ORIGIN, "http://shop.test:8080/").sort(), [
    "http://shop.test:8080/",
    "http://www.shop.test:8080/",
    "https://shop.test:8080/",
    "https://www.shop.test:8080/",
  ]);
});

test("titleBookmarkUrls: a url row's title comes from its own url, other kinds have none", () => {
  assert.deepEqual(titleBookmarkUrls(KIND.AUTOFILL_URL, A), [A]);
  assert.deepEqual(titleBookmarkUrls(KIND.AUTOFILL_ORIGIN, "not a url"), ["not a url"]);
  for (const kind of [KIND.HISTORY, KIND.BOOKMARK, KIND.TOP_SITE, KIND.SEARCH]) {
    assert.deepEqual(titleBookmarkUrls(kind, A), [], kind);
  }
  assert.deepEqual(titleBookmarkUrls(KIND.AUTOFILL_URL, null), []);
});

test("bookmarkVisible: the R20/R21 verdict for a bookmarked url", () => {
  assert.equal(bookmarkVisible(A, makeCtx(inSpaces("space-a"))), true);
  assert.equal(bookmarkVisible(A, makeCtx(inSpaces("space-b"))), false);
  // Unassigned: kept where the url was visited (A in container 6).
  assert.equal(bookmarkVisible(A, makeCtx(noSpace, 6)), true);
  assert.equal(bookmarkVisible(A, makeCtx(noSpace, 0)), false);
  assert.equal(bookmarkVisible(A, makeCtx(mixed("space-b"), 6)), true);
});
