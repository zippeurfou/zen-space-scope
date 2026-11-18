// Turns a provider and a UrlbarResult (Zen 1.24.2b,
// browser/chrome/browser/content/browser/urlbar/UrlbarResult.mjs) into the
// plain ResultDescriptor that src/lib/rules.mjs classifies.

const namesByTable = new WeakMap();

// RESULT_TYPE / RESULT_SOURCE value -> key name, or null if unknown
// (UrlbarShared.mjs:218-262).
function nameOf(table, value) {
  let names = namesByTable.get(table);
  if (!names) {
    names = new Map(Object.entries(table).map(([k, v]) => [v, k]));
    namesByTable.set(table, names);
  }
  return names.get(value) ?? null;
}

export function describe(provider, result, UrlbarShared) {
  const payload = result.payload ?? {};
  // The tab's container: payload.userContext.id (UrlbarUtils.sys.mjs:1308-1326,
  // set by every provider that emits TAB_SWITCH).
  const tabContainer = payload.userContext?.id;
  return {
    // A provider's name is its class name (UrlbarUtils.sys.mjs:1971).
    provider: provider?.name ?? result.providerName ?? "",
    type: nameOf(UrlbarShared.RESULT_TYPE, result.type),
    source: nameOf(UrlbarShared.RESULT_SOURCE, result.source),
    heuristic: !!result.heuristic,
    // "origin", "url", "adaptive_origin", "adaptive_url" or "about"
    // (UrlbarProviderAutofill.sys.mjs:984,1018,1026-1027,1152).
    autofillType: result.autofill?.type ?? null,
    // The origin row that accompanies adaptive autofill (:1280-1293).
    autofillFallback: payload.isAutofillFallback === true,
    url: typeof payload.url === "string" ? payload.url : null,
    tabContainer: typeof tabContainer === "number" ? tabContainer : null,
  };
}
