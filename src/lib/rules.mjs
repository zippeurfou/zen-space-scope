// Pure decision layer: no Firefox APIs. Provider names, RESULT_TYPE keys and
// RESULT_SOURCE keys come from Zen 1.24.2b (read-only extraction, layout
// {browser,gre}/). Paths below are relative to it:
//   U = gre/moz-src/browser/components/urlbar
//   S = browser/chrome/browser/content/browser/urlbar/UrlbarShared.mjs
//   Z = browser/modules
// A provider's name is its class name (U/UrlbarUtils.sys.mjs:1971).

export const KIND = Object.freeze({
  // Allowlist: passes without a container check.
  SEARCH: "SEARCH",
  TYPED_URL: "TYPED_URL",
  CALCULATOR: "CALCULATOR",
  UNIT_CONVERSION: "UNIT_CONVERSION",
  ZEN_ACTION: "ZEN_ACTION",
  RESTRICT_KEYWORD: "RESTRICT_KEYWORD",
  ABOUT_PAGE: "ABOUT_PAGE",
  // Checked against containers.
  HISTORY: "HISTORY",
  ADAPTIVE: "ADAPTIVE",
  AUTOFILL_ORIGIN: "AUTOFILL_ORIGIN",
  AUTOFILL_URL: "AUTOFILL_URL",
  TOP_SITE: "TOP_SITE",
  SWITCH_TAB: "SWITCH_TAB",
  BOOKMARK: "BOOKMARK",
  // Always dropped.
  RECENT_SEARCH: "RECENT_SEARCH",
  FORM_HISTORY: "FORM_HISTORY",
  REMOTE_TAB: "REMOTE_TAB",
  UNKNOWN: "UNKNOWN",
});

const ALLOWLIST = new Set([
  KIND.SEARCH,
  KIND.TYPED_URL,
  KIND.CALCULATOR,
  KIND.UNIT_CONVERSION,
  KIND.ZEN_ACTION,
  KIND.RESTRICT_KEYWORD,
  KIND.ABOUT_PAGE,
]);

// Providers whose URL results are history/bookmark rows told apart by source.
// U/UrlbarProviderPlaces.sys.mjs:381-383,417 (BOOKMARKS vs HISTORY, type URL),
// U/UrlbarProviderSemanticHistorySearch.sys.mjs:148-149 (URL/HISTORY).
const PLACES_LIKE = new Set([
  "UrlbarProviderPlaces",
  "UrlbarProviderSemanticHistorySearch",
]);

// Providers that emit TAB_SWITCH/TABS:
// U/UrlbarProviderOpenTabs.sys.mjs:314-315, UrlbarProviderPlaces.sys.mjs:342-343,
// UrlbarProviderInputHistory.sys.mjs:144-145, UrlbarProviderTopSites.sys.mjs:244-245,
// UrlbarProviderSemanticHistorySearch.sys.mjs:202-203, Z/ZenUBSidebarProvider.sys.mjs:96-97
// (name at :26-27).
const TAB_PROVIDERS = new Set([
  "UrlbarProviderOpenTabs",
  "UrlbarProviderPlaces",
  "UrlbarProviderInputHistory",
  "UrlbarProviderTopSites",
  "UrlbarProviderSemanticHistorySearch",
  "ZenUrlbarProviderSidebar",
]);

// Engine-backed search rows have type SEARCH and source SEARCH
// (UrlbarProviderSearchSuggestions.sys.mjs:541-542,
// UrlbarProviderTokenAliasEngines.sys.mjs:128-129,
// UrlbarProviderTabToSearch.sys.mjs:362-363). The heuristic search row from
// UrlbarProviderHeuristicFallback.sys.mjs:299-301 uses source OTHER_LOCAL.
// Local search history rows use source HISTORY:
// RecentSearches :153-154, SearchSuggestions form history :700-701,
// Places "searchengine" action rows :322-323.

const isAboutUrl = (url) => typeof url === "string" && url.startsWith("about:");

export function classify(d) {
  const { provider, type, source, autofillType } = d;

  switch (provider) {
    // U/UrlbarProviderCalculator.sys.mjs:124-125 (DYNAMIC/OTHER_LOCAL)
    case "UrlbarProviderCalculator":
      return KIND.CALCULATOR;
    // U/UrlbarProviderUnitConversion.sys.mjs:135-136 (DYNAMIC/OTHER_LOCAL)
    case "UrlbarProviderUnitConversion":
      return KIND.UNIT_CONVERSION;
    // Z/ZenUBActionsProvider.sys.mjs:144 (name), :402-405 (DYNAMIC with
    // source ZEN_ACTIONS or WORKSPACES; keys in S:251-262, WORKSPACES at :261).
    case "ZenUrlbarProviderGlobalActions":
      return source === "ZEN_ACTIONS" || source === "WORKSPACES"
        ? KIND.ZEN_ACTION
        : KIND.UNKNOWN;
    // U/UrlbarProviderRecentSearches.sys.mjs:153-154 (SEARCH/HISTORY)
    case "UrlbarProviderRecentSearches":
      return KIND.RECENT_SEARCH;
    // U/UrlbarProviderRemoteTabs.sys.mjs; type REMOTE_TAB (S:230)
    case "UrlbarProviderRemoteTabs":
      return KIND.REMOTE_TAB;
    // U/UrlbarProviderAutofill.sys.mjs:984 ("origin"), :1018 ("url"),
    // :1026-1027 (adaptive_origin / adaptive_url), :1152 ("about", a static
    // about: page). The non-heuristic origin row that accompanies adaptive
    // autofill (payload.isAutofillFallback, :1280-1293) is a URL autofill.
    case "UrlbarProviderAutofill":
      if (autofillType === "origin" || autofillType === "adaptive_origin") {
        return KIND.AUTOFILL_ORIGIN;
      }
      if (autofillType === "url" || autofillType === "adaptive_url") {
        return KIND.AUTOFILL_URL;
      }
      if (autofillType === "about") {
        return isAboutUrl(d.url) ? KIND.ABOUT_PAGE : KIND.UNKNOWN;
      }
      if (!d.heuristic && d.autofillFallback === true && type === "URL" && source === "HISTORY") {
        return KIND.AUTOFILL_URL;
      }
      return KIND.UNKNOWN;
    // U/UrlbarProviderAboutPages.sys.mjs:52-56 (URL/OTHER_LOCAL): Firefox's own
    // about: pages, no user data.
    case "UrlbarProviderAboutPages":
      return type === "URL" && source === "OTHER_LOCAL" && isAboutUrl(d.url)
        ? KIND.ABOUT_PAGE
        : KIND.UNKNOWN;
    // U/UrlbarProviderTopSites.sys.mjs:315 (URL; source HISTORY, BOOKMARKS
    // or OTHER_LOCAL per :286-302)
    case "UrlbarProviderTopSites":
      if (type === "URL") {
        return KIND.TOP_SITE;
      }
      break;
    // U/UrlbarProviderInputHistory.sys.mjs:167-170,185 (URL; BOOKMARKS or HISTORY)
    case "UrlbarProviderInputHistory":
      if (type === "URL") {
        return source === "BOOKMARKS" ? KIND.BOOKMARK : source === "HISTORY" ? KIND.ADAPTIVE : KIND.UNKNOWN;
      }
      break;
    // U/UrlbarProviderHistoryUrlHeuristic.sys.mjs:115-117 (URL/HISTORY,
    // heuristic): a history row, so it gets HISTORY's exact-url check.
    case "UrlbarProviderHistoryUrlHeuristic":
      return type === "URL" && source === "HISTORY" && d.heuristic
        ? KIND.HISTORY
        : KIND.UNKNOWN;
    // U/UrlbarProviderAliasEngines.sys.mjs:78-80 (SEARCH/SEARCH, heuristic)
    case "UrlbarProviderAliasEngines":
      return type === "SEARCH" && source === "SEARCH"
        ? KIND.SEARCH
        : KIND.UNKNOWN;
    // U/UrlbarProviderBookmarkKeywords.sys.mjs:92-94 (KEYWORD/BOOKMARKS, heuristic)
    case "UrlbarProviderBookmarkKeywords":
      return type === "KEYWORD" && source === "BOOKMARKS"
        ? KIND.BOOKMARK
        : KIND.UNKNOWN;
    // U/UrlbarProviderRestrictKeywords.sys.mjs:73-74,
    // U/UrlbarProviderRestrictKeywordsAutofill.sys.mjs:145-147,189-190
    // (RESTRICT/OTHER_LOCAL): static labels such as @history.
    case "UrlbarProviderRestrictKeywords":
    case "UrlbarProviderRestrictKeywordsAutofill":
      return type === "RESTRICT" && source === "OTHER_LOCAL"
        ? KIND.RESTRICT_KEYWORD
        : KIND.UNKNOWN;
    // U/UrlbarProviderHeuristicFallback.sys.mjs:180-182,242-244 (URL/OTHER_LOCAL,
    // heuristic) and :299-301,345-347 (SEARCH).
    case "UrlbarProviderHeuristicFallback":
      if (type === "URL" && source === "OTHER_LOCAL" && d.heuristic) {
        return KIND.TYPED_URL;
      }
      if (type === "SEARCH" && (source === "OTHER_LOCAL" || source === "SEARCH")) {
        return KIND.SEARCH;
      }
      return KIND.UNKNOWN;
    default:
      break;
  }

  if (type === "TAB_SWITCH" && source === "TABS" && TAB_PROVIDERS.has(provider)) {
    return KIND.SWITCH_TAB;
  }
  if (PLACES_LIKE.has(provider) && type === "URL") {
    if (source === "BOOKMARKS") {
      return KIND.BOOKMARK;
    }
    if (source === "HISTORY") {
      return KIND.HISTORY;
    }
  }
  if (type === "SEARCH") {
    if (
      source === "SEARCH" &&
      (provider === "UrlbarProviderSearchSuggestions" ||
        provider === "UrlbarProviderTokenAliasEngines" ||
        provider === "UrlbarProviderTabToSearch" ||
        provider === "UrlbarProviderTopSites")
    ) {
      return KIND.SEARCH;
    }
    // Local search history (form history) from Places and SearchSuggestions.
    if (
      source === "HISTORY" &&
      (provider === "UrlbarProviderSearchSuggestions" || provider === "UrlbarProviderPlaces")
    ) {
      return KIND.FORM_HISTORY;
    }
  }
  return KIND.UNKNOWN;
}

// The policy for a bookmark in no space (Zen leaves new bookmarks in none,
// editBookmark.js:1386), kept apart so it can change on its own (ruling R20):
// kept where its url was visited, and a never-visited one only in the space
// without a container, like container-0 history. `ctx` is decide()'s.
// Returns { keep, reason }.
export function unassignedBookmark(d, ctx) {
  const containers = ctx.index.urlContainers(d.url);
  if (containers?.size) {
    return containers.has(ctx.ucid)
      ? { keep: true, reason: "unassigned bookmark visited in this container" }
      : { keep: false, reason: "unassigned bookmark visited only in other containers" };
  }
  return ctx.ucid === 0
    ? { keep: true, reason: "unassigned bookmark never visited, kept in the space without a container" }
    : {
        keep: false,
        reason: "unassigned bookmark never visited, only the space without a container shows it",
      };
}

// Kinds whose title comes from Places, which stores one title per url for
// every container (ruling R24): Places rows (UrlbarProviderPlaces.sys.mjs:1192-1213),
// input history (UrlbarProviderInputHistory.sys.mjs:121-148), autofill
// (UrlbarProviderAutofill.sys.mjs:944) and top sites (UrlbarProviderTopSites.sys.mjs:180).
const PLACES_TITLED = new Set([
  KIND.HISTORY,
  KIND.ADAPTIVE,
  KIND.AUTOFILL_ORIGIN,
  KIND.AUTOFILL_URL,
  KIND.TOP_SITE,
  KIND.BOOKMARK,
]);

// "keep" when a row of this kind may show its title in container `ucid`,
// "blank" otherwise (ruling R36). A Places title is kept only when the
// containers that visited the title's source are exactly `ucid`:
// - the row's exact url for most kinds. A kept row is not enough: a URL
//   autofill is kept for a page under it (R38) and a bookmark for its space
//   assignment, while the title is the page's, whoever opened it.
// - the whole origin for AUTOFILL_ORIGIN, whose title is the root page's in
//   any of its http, https and www variants
//   (UrlbarProviderAutofill.sys.mjs:225-246), not always the row's url.
// A bookmark row shows its bookmark's own title when it has one, and the page
// title otherwise (UrlbarProviderPlaces.sys.mjs:1194-1213,
// UrlbarProviderInputHistory.sys.mjs:122-125,177): ruling R26 keeps the row's
// `title` when it is one of the url's non-empty `bookmarkTitles`.
// An autofill row shows the title of any bookmark of its title's source,
// whatever its space (ruling R43): see autofillBookmarkTitle.
export function titlePolicy(
  kind,
  url,
  index,
  { ucid, title, bookmarkTitles, titleBookmarks } = {}
) {
  if (!PLACES_TITLED.has(kind)) {
    return "keep";
  }
  if (kind === KIND.BOOKMARK && title && bookmarkTitles?.has(title)) {
    return "keep";
  }
  if (kind === KIND.AUTOFILL_URL || kind === KIND.AUTOFILL_ORIGIN) {
    const verdict = autofillBookmarkTitle(title, titleBookmarks);
    if (verdict) {
      return verdict;
    }
  }
  if (typeof url !== "string") {
    return "blank";
  }
  const containers =
    kind === KIND.AUTOFILL_ORIGIN ? index.originContainers(url) : index.urlContainers(url);
  return containers?.size === 1 && containers.has(ucid) ? "keep" : "blank";
}

// With bookmarks on, an autofill row's title is ifnull(b.title, page title),
// b being any bookmark of the url the title comes from
// (UrlbarProviderAutofill.sys.mjs:164-172 origin rows, :259-261 url rows,
// :857-860 adaptive rows). `titleBookmarks` holds, for each url of
// titleBookmarkUrls, `{ titles, visible }`: its bookmarks' non-empty titles
// and whether they pass R20/R21 in the active space; null when the bookmark
// titles are not known (not read yet, or the read failed). Returns "keep"
// when `title` is the title of a bookmark this space shows, "blank" when it
// is only the title of bookmarks it hides, or when the titles are not known,
// and null when it is no bookmark's title, so R36 decides (ruling R43).
export function autofillBookmarkTitle(title, titleBookmarks = []) {
  if (!title) {
    return null;
  }
  if (titleBookmarks === null) {
    return "blank";
  }
  const sources = titleBookmarks.filter(s => s.titles?.has(title));
  if (!sources.length) {
    return null;
  }
  return sources.some(s => s.visible) ? "keep" : "blank";
}

// The urls whose bookmark titles an autofill row of `kind` can show: its own
// url, and for an origin row the root page in its http, https and www
// variants, any of which supplies the title (UrlbarProviderAutofill.sys.mjs:
// 225-246, matched_place). Other kinds: none.
export function titleBookmarkUrls(kind, url) {
  if (typeof url !== "string" || (kind !== KIND.AUTOFILL_URL && kind !== KIND.AUTOFILL_ORIGIN)) {
    return [];
  }
  if (kind === KIND.AUTOFILL_URL) {
    return [url];
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return [url];
  }
  const host = parsed.host.startsWith("www.") ? parsed.host.slice(4) : parsed.host;
  const urls = [];
  for (const scheme of ["https://", "http://"]) {
    for (const prefix of ["", "www."]) {
      urls.push(`${scheme}${prefix}${host}/`);
    }
  }
  return urls;
}

// Whether a bookmarked url's bookmarks show in the active space (R20, R21).
// `ctx` is decide()'s.
export function bookmarkVisible(url, ctx) {
  return bookmarkVerdict({ url }, ctx).keep;
}

// The verdict for a bookmarked url (rulings R20, R21): a url bookmarked more
// than once is judged over all its bookmarks. Returns { keep, reason }.
function bookmarkVerdict(d, ctx) {
  const { spaces, unassigned } = ctx.bookmarkSpaces(d.url);
  if (spaces.has(ctx.spaceId)) {
    return { keep: true, reason: "bookmark assigned to this space" };
  }
  if (unassigned) {
    return unassignedBookmark(d, ctx);
  }
  return { keep: false, reason: "bookmark assigned to other spaces" };
}

// ctx: { ucid, spaceId, index: ContainerIndex, bookmarkSpaces(url) ->
// { spaces: ReadonlySet<string>, unassigned: boolean } }, where `spaces` is
// the union of the spaces the url's bookmarks are assigned to and
// `unassigned` says whether one of its bookmarks is in no space.
export function decide(d, ctx) {
  const kind = classify(d);
  const { ucid, index } = ctx;
  const drop = (reason) => ({ keep: false, kind, reason });
  const keep = (reason) => ({ keep: true, kind, reason });

  if (ALLOWLIST.has(kind)) {
    return keep("safe kind, not tied to history");
  }

  switch (kind) {
    case KIND.HISTORY:
    case KIND.ADAPTIVE: {
      if (!d.url) {
        return drop("no url to check");
      }
      return index.urlContainers(d.url)?.has(ucid)
        ? keep("url visited in this container")
        : drop("url not visited in this container");
    }
    // Autofill completes "to the next slash" (UrlbarProviderAutofill.sys.mjs:
    // 996-1018), so the autofilled url is a visited one, or ends in "/" and
    // is the start of a visited one (ruling R38).
    case KIND.AUTOFILL_URL: {
      if (!d.url) {
        return drop("no url to check");
      }
      return index.urlPrefixContainers(d.url).has(ucid)
        ? keep("it, or a url under it, was visited in this container")
        : drop("neither it nor a url under it was visited in this container");
    }
    case KIND.AUTOFILL_ORIGIN: {
      if (!d.url) {
        return drop("no url to check");
      }
      return index.originContainers(d.url)?.has(ucid)
        ? keep("origin visited in this container")
        : drop("origin not visited in this container");
    }
    // A top site is the most frecent page of its host
    // (gre/modules/NewTabUtils.sys.mjs:1026-1081) and the row carries that
    // page's url and title (UrlbarProviderTopSites.sys.mjs:172-181), so it is
    // judged as that page, not as its origin (ruling R36). A bookmarked one
    // (source BOOKMARKS, :286-302) follows the bookmark rules.
    case KIND.TOP_SITE: {
      if (!d.url) {
        return drop("no url to check");
      }
      if (d.source === "BOOKMARKS") {
        return { kind, ...bookmarkVerdict(d, ctx) };
      }
      return index.urlContainers(d.url)?.has(ucid)
        ? keep("url visited in this container")
        : drop("url not visited in this container");
    }
    case KIND.SWITCH_TAB:
      return d.tabContainer === ucid
        ? keep("tab is in this container")
        : drop("tab is in another container");
    case KIND.BOOKMARK: {
      if (!d.url) {
        return drop("no url to check");
      }
      return { kind, ...bookmarkVerdict(d, ctx) };
    }
    case KIND.RECENT_SEARCH:
      return drop("recent searches are not scoped to a container");
    case KIND.FORM_HISTORY:
      return drop("form history is not scoped to a container");
    case KIND.REMOTE_TAB:
      return drop("synced tabs are not scoped to a container");
    default:
      return drop("unknown result kind");
  }
}
