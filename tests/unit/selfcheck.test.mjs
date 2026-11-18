import test from "node:test";
import assert from "node:assert/strict";
import { installHook } from "../../src/glue/hook.sys.mjs";
import {
  CHECKS,
  CONFLICT_NOTICE,
  NOTICE,
  runSelfCheck,
  runSelfCheckOnEveryWindow,
  watchConflictNotice,
  watchNotices,
} from "../../src/glue/selfcheck.sys.mjs";

// UrlbarShared.mjs:218-262 (the values only need to be distinct here).
const UrlbarShared = {
  RESULT_TYPE: { URL: 1, SEARCH: 2 },
  RESULT_SOURCE: { HISTORY: 2, OTHER_LOCAL: 5 },
};

// Shaped like Query (UrlbarProvidersManager.sys.mjs:719, add :914): add()
// first rejects a provider that is not a UrlbarProvider, then reads
// this.canceled.
function makeQuery({ strict = true } = {}) {
  class Provider {}
  class Query {
    add(provider, result) {
      if (strict && !(provider instanceof Provider)) {
        throw new Error("Invalid provider passed to the add callback");
      }
      this.context.pendingHeuristicProviders.delete(provider.name);
      if (this.canceled) {
        return;
      }
      Query.added.push(result);
    }
    async start() {}
  }
  Query.added = [];
  return Query;
}

// Keeps the typed address, drops a history row: what the rules do for a
// url no container visited.
const filterLikeRules = (q, provider) => ({
  keep: provider.name === "UrlbarProviderHeuristicFallback",
});

function makeWin({ ucid = 0, initialized = Promise.resolve() } = {}) {
  return {
    gZenWorkspaces: {
      promiseInitialized: initialized,
      privateWindowOrDisabled: false,
      getActiveWorkspaceFromCache: () => ({ uuid: "work", name: "Work" }),
      getCurrentSpaceContainerId: () => ucid,
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
}

function makePlaces({ column = true, broken = false } = {}) {
  return {
    sql: [],
    async promiseDBConnection() {
      if (broken) {
        throw new Error("no database");
      }
      const self = this;
      return {
        async execute(sql) {
          self.sql.push(sql);
          if (/userContextId/.test(sql) && !column) {
            throw new Error("no such column: userContextId");
          }
          return [];
        },
      };
    },
  };
}

function setup({ decideFor = filterLikeRules, Query = makeQuery(), ...over } = {}) {
  const hook = installHook({
    Query,
    captureScope: q => ({ win: q.controller?.browserWindow ?? null }),
    decideFor,
  });
  const win = over.win ?? makeWin();
  return {
    hook,
    opts: {
      win,
      wins: [win],
      Query,
      PlacesUtils: makePlaces(),
      UrlbarShared,
      hook,
      views: { problems: () => [] },
      bookmarks: { state: "ready" },
      ...over,
    },
  };
}

test("every check passes on a healthy setup", async () => {
  const { hook, opts } = setup();
  const r = await runSelfCheck(opts);
  assert.deepEqual(r, { ok: true, failed: [], errors: {} });
  assert.deepEqual(opts.Query.added, [], "the synthetic query added a result");
  hook.uninstall();
});

test("CHECKS lists the seven checks, in the order they run", () => {
  assert.deepEqual(CHECKS, [
    "hook-installed",
    "history-container-column",
    "active-space-resolves",
    "synthetic-query-filtered",
    "view-guard",
    "space-switch-guard",
    "bookmark-spaces",
  ]);
});

test("hook-installed and synthetic-query-filtered fail without the hook", async () => {
  const { hook, opts } = setup();
  hook.uninstall();
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["hook-installed", "synthetic-query-filtered"]);
  assert.equal(r.ok, false);
});

test("history-container-column fails without the column", async () => {
  const { hook, opts } = setup({ PlacesUtils: makePlaces({ column: false }) });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["history-container-column"]);
  assert.match(r.errors["history-container-column"], /userContextId/);
  hook.uninstall();
});

test("a check that throws counts as failed", async () => {
  const { hook, opts } = setup({ PlacesUtils: makePlaces({ broken: true }) });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["history-container-column"]);
  hook.uninstall();
});

test("active-space-resolves fails when a window's space lookup is gone", async () => {
  const healthy = makeWin();
  const renamed = makeWin();
  renamed.gZenWorkspaces.getCurrentSpaceContainerId = undefined;
  const { hook, opts } = setup({ win: healthy, wins: [healthy, renamed] });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["active-space-resolves"]);
  assert.match(r.errors["active-space-resolves"], /getCurrentSpaceContainerId/);
  hook.uninstall();
});

test("active-space-resolves fails with no window", async () => {
  const { hook, opts } = setup({ win: null, wins: [] });
  const r = await runSelfCheck(opts);
  assert.ok(r.failed.includes("active-space-resolves"));
  assert.ok(r.failed.includes("synthetic-query-filtered"));
  hook.uninstall();
});

test("a window whose spaces never finish loading is checked after the wait", async () => {
  const win = makeWin({ initialized: new Promise(() => {}) });
  const { hook, opts } = setup({ win, wins: [win], waitMs: 20 });
  const r = await runSelfCheck(opts);
  assert.equal(r.ok, true);
  hook.uninstall();
});

// R37: popups, private and unsynced windows have none of the user's spaces
// (gZenWorkspaces.privateWindowOrDisabled, ZenSpaceManager.mjs:771-773).
function makeSpacelessWin({ popup = false, initialized = Promise.resolve() } = {}) {
  const win = makeWin({ initialized });
  win.gZenWorkspaces.privateWindowOrDisabled = true;
  if (popup) {
    // A popup's spaces never load (:93-99).
    win.gZenWorkspaces.getActiveWorkspaceFromCache = () => null;
  }
  return win;
}

test("active-space-resolves skips windows without a space (R37)", async () => {
  const healthy = makeWin();
  const wins = [healthy, makeSpacelessWin({ popup: true }), makeSpacelessWin()];
  const { hook, opts } = setup({ win: healthy, wins });
  assert.deepEqual(await runSelfCheck(opts), { ok: true, failed: [], errors: {} });
  hook.uninstall();
});

test("active-space-resolves does not wait for the spaces of a window that has none (R37)", async () => {
  const healthy = makeWin();
  const popup = makeSpacelessWin({ popup: true, initialized: new Promise(() => {}) });
  const { hook, opts } = setup({ win: healthy, wins: [healthy, popup], waitMs: 5000 });
  const before = Date.now();
  assert.equal((await runSelfCheck(opts)).ok, true);
  assert.ok(Date.now() - before < 2000, "waited for a popup's spaces");
  hook.uninstall();
});

test("active-space-resolves fails when privateWindowOrDisabled is missing (R37)", async () => {
  const healthy = makeWin();
  const future = makeWin();
  delete future.gZenWorkspaces.privateWindowOrDisabled;
  const { hook, opts } = setup({ win: healthy, wins: [healthy, future] });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["active-space-resolves"]);
  assert.match(r.errors["active-space-resolves"], /privateWindowOrDisabled/);
  hook.uninstall();
});

test("with only windows without a space there is no space to resolve, and the query is still filtered (R37)", async () => {
  const privateWin = makeSpacelessWin();
  const { hook, opts } = setup({ win: privateWin, wins: [privateWin] });
  assert.deepEqual(await runSelfCheck(opts), { ok: true, failed: [], errors: {} });
  hook.uninstall();
});

// A window that finishes starting while a run awaits is not in that run's
// list; the next run checks it.
test("runSelfCheckOnEveryWindow checks a window that starts during the check", async () => {
  const first = makeWin();
  const late = makeWin();
  late.gZenWorkspaces.getCurrentSpaceContainerId = undefined;
  const started = [first];
  const PlacesUtils = makePlaces();
  const connect = PlacesUtils.promiseDBConnection;
  let reads = 0;
  PlacesUtils.promiseDBConnection = async function () {
    if (++reads === 1) {
      started.push(late); // starts while the first run reads Places
    }
    return connect.call(this);
  };
  const { hook, opts } = setup({ win: first, PlacesUtils });
  delete opts.wins;

  // Positive control: one run over the windows started when it began passes.
  assert.equal((await runSelfCheck({ ...opts, wins: [first] })).ok, true);
  started.length = 1;
  reads = 0;

  const r = await runSelfCheckOnEveryWindow({ ...opts, readyWindows: () => [...started] });
  assert.deepEqual(r.failed, ["active-space-resolves"]);
  assert.match(r.errors["active-space-resolves"], /getCurrentSpaceContainerId/);
  assert.equal(reads, 2, "the check did not run again for the late window");
  hook.uninstall();
});

test("runSelfCheckOnEveryWindow runs once when no window starts meanwhile, and stops at a failure", async () => {
  const win = makeWin();
  const PlacesUtils = makePlaces();
  const { hook, opts } = setup({ win, PlacesUtils });
  delete opts.wins;
  const ok = await runSelfCheckOnEveryWindow({ ...opts, readyWindows: () => [win] });
  assert.deepEqual(ok, { ok: true, failed: [], errors: {} });
  assert.equal(PlacesUtils.sql.length, 1);

  const broken = await runSelfCheckOnEveryWindow({
    ...opts,
    bookmarks: { state: "failed" },
    readyWindows: () => [win],
  });
  assert.deepEqual(broken.failed, ["bookmark-spaces"]);
  hook.uninstall();
});

test("runSelfCheckOnEveryWindow fails closed when windows never stop starting", async () => {
  const wins = [makeWin()];
  const { hook, opts } = setup({ win: wins[0] });
  delete opts.wins;
  const r = await runSelfCheckOnEveryWindow({
    ...opts,
    readyWindows: () => {
      wins.push(makeWin());
      return [...wins];
    },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ["active-space-resolves"]);
  assert.match(r.errors["active-space-resolves"], /kept starting/);
  hook.uninstall();
});

test("synthetic-query-filtered fails when the filter keeps another container's row", async () => {
  const { hook, opts } = setup({ decideFor: () => true });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["synthetic-query-filtered"]);
  hook.uninstall();
});

test("synthetic-query-filtered fails when the filter drops everything", async () => {
  const { hook, opts } = setup({ decideFor: () => false });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["synthetic-query-filtered"]);
  hook.uninstall();
});

test("synthetic-query-filtered sees Firefox's add even when it accepts any provider", async () => {
  const Query = makeQuery({ strict: false });
  const { hook, opts } = setup({ Query, decideFor: () => true });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["synthetic-query-filtered"]);
  assert.deepEqual(Query.added, [], "Firefox's add went past canceled");
  hook.uninstall();
});

test("the synthetic query runs in the window's scope", async () => {
  const scopes = [];
  const { hook, opts } = setup({
    decideFor: (q, p, r, scope) => {
      scopes.push(scope);
      return filterLikeRules(q, p);
    },
  });
  await runSelfCheck(opts);
  assert.ok(scopes.length >= 2);
  for (const s of scopes) {
    assert.equal(s.win, opts.win);
  }
  hook.uninstall();
});

test("view-guard and space-switch-guard report the view guards' problems", async () => {
  const problems = [
    { check: "view-guard", win: {}, detail: "window not guarded" },
    { check: "space-switch-guard", win: {}, detail: "no activeWorkspace setter" },
  ];
  const { hook, opts } = setup({ views: { problems: () => problems } });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["view-guard", "space-switch-guard"]);
  assert.match(r.errors["view-guard"], /not guarded/);
  assert.match(r.errors["space-switch-guard"], /setter/);
  hook.uninstall();
});

test("view-guard fails without view guards", async () => {
  const { hook, opts } = setup({ views: null });
  const r = await runSelfCheck(opts);
  assert.deepEqual(r.failed, ["view-guard", "space-switch-guard"]);
  hook.uninstall();
});

test("bookmark-spaces fails after a failed bookmark read, not while loading", async () => {
  const { hook, opts } = setup({ bookmarks: { state: "failed" } });
  assert.deepEqual((await runSelfCheck(opts)).failed, ["bookmark-spaces"]);
  opts.bookmarks = { state: "loading" };
  assert.deepEqual((await runSelfCheck(opts)).failed, []);
  opts.bookmarks = null;
  assert.deepEqual((await runSelfCheck(opts)).failed, ["bookmark-spaces"]);
  hook.uninstall();
});

// gNotificationBox (notificationbox.js): appendNotification(value, {label,
// priority}) is async, getNotificationWithValue(value), removeNotification.
function noticeWindow(ready = true) {
  const items = [];
  return {
    items,
    gBrowserInit: { delayedStartupFinished: ready },
    gNotificationBox: {
      PRIORITY_WARNING_HIGH: 6,
      async appendNotification(value, { label, priority }) {
        const item = { value, label, priority };
        items.push(item);
        return item;
      },
      getNotificationWithValue: v => items.find(i => i.value === v) ?? null,
      removeNotification(item) {
        items.splice(items.indexOf(item), 1);
      },
    },
  };
}

function noticeServices(wins) {
  let observer = null;
  return {
    wm: {
      *getEnumerator() {
        yield* wins;
      },
    },
    obs: {
      addObserver: o => (observer = o),
      removeObserver: () => (observer = null),
      notify: (win, topic) => observer?.observe(win, topic),
    },
    get observed() {
      return !!observer;
    },
  };
}

const settle = () => new Promise(r => setTimeout(r, 0));

test("the notice names the failed checks on every window, new ones too, until cleared", async () => {
  const a = noticeWindow();
  const later = noticeWindow(false);
  const Services = noticeServices([a, later]);
  const notices = watchNotices({ Services });
  notices.show(["active-space-resolves", "view-guard"]);
  await settle();
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].value, NOTICE);
  assert.match(a.items[0].label, /active-space-resolves, view-guard/);
  assert.equal(a.items[0].priority, 6);
  assert.equal(later.items.length, 0);

  later.gBrowserInit.delayedStartupFinished = true;
  Services.obs.notify(later, "browser-delayed-startup-finished");
  await settle();
  assert.equal(later.items.length, 1);

  notices.show(["bookmark-spaces"]);
  await settle();
  assert.equal(a.items.length, 1, "a second show stacked notices");
  assert.match(a.items[0].label, /bookmark-spaces/);

  notices.clear();
  await settle();
  assert.equal(a.items.length + later.items.length, 0);
  Services.obs.notify(later, "browser-delayed-startup-finished");
  await settle();
  assert.equal(later.items.length, 0, "a cleared notice came back on a new window");
  notices.stop();
  assert.equal(Services.observed, false);
});

// R40: the switch runs the checks again, except after a failure while the
// add-on was loading (api.js, setEnabled), which only a Zen restart retries.
test("the notice says how to retry: the switch, or a restart after a failed start-up", async () => {
  const a = noticeWindow();
  const notices = watchNotices({ Services: noticeServices([a]) });
  notices.show(["view-guard"]);
  await settle();
  assert.match(a.items[0].label, /switch the add-on off and on again/i);
  assert.doesNotMatch(a.items[0].label, /restart Zen/i);

  notices.show(["view-guard"], { canRetry: true });
  await settle();
  assert.match(a.items[0].label, /switch the add-on off and on again/i);

  notices.show(["start"], { canRetry: false });
  await settle();
  assert.equal(a.items.length, 1);
  assert.match(a.items[0].label, /these checks failed: start\./);
  assert.match(a.items[0].label, /restart Zen/i);
  assert.doesNotMatch(a.items[0].label, /off and on again/i);
  notices.stop();
});

test("stop removes the notices", async () => {
  const a = noticeWindow();
  const notices = watchNotices({ Services: noticeServices([a]) });
  notices.show(["hook-installed"]);
  await settle();
  notices.stop();
  await settle();
  assert.equal(a.items.length, 0);
});

test("the conflict notice names the spaces, is its own notice, and goes away when cleared", async () => {
  const a = noticeWindow();
  a.gNotificationBox.PRIORITY_WARNING_MEDIUM = 4;
  const Services = noticeServices([a]);
  const failed = watchNotices({ Services });
  const notice = watchConflictNotice({ Services });
  failed.show(["view-guard"]);
  notice.show([{ ucid: 0, spaces: ["Work", "Other"] }]);
  await settle();
  assert.deepEqual(a.items.map(i => i.value).sort(), [CONFLICT_NOTICE, NOTICE].sort());
  const item = a.items.find(i => i.value === CONFLICT_NOTICE);
  assert.match(item.label, /"Work", "Other"/);
  assert.equal(item.priority, 4);

  notice.show([{ ucid: 6, spaces: ["A", "B", "C"] }]);
  await settle();
  assert.equal(a.items.filter(i => i.value === CONFLICT_NOTICE).length, 1);
  assert.match(a.items.find(i => i.value === CONFLICT_NOTICE).label, /"A", "B", "C"/);

  notice.clear();
  await settle();
  assert.deepEqual(a.items.map(i => i.value), [NOTICE], "clearing the conflict notice kept the other");
  failed.stop();
  notice.stop();
});
