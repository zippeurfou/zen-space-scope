import test from "node:test";
import assert from "node:assert/strict";
import { installHook } from "../../src/glue/hook.sys.mjs";

// Shaped like Query in UrlbarProvidersManager.sys.mjs:719-930: start() runs
// the providers, which call add(); the controller is nulled at the end.
function makeQuery() {
  class Query {
    constructor(controller, provide) {
      this.controller = controller;
      this.provide = provide;
      this.canceled = false;
      this.added = [];
      this.context = { searchString: "x", pendingHeuristicProviders: new Set(["Heur"]) };
    }
    async start() {
      await Promise.resolve();
      for (const [provider, result] of this.provide) {
        this.add(provider, result);
      }
      this.controller = null;
    }
    add(provider, result) {
      this.context.pendingHeuristicProviders.delete(provider.name);
      this.added.push(result);
    }
  }
  return Query;
}

test("drops what decideFor rejects and keeps the rest", async () => {
  const Query = makeQuery();
  const hook = installHook({
    Query,
    decideFor: (q, p, r) => r.keep,
  });
  const q = new Query({}, [[{ name: "A" }, { keep: true }], [{ name: "B" }, { keep: false }]]);
  await q.start();
  assert.deepEqual(q.added, [{ keep: true }]);
  hook.uninstall();
});

test("a dropped heuristic result no longer holds the view", async () => {
  const Query = makeQuery();
  const hook = installHook({ Query, decideFor: () => false });
  const q = new Query({}, [[{ name: "Heur" }, {}]]);
  await q.start();
  assert.deepEqual(q.added, []);
  assert.equal(q.context.pendingHeuristicProviders.size, 0);
  hook.uninstall();
});

test("the scope is captured once, at start, while the controller is set", async () => {
  const Query = makeQuery();
  const seen = [];
  const hook = installHook({
    Query,
    captureScope: q => ({ win: q.controller?.win ?? null }),
    decideFor: (q, p, r, scope) => {
      seen.push(scope);
      return true;
    },
  });
  const q = new Query({ win: "A" }, [[{ name: "A" }, {}], [{ name: "B" }, {}]]);
  await q.start();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { win: "A" });
  assert.equal(seen[0], seen[1]);
  hook.uninstall();
});

test("a throwing decideFor drops the result and reports the error", async () => {
  const Query = makeQuery();
  let done;
  const hook = installHook({
    Query,
    decideFor: () => {
      throw new Error("boom");
    },
    onQueryDone: (q, stats) => (done = stats),
  });
  const q = new Query({}, [[{ name: "A" }, {}]]);
  await q.start();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(q.added, []);
  assert.match(done.errors[0], /boom/);
  hook.uninstall();
});

test("onQueryDone gets the decisions, and is skipped for cancelled queries", async () => {
  const Query = makeQuery();
  const done = [];
  const hook = installHook({
    Query,
    decideFor: () => ({ keep: true, kind: "SEARCH" }),
    onQueryDone: (q, stats) => done.push(stats.decisions),
  });
  const q = new Query({}, [[{ name: "A" }, {}]]);
  await q.start();
  const cancelled = new Query({}, []);
  const p = cancelled.start();
  cancelled.canceled = true;
  await p;
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(done, [[{ keep: true, kind: "SEARCH" }]]);
  hook.uninstall();
});

test("uninstall restores the originals and later queries pass through", async () => {
  const Query = makeQuery();
  const { add, start } = Query.prototype;
  const hook = installHook({ Query, decideFor: () => false });
  assert.notEqual(Query.prototype.add, add);
  hook.uninstall();
  assert.equal(Query.prototype.add, add);
  assert.equal(Query.prototype.start, start);
  const q = new Query({}, [[{ name: "A" }, {}]]);
  await q.start();
  assert.equal(q.added.length, 1);
});

test("uninstall leaves a wrapper installed on top alone, and ours passes through", async () => {
  const Query = makeQuery();
  const { add } = Query.prototype;
  const hook = installHook({ Query, decideFor: () => false });
  const ours = Query.prototype.add;
  const theirs = function (...args) {
    return ours.apply(this, args);
  };
  Query.prototype.add = theirs;
  hook.uninstall();
  assert.equal(Query.prototype.add, theirs);
  const q = new Query({}, [[{ name: "A" }, {}]]);
  await q.start();
  assert.equal(q.added.length, 1, "our wrapper keeps everything once uninstalled");
  assert.notEqual(Query.prototype.add, add);
});

// Shaped like UrlbarProviderPlaces (UrlbarProviderPlaces.sys.mjs:486, :1538):
// startQuery reads maxResults synchronously; and UrlbarProviderInputHistory
// (UrlbarProviderInputHistory.sys.mjs:245-260): _getAdaptiveQuery returns
// [sql, params] with maxResults as the LIMIT.
function makeProviders() {
  class UrlbarProviderPlaces {
    startQuery(queryContext) {
      this.seen = queryContext.maxResults;
      return "started";
    }
  }
  class UrlbarProviderInputHistory {
    _getAdaptiveQuery(queryContext) {
      return ["SQL", { maxResults: queryContext.maxResults, other: 1 }];
    }
  }
  return { Places: UrlbarProviderPlaces, InputHistory: UrlbarProviderInputHistory };
}

async function runWith(scope, widen) {
  const Query = makeQuery();
  const hook = installHook({ Query, captureScope: () => scope, decideFor: () => true, widen });
  const q = new Query({}, []);
  const started = q.start();
  const places = new widen.Places();
  const input = new widen.InputHistory();
  places.queryInstance = input.queryInstance = q;
  const context = { maxResults: 10 };
  const ret = places.startQuery(context);
  const [, params] = input._getAdaptiveQuery(context);
  await started;
  return { hook, places, context, params, ret };
}

test("a scoped query asks the history providers for more candidates", async () => {
  const widen = makeProviders();
  const { hook, places, context, params, ret } = await runWith({ ucid: 1 }, widen);
  assert.equal(places.seen, 100);
  assert.equal(ret, "started");
  assert.equal(context.maxResults, 10, "the shared context is restored");
  assert.deepEqual(params, { maxResults: 100, other: 1 });
  assert.deepEqual(hook.widened, ["UrlbarProviderPlaces", "UrlbarProviderInputHistory"]);
  hook.uninstall();
});

test("a query without a scope, or another query, is not widened", async () => {
  const widen = makeProviders();
  const { hook, places, params } = await runWith({ error: "no space" }, widen);
  assert.equal(places.seen, 10);
  assert.equal(params.maxResults, 10);
  const other = new widen.Places();
  other.queryInstance = {};
  other.startQuery({ maxResults: 10 });
  assert.equal(other.seen, 10);
  hook.uninstall();
});

test("uninstall restores the providers' methods", async () => {
  const widen = makeProviders();
  const { startQuery } = widen.Places.prototype;
  const { _getAdaptiveQuery } = widen.InputHistory.prototype;
  const { hook } = await runWith({ ucid: 1 }, widen);
  hook.uninstall();
  assert.equal(widen.Places.prototype.startQuery, startQuery);
  assert.equal(widen.InputHistory.prototype._getAdaptiveQuery, _getAdaptiveQuery);
});

test("missing providers are skipped", () => {
  const Query = makeQuery();
  const hook = installHook({ Query, decideFor: () => true, widen: { Places: undefined } });
  assert.deepEqual(hook.widened, []);
  hook.uninstall();
});

test("isInstalled() is true only while both wrappers are Query's methods", () => {
  const Query = makeQuery();
  const hook = installHook({ Query, decideFor: () => true });
  assert.equal(hook.isInstalled(), true);
  const ours = Query.prototype.add;
  Query.prototype.add = function () {};
  assert.equal(hook.isInstalled(), false);
  Query.prototype.add = ours;
  assert.equal(hook.isInstalled(), true);
  hook.uninstall();
  assert.equal(hook.isInstalled(), false);
});
