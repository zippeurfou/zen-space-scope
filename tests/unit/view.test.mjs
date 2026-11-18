import test from "node:test";
import assert from "node:assert/strict";
import { installViewGuard, installViewGuards } from "../../src/glue/view.sys.mjs";
import { openTabLabel } from "../../src/glue/tabs.sys.mjs";

// Shaped like UrlbarView (UrlbarView.mjs:84): onQueryResults() renders and
// caches a context (:1035-1036), autoOpen() replays the cached top-sites
// context through onQueryResults (:853-854), queryContextCache (:111, class
// :4952) holds the replayable contexts.
function makeWindow({ spaceId = "work", ucid = 0 } = {}) {
  class View {
    constructor() {
      this.rendered = [];
      this.isOpen = false;
      this.cleared = 0;
      this.cache = { top: null, entries: [] };
      const cache = this.cache;
      this.queryContextCache = {
        get topSitesContext() {
          return cache.top;
        },
        clear() {
          cache.top = null;
          cache.entries = [];
        },
      };
    }
    onQueryResults(ctx) {
      if (!ctx.searchString) {
        this.cache.top = ctx;
      }
      this.rendered.push(ctx.results.map(r => r.id));
    }
    autoOpen() {
      if (this.queryContextCache.topSitesContext) {
        this.onQueryResults(this.queryContextCache.topSitesContext);
      }
      return true;
    }
    clear() {
      this.cleared++;
    }
  }
  const listeners = [];
  // Like nsZenWorkspaces (ZenSpaceManager.mjs:45): activeWorkspace is a
  // class accessor over a private field (:721-738).
  class Spaces {
    #active = spaceId;
    get activeWorkspace() {
      return this.#active;
    }
    set activeWorkspace(value) {
      this.#active = value;
      win.space = { spaceId: value, ucid: win.ucids[value] ?? 0 };
    }
    addChangeListeners(func) {
      listeners.push(func);
    }
    removeChangeListeners(func) {
      listeners.splice(listeners.indexOf(func), 1);
    }
  }
  const win = {
    space: { spaceId, ucid },
    ucids: { [spaceId]: ucid },
    gURLBar: { view: new View() },
    gZenWorkspaces: new Spaces(),
    listeners,
    switchTo(spaceId, ucid) {
      win.space = { spaceId, ucid };
      for (const l of [...listeners]) {
        l({ workspace: { uuid: spaceId } });
      }
    },
  };
  return win;
}

const scopeFor = win => win.space;
const Spaces = win => Object.getPrototypeOf(win.gZenWorkspaces);
// A result is kept when its container is the scope's.
const decideFor = (scope, result) => result.ucid === scope.ucid;
const ctx = (results, extra = {}) => ({ searchString: "", results, heuristicResult: null, ...extra });

test("drops rows of another container before they render", () => {
  const win = makeWindow({ ucid: 6 });
  const guard = installViewGuard(win, { scopeFor, decideFor });
  const c = ctx([{ id: "w", ucid: 0 }, { id: "p", ucid: 6 }]);
  win.gURLBar.view.onQueryResults(c);
  assert.deepEqual(win.gURLBar.view.rendered, [["p"]]);
  assert.deepEqual(c.results.map(r => r.id), ["p"]);
  guard.uninstall();
});

test("a context left with no row is not rendered", () => {
  const win = makeWindow({ ucid: 6 });
  const guard = installViewGuard(win, { scopeFor, decideFor });
  win.gURLBar.view.onQueryResults(ctx([{ id: "w", ucid: 0 }]));
  assert.deepEqual(win.gURLBar.view.rendered, []);
  guard.uninstall();
});

test("a dropped heuristic result is no longer the context's heuristic", () => {
  const win = makeWindow({ ucid: 6 });
  const guard = installViewGuard(win, { scopeFor, decideFor });
  const heur = { id: "h", ucid: 0 };
  const kept = { id: "k", ucid: 6 };
  const c = ctx([heur, kept], { heuristicResult: heur });
  win.gURLBar.view.onQueryResults(c);
  assert.equal(c.heuristicResult, null);
  const c2 = ctx([kept], { heuristicResult: kept });
  win.gURLBar.view.onQueryResults(c2);
  assert.equal(c2.heuristicResult, kept);
  guard.uninstall();
});

test("a throwing decideFor drops the row", () => {
  const win = makeWindow({ ucid: 6 });
  const errors = [];
  const guard = installViewGuard(win, {
    scopeFor,
    decideFor: (s, r) => {
      if (r.id === "bad") throw new Error("boom");
      return true;
    },
    onError: e => errors.push(e),
  });
  win.gURLBar.view.onQueryResults(ctx([{ id: "bad" }, { id: "ok" }]));
  assert.deepEqual(win.gURLBar.view.rendered, [["ok"]]);
  assert.equal(errors.length, 1);
  guard.uninstall();
});

test("a replay of another space's cached context shows none of its rows", () => {
  const win = makeWindow({ spaceId: "work", ucid: 0 });
  const view = win.gURLBar.view;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  view.onQueryResults(ctx([{ id: "work-tab", ucid: 0 }]));
  view.autoOpen();
  assert.deepEqual(view.rendered, [["work-tab"], ["work-tab"]], "positive control: Work replays its own row");
  // A switch that Zen never reports still clears the replay at the next open.
  win.space = { spaceId: "perso", ucid: 6 };
  view.rendered = [];
  view.autoOpen();
  assert.deepEqual(view.rendered, []);
  guard.uninstall();
});

test("installing clears the window's caches", () => {
  const win = makeWindow();
  win.gURLBar.view.cache.top = ctx([{ id: "x", ucid: 0 }]);
  const guard = installViewGuard(win, { scopeFor, decideFor });
  assert.equal(win.gURLBar.view.cache.top, null);
  guard.uninstall();
});

test("a space switch clears the caches and the rows of a closed view", () => {
  const win = makeWindow();
  const view = win.gURLBar.view;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  view.onQueryResults(ctx([{ id: "w", ucid: 0 }]));
  assert.ok(view.cache.top);
  const before = view.cleared;
  win.switchTo("perso", 6);
  assert.equal(view.cache.top, null);
  assert.equal(view.cleared, before + 1);
  guard.uninstall();
});

test("uninstall restores the view and removes the space listener", () => {
  const win = makeWindow();
  const view = win.gURLBar.view;
  const proto = Object.getPrototypeOf(view);
  const guard = installViewGuard(win, { scopeFor, decideFor });
  assert.equal(win.listeners.length, 1);
  guard.uninstall();
  assert.equal(view.onQueryResults, proto.onQueryResults);
  assert.equal(view.autoOpen, proto.autoOpen);
  assert.ok(!Object.hasOwn(view, "onQueryResults"));
  assert.equal(win.listeners.length, 0);
  guard.uninstall();
});

test("uninstall leaves a wrapper installed on top of ours in place", () => {
  const win = makeWindow({ ucid: 6 });
  const view = win.gURLBar.view;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  const ours = view.onQueryResults;
  const theirs = function (c) {
    return ours.call(this, c);
  };
  view.onQueryResults = theirs;
  guard.uninstall();
  assert.equal(view.onQueryResults, theirs);
  // Ours is now a pass-through.
  view.onQueryResults(ctx([{ id: "w", ucid: 0 }]));
  assert.deepEqual(view.rendered, [["w"]]);
});

test("throws when the window has no address-bar view", () => {
  assert.throws(() => installViewGuard({}, { scopeFor, decideFor }), /view/);
});

// Services-shaped fake: windows from wm, the startup topic from obs.
function makeServices(wins) {
  const observers = new Set();
  return {
    observers,
    wm: {
      *getEnumerator(type) {
        assert.equal(type, "navigator:browser");
        yield* wins;
      },
    },
    obs: {
      addObserver(o, topic) {
        observers.add(`${topic}`);
        this.o = o;
      },
      removeObserver(o, topic) {
        observers.delete(`${topic}`);
      },
      notify(subject, topic) {
        if (observers.has(topic)) this.o.observe(subject, topic);
      },
    },
  };
}

function eventTarget(win) {
  const handlers = {};
  win.addEventListener = (type, fn) => {
    handlers[type] = fn;
  };
  win.removeEventListener = (type, fn) => {
    if (handlers[type] === fn) delete handlers[type];
  };
  win.fire = type => handlers[type]?.();
  win.handlers = handlers;
  return win;
}

test("installViewGuards guards open windows, later windows, and lets go on close", () => {
  const ready = eventTarget(makeWindow());
  ready.gBrowserInit = { delayedStartupFinished: true };
  const starting = eventTarget(makeWindow());
  starting.gBrowserInit = { delayedStartupFinished: false };
  const Services = makeServices([ready, starting]);
  const all = installViewGuards({ Services, scopeFor, decideFor });
  assert.ok(Object.hasOwn(ready.gURLBar.view, "onQueryResults"));
  assert.ok(!Object.hasOwn(starting.gURLBar.view, "onQueryResults"));

  starting.gBrowserInit.delayedStartupFinished = true;
  Services.obs.notify(starting, "browser-delayed-startup-finished");
  assert.ok(Object.hasOwn(starting.gURLBar.view, "onQueryResults"));
  // A second notification does not wrap twice.
  Services.obs.notify(starting, "browser-delayed-startup-finished");
  assert.equal(starting.listeners.length, 1);

  ready.fire("unload");
  assert.ok(!Object.hasOwn(ready.gURLBar.view, "onQueryResults"));

  all.uninstall();
  assert.ok(!Object.hasOwn(starting.gURLBar.view, "onQueryResults"));
  assert.equal(Services.observers.size, 0);
  assert.equal(starting.handlers.unload, undefined);
});

test("installViewGuards reports a window it cannot guard and goes on", () => {
  const broken = eventTarget({ gBrowserInit: { delayedStartupFinished: true } });
  const ok = eventTarget(makeWindow());
  ok.gBrowserInit = { delayedStartupFinished: true };
  const errors = [];
  const all = installViewGuards({
    Services: makeServices([broken, ok]),
    scopeFor,
    decideFor,
    onError: e => errors.push(e),
  });
  assert.equal(errors.length, 1);
  assert.ok(Object.hasOwn(ok.gURLBar.view, "onQueryResults"));
  all.uninstall();
});

// openTabLabel: browsers as URILoadingHelper.switchToTabHavingURI walks them
// (gZenWorkspaces.allUsedBrowsers, URILoadingHelper.sys.mjs:1033-1040).
function tabWindow(tabs) {
  const browsers = tabs.map(t => ({
    currentURI: { spec: t.url },
    getAttribute: name => (name === "usercontextid" ? (t.ucid ? String(t.ucid) : "") : null),
    tab: { label: t.label },
  }));
  return {
    gZenWorkspaces: { allUsedBrowsers: browsers },
    gBrowser: { browsers, getTabForBrowser: b => b.tab },
  };
}

test("openTabLabel finds the tab with that url and that container", () => {
  const win = tabWindow([
    { url: "http://mail.test/inbox", ucid: 0, label: "Inbox - work" },
    { url: "http://mail.test/inbox", ucid: 6, label: "Inbox - home" },
  ]);
  assert.equal(openTabLabel([win], "http://mail.test/inbox", 6), "Inbox - home");
  assert.equal(openTabLabel([win], "http://mail.test/inbox", 0), "Inbox - work");
  assert.equal(openTabLabel([win], "http://mail.test/inbox", 2), null);
  assert.equal(openTabLabel([win], "http://mail.test/other", 0), null);
});

test("openTabLabel ignores the fragment and looks through every window in order", () => {
  const a = tabWindow([{ url: "http://x.test/a", ucid: 0, label: "A in win a" }]);
  const b = tabWindow([{ url: "http://x.test/b#top", ucid: 6, label: "B" }]);
  assert.equal(openTabLabel([a, b], "http://x.test/b", 6), "B");
  assert.equal(openTabLabel([a, b], "http://x.test/a#frag", 0), "A in win a");
});

test("openTabLabel falls back to gBrowser.browsers and skips empty labels", () => {
  const win = tabWindow([
    { url: "http://x.test/a", ucid: 0, label: "" },
    { url: "http://x.test/a", ucid: 0, label: "second" },
  ]);
  delete win.gZenWorkspaces;
  assert.equal(openTabLabel([win], "http://x.test/a", 0), "second");
});

test("setting the active space clears an open panel's rows and the caches at once", () => {
  const win = makeWindow();
  win.ucids.perso = 6;
  const view = win.gURLBar.view;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  view.onQueryResults(ctx([{ id: "w", ucid: 0 }]));
  view.isOpen = true;
  const before = view.cleared;
  win.gZenWorkspaces.activeWorkspace = "perso";
  assert.equal(win.gZenWorkspaces.activeWorkspace, "perso");
  assert.equal(view.cleared, before + 1, "the open panel's rows were not cleared");
  assert.equal(view.cache.top, null);
  guard.uninstall();
});

test("Zen's change listener after a switch already seen keeps an open panel's rows", () => {
  const win = makeWindow();
  win.ucids.perso = 6;
  const view = win.gURLBar.view;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  win.gZenWorkspaces.activeWorkspace = "perso";
  view.onQueryResults(ctx([{ id: "p", ucid: 6 }]));
  view.isOpen = true;
  const before = view.cleared;
  for (const l of [...win.listeners]) {
    l({ workspace: { uuid: "perso" } });
  }
  assert.equal(view.cleared, before, "Perso's own rows were cleared");
  assert.equal(view.cache.top, null, "the caches were not cleared");
  guard.uninstall();
});

test("uninstall removes the space accessor and keeps the class's", () => {
  const win = makeWindow();
  win.ucids.perso = 6;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  assert.ok(Object.hasOwn(win.gZenWorkspaces, "activeWorkspace"));
  guard.uninstall();
  assert.ok(!Object.hasOwn(win.gZenWorkspaces, "activeWorkspace"));
  assert.ok(Object.getOwnPropertyDescriptor(Spaces(win), "activeWorkspace").set);
  win.gZenWorkspaces.activeWorkspace = "perso";
  assert.equal(win.gZenWorkspaces.activeWorkspace, "perso");
});

// For the self-check (rulings R25, R27): what a guard reports as missing.
test("problems() is empty while the guard and its space-switch wrap are in place", () => {
  const win = makeWindow();
  const guard = installViewGuard(win, { scopeFor, decideFor });
  assert.deepEqual(guard.problems(), []);
  guard.uninstall();
  assert.deepEqual(guard.problems().map(p => p.check), ["view-guard", "space-switch-guard"]);
});

test("problems() reports a view whose wrappers are gone", () => {
  const win = makeWindow();
  const view = win.gURLBar.view;
  const guard = installViewGuard(win, { scopeFor, decideFor });
  delete view.onQueryResults;
  assert.deepEqual(guard.problems().map(p => p.check), ["view-guard"]);
  guard.uninstall();
});

test("problems() reports a window whose active space has no setter to wrap", () => {
  const win = makeWindow();
  // As if Zen renamed the accessor: only a getter is left.
  Object.defineProperty(win.gZenWorkspaces, "activeWorkspace", {
    configurable: true,
    get: () => "work",
  });
  const guard = installViewGuard(win, { scopeFor, decideFor });
  assert.deepEqual(guard.problems().map(p => p.check), ["space-switch-guard"]);
  guard.uninstall();
});

test("problems() reports a space-switch wrap replaced after install", () => {
  const win = makeWindow();
  const guard = installViewGuard(win, { scopeFor, decideFor });
  delete win.gZenWorkspaces.activeWorkspace;
  assert.deepEqual(guard.problems().map(p => p.check), ["space-switch-guard"]);
  guard.uninstall();
});

// R37: a popup, private or unsynced window has none of the user's spaces to
// switch between, so its setter wrap is not part of the self-check.
test("problems() does not ask a window without a space for the space-switch wrap", () => {
  const win = makeWindow();
  win.space = { error: "the window has no space of its own", noSpace: true };
  Object.defineProperty(win.gZenWorkspaces, "activeWorkspace", {
    configurable: true,
    get: () => "placeholder",
  });
  const guard = installViewGuard(win, { scopeFor, decideFor });
  assert.deepEqual(guard.problems(), []);
  // Its view is still guarded, and still checked.
  delete win.gURLBar.view.onQueryResults;
  assert.deepEqual(guard.problems().map(p => p.check), ["view-guard"]);
  guard.uninstall();
});

test("a window without a space still has its rows filtered under its scope", () => {
  const win = makeWindow();
  win.space = { error: "the window has no space of its own", noSpace: true };
  const seen = [];
  const guard = installViewGuard(win, {
    scopeFor,
    decideFor: (scope, result) => {
      seen.push(scope);
      return result.safe === true;
    },
  });
  const view = win.gURLBar.view;
  view.onQueryResults(ctx([{ id: "history", ucid: 0 }, { id: "search", safe: true }]));
  assert.deepEqual(view.rendered, [["search"]]);
  assert.ok(seen.every(scope => scope.noSpace === true));
  guard.uninstall();
});

test("installViewGuards reports unguarded and broken windows, and tells about each window", () => {
  const broken = eventTarget({ gBrowserInit: { delayedStartupFinished: true } });
  const ok = eventTarget(makeWindow());
  ok.gBrowserInit = { delayedStartupFinished: true };
  const later = eventTarget(makeWindow());
  later.gBrowserInit = { delayedStartupFinished: false };
  const Services = makeServices([broken, ok, later]);
  const failed = [];
  const guarded = [];
  const all = installViewGuards({
    Services,
    scopeFor,
    decideFor,
    onGuardFailed: (win, e) => failed.push([win, String(e)]),
    onGuarded: win => guarded.push(win),
  });
  assert.deepEqual(failed.map(([w]) => w), [broken]);
  assert.deepEqual(guarded, [ok]);
  assert.deepEqual(
    all.problems().map(p => [p.win, p.check]),
    [[broken, "view-guard"]]
  );

  later.gBrowserInit.delayedStartupFinished = true;
  Services.obs.notify(later, "browser-delayed-startup-finished");
  assert.deepEqual(guarded, [ok, later]);
  delete later.gZenWorkspaces.activeWorkspace;
  assert.deepEqual(
    all.problems().map(p => [p.win, p.check]),
    [
      [broken, "view-guard"],
      [later, "space-switch-guard"],
    ]
  );
  all.uninstall();
});

test("onDropped gets the rows the guard removed, with the scope, and nothing when all are kept", () => {
  const win = makeWindow({ ucid: 6 });
  const seen = [];
  const guard = installViewGuard(win, {
    scopeFor,
    decideFor,
    onDropped: (scope, rows) => seen.push({ scope, ids: rows.map(r => r.id) }),
  });
  win.gURLBar.view.onQueryResults(ctx([{ id: "w", ucid: 0 }, { id: "p", ucid: 6 }]));
  assert.deepEqual(seen, [{ scope: { spaceId: "work", ucid: 6 }, ids: ["w"] }]);
  win.gURLBar.view.onQueryResults(ctx([{ id: "p2", ucid: 6 }]));
  assert.equal(seen.length, 1, "positive control: a context with every row kept reported drops");
  guard.uninstall();
});

test("a throwing onDropped does not break rendering", () => {
  const win = makeWindow({ ucid: 6 });
  const errors = [];
  const guard = installViewGuard(win, {
    scopeFor,
    decideFor,
    onError: e => errors.push(e),
    onDropped: () => {
      throw new Error("boom");
    },
  });
  win.gURLBar.view.onQueryResults(ctx([{ id: "w", ucid: 0 }, { id: "p", ucid: 6 }]));
  assert.deepEqual(win.gURLBar.view.rendered, [["p"]]);
  assert.equal(errors.length, 1);
  guard.uninstall();
});
