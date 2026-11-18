// Wraps Query.prototype.add and start (Zen 1.24.2b,
// gre/moz-src/browser/components/urlbar/UrlbarProvidersManager.sys.mjs:
// class Query :719, start() :754, add(provider, result) :914). Every
// provider's result goes through add() (:823-826), so one wrapper sees them
// all. The query's controller, which knows its window, is set in the
// constructor (:741) and nulled when start() ends (:806, :883), so the scope
// is captured when start() begins.
//
// installHook({ Query, captureScope, decideFor, onQueryDone }):
// - captureScope(query) -> scope, called once per query at start().
// - decideFor(query, provider, result, scope) -> boolean, or an object with a
//   boolean `keep`. A throw drops the result.
// - onQueryDone(query, { scope, decisions, errors }) after a query that was
//   not cancelled. `decisions` holds what decideFor returned.
// - widen: { Places, InputHistory }, the history provider classes, either
//   optional. See "Keeping lists full" below.
//
// Keeping lists full. Dropping another space's rows after the fact leaves
// the list short, because the history providers cap how many candidates they
// fetch from queryContext.maxResults (browser.urlbar.maxRichResults, 10;
// UrlbarInputBase.mjs:6180-6188):
// - UrlbarProviderPlaces reads it once, in the Search constructor that
//   startQuery runs synchronously (UrlbarProviderPlaces.sys.mjs:1538-1546,
//   :1626-1647), as #maxResults = maxResults * 1.5 (:486). That is the SQL
//   LIMIT (:71, :87, :1377, :1411), the row count that stops the scan (:850)
//   and the size of its internal groups (:1093-1097, :1180).
// - UrlbarProviderInputHistory (adaptive history) reads it after an await, in
//   _getAdaptiveQuery (:245-260), as its SQL LIMIT.
// The muxer then shows up to queryContext.maxResults rows
// (UrlbarMuxerStandard.sys.mjs:105), out of whatever add() let through. So
// for a scoped query these providers fetch WIDEN_FACTOR times more
// candidates (at most WIDEN_MAX) and the muxer, untouched, still cuts the
// list at the usual length: the active space's own pages fill the rows the
// other spaces' pages left. Nothing waits on the database: the providers
// were already querying asynchronously, only their LIMIT grows. Rejected:
// raising maxRichResults (a pref, and it lengthens the list too), or
// re-querying after a short list (a second round trip and a list that grows
// while the user reads it).
const WIDEN_FACTOR = 10;
const WIDEN_MAX = 100;

export function installHook({
  Query,
  captureScope = () => null,
  decideFor,
  onQueryDone,
  widen = {},
}) {
  const proto = Query.prototype;
  const originalAdd = proto.add;
  const originalStart = proto.start;
  if (typeof originalAdd !== "function" || typeof originalStart !== "function") {
    throw new Error("Query.prototype.add or start is missing");
  }
  const perQuery = new WeakMap();
  let installed = true;

  function stateFor(query) {
    let state = perQuery.get(query);
    if (!state) {
      let scope;
      try {
        scope = captureScope(query);
      } catch (e) {
        scope = { error: `scope capture failed: ${e}` };
      }
      state = { scope, decisions: [], errors: [] };
      perQuery.set(query, state);
    }
    return state;
  }

  function add(provider, result) {
    if (!installed || this.canceled) {
      return originalAdd.apply(this, arguments);
    }
    const state = stateFor(this);
    let keep = false;
    try {
      const verdict = decideFor(this, provider, result, state.scope);
      keep = typeof verdict === "object" && verdict !== null ? !!verdict.keep : !!verdict;
      state.decisions.push(verdict);
    } catch (e) {
      state.errors.push(String(e));
    }
    if (!keep) {
      // add() does this first thing (:924); a dropped heuristic result must
      // not leave the view waiting for its provider.
      this.context?.pendingHeuristicProviders?.delete(provider?.name);
      return undefined;
    }
    return originalAdd.apply(this, arguments);
  }

  function start() {
    if (installed) {
      stateFor(this);
    }
    const promise = originalStart.apply(this, arguments);
    if (installed && onQueryDone) {
      promise
        .then(() => {
          const state = perQuery.get(this);
          if (installed && state && !this.canceled) {
            onQueryDone(this, state);
          }
        })
        .catch(() => {});
    }
    return promise;
  }

  // The widened candidate count for the query a provider is running
  // (UrlbarProvidersManager.sys.mjs:770 sets provider.queryInstance), or null
  // to leave it alone. A query without a scope keeps only allowlisted kinds,
  // so its history would be dropped anyway.
  function widenedFor(query, maxResults) {
    const state = installed ? perQuery.get(query) : undefined;
    if (!state || !state.scope || state.scope.error || !Number.isInteger(maxResults)) {
      return null;
    }
    const n = Math.min(maxResults * WIDEN_FACTOR, WIDEN_MAX);
    return n > maxResults ? n : null;
  }

  const restores = [];
  const widened = [];
  function wrap(Provider, method, makeWrapper) {
    const target = Provider?.prototype;
    const original = target?.[method];
    if (typeof original !== "function") {
      return;
    }
    const wrapper = makeWrapper(original);
    target[method] = wrapper;
    widened.push(Provider.name);
    restores.push(() => {
      if (target[method] === wrapper) {
        target[method] = original;
      }
    });
  }

  // Search reads maxResults synchronously inside startQuery, so the context
  // holds the widened value only for that call and other providers never
  // see it.
  wrap(widen.Places, "startQuery", original =>
    function startQuery(queryContext) {
      const n = widenedFor(this.queryInstance, queryContext?.maxResults);
      if (n === null) {
        return original.apply(this, arguments);
      }
      const saved = queryContext.maxResults;
      queryContext.maxResults = n;
      try {
        return original.apply(this, arguments);
      } finally {
        queryContext.maxResults = saved;
      }
    }
  );
  wrap(widen.InputHistory, "_getAdaptiveQuery", original =>
    function _getAdaptiveQuery() {
      const out = original.apply(this, arguments);
      const params = Array.isArray(out) ? out[1] : null;
      const n = widenedFor(this.queryInstance, params?.maxResults);
      return n === null ? out : [out[0], { ...params, maxResults: n }, ...out.slice(2)];
    }
  );

  proto.add = add;
  proto.start = start;

  return {
    widened,
    // Whether Query's add and start are still these wrappers (self-check).
    isInstalled() {
      return installed && proto.add === add && proto.start === start;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      for (const restore of restores) {
        restore();
      }
      // Put back only what is still ours; if something wrapped on top of us,
      // our wrappers stay as pass-throughs.
      if (proto.add === add) {
        proto.add = originalAdd;
      }
      if (proto.start === start) {
        proto.start = originalStart;
      }
    },
  };
}
