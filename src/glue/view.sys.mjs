// Guards what a window's address-bar view shows, including rows that never
// went through a Query (Zen 1.24.2b,
// browser/chrome/browser/content/browser/urlbar/UrlbarView.mjs):
// - The view caches query contexts per window, not per space
//   (queryContextCache :111, QueryContextCache :4952-5060): the last
//   top-sites context and recent typed ones. autoOpen() replays them through
//   onQueryResults() before the new query runs (:853-854, :896-901), and it
//   reuses the rows on screen when the search string and page still match
//   (:884-889, :928-933).
// - Every render goes through onQueryResults(): the replays call
//   this.onQueryResults() (:854, :901), and live results reach it as a
//   listener, called by name (UrlbarChildController.mjs:260-264). A wrapper
//   set on the view instance therefore sees them all.
//
// installViewGuard(win, { scopeFor, decideFor, onError, onDropped }) wraps that
// window's view: before a context renders, rows decideFor() rejects for the
// window's current scope are removed, and onDropped(scope, rows) is told. Whenever the scope differs from the one last
// seen (checked when the active space is set, when the view opens and when
// it renders), the caches and the rows on screen, open panel or not, are
// cleared. Zen's space-switch listeners (gZenWorkspaces.addChangeListeners,
// ZenSpaceManager.mjs:1910-1929, called at :2728-2736) clear the caches
// again once a switch ends, and install clears them too.

// The getter/setter pair `name` resolves to on `obj`'s prototype chain.
function findAccessor(obj, name) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) {
      return typeof d.get === "function" && typeof d.set === "function" ? d : null;
    }
  }
  return null;
}

const scopeKey = scope =>
  !scope || scope.error ? "no scope" : `${scope.spaceId}\n${scope.ucid}`;

export function installViewGuard(win, { scopeFor, decideFor, onError = () => {}, onDropped = () => {} }) {
  const view = win?.gURLBar?.view;
  if (
    !view ||
    typeof view.onQueryResults !== "function" ||
    typeof view.autoOpen !== "function" ||
    typeof view.queryContextCache?.clear !== "function"
  ) {
    throw new Error("the window has no address-bar view to guard");
  }
  const spaces = win.gZenWorkspaces;
  const saved = {};
  for (const name of ["onQueryResults", "autoOpen"]) {
    saved[name] = { own: Object.hasOwn(view, name), value: view[name] };
  }
  let installed = true;
  let lastKey = null;

  // `rows`: "always" when the scope changed, so an open panel stops showing
  // the old scope's rows (they never pass through onQueryResults again);
  // "closed" otherwise, so an open panel keeps the current scope's rows.
  function reset(rows) {
    try {
      view.queryContextCache.clear();
      if (rows === "always" || !view.isOpen) {
        view.clear?.();
      }
    } catch (e) {
      onError(`clearing the address-bar caches failed: ${e}`);
    }
  }

  // Returns the current scope, clearing the caches first if it changed.
  function currentScope() {
    let scope;
    try {
      scope = scopeFor(win);
    } catch (e) {
      scope = { error: `scope lookup failed: ${e}` };
    }
    const key = scopeKey(scope);
    if (key !== lastKey) {
      lastKey = key;
      reset("always");
    }
    return scope;
  }

  function onQueryResults(queryContext) {
    if (!installed || !Array.isArray(queryContext?.results)) {
      return saved.onQueryResults.value.apply(this, arguments);
    }
    const scope = currentScope();
    const kept = queryContext.results.filter(result => {
      try {
        return !!decideFor(scope, result);
      } catch (e) {
        onError(`view decision failed, row dropped: ${e}`);
        return false;
      }
    });
    if (kept.length !== queryContext.results.length) {
      const dropped = queryContext.results.filter(result => !kept.includes(result));
      queryContext.results = kept;
      try {
        onDropped(scope, dropped);
      } catch (e) {
        onError(`reporting the dropped rows failed: ${e}`);
      }
      if (queryContext.heuristicResult && !kept.includes(queryContext.heuristicResult)) {
        queryContext.heuristicResult = null;
      }
    }
    if (!kept.length) {
      // The view expects at least one row (:1053); with none, the running
      // query's own end closes or fills the view.
      return undefined;
    }
    return saved.onQueryResults.value.apply(this, arguments);
  }

  function autoOpen() {
    if (installed) {
      currentScope();
    }
    return saved.autoOpen.value.apply(this, arguments);
  }

  const onSpaceChange = () => {
    if (installed) {
      const before = lastKey;
      currentScope();
      if (lastKey === before) {
        // A switch that left the scope as last seen still drops the caches.
        reset("closed");
      }
    }
  };

  // Zen's change listeners run only once the switch animation is over
  // (ZenSpaceManager.mjs:2714-2736), while the space changes at the very
  // start of the switch, through the activeWorkspace setter
  // (#performWorkspaceChange :1998, setter :725-738). An own accessor on this
  // window's gZenWorkspaces wraps the class's, so the change is seen as it
  // happens and an open panel drops the old space's rows at once.
  let spaceAccessor = null;
  const classAccessor = findAccessor(spaces, "activeWorkspace");
  if (classAccessor && !Object.hasOwn(spaces, "activeWorkspace")) {
    spaceAccessor = {
      configurable: true,
      enumerable: classAccessor.enumerable,
      get() {
        return classAccessor.get.call(this);
      },
      set(value) {
        classAccessor.set.call(this, value);
        if (installed) {
          currentScope();
        }
      },
    };
    Object.defineProperty(spaces, "activeWorkspace", spaceAccessor);
  }

  view.onQueryResults = onQueryResults;
  view.autoOpen = autoOpen;
  spaces?.addChangeListeners?.(onSpaceChange);
  currentScope();

  return {
    // What of this guard is no longer in place, for the self-check: the
    // view's wrappers ("view-guard", ruling R25) and, in a window that has
    // spaces, the active-space setter wrap ("space-switch-guard", ruling
    // R27). Empty when all is in place.
    problems() {
      const out = [];
      if (!installed || view.onQueryResults !== onQueryResults || view.autoOpen !== autoOpen) {
        out.push({ check: "view-guard", detail: "the address-bar view is not guarded" });
      }
      // A window without a space of its own has no switch to guard (ruling
      // R37); its view above is guarded and checked like any other.
      let spaceless = false;
      try {
        spaceless = scopeFor(win)?.noSpace === true;
      } catch {
        // Not known to be without a space: checked.
      }
      const own = Object.getOwnPropertyDescriptor(spaces ?? {}, "activeWorkspace");
      if (!spaceless && (!installed || !spaceAccessor || own?.set !== spaceAccessor.set)) {
        out.push({
          check: "space-switch-guard",
          detail: classAccessor
            ? "the activeWorkspace setter is not wrapped"
            : "gZenWorkspaces has no activeWorkspace setter to wrap",
        });
      }
      return out;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      spaces?.removeChangeListeners?.(onSpaceChange);
      const own = Object.getOwnPropertyDescriptor(spaces ?? {}, "activeWorkspace");
      if (spaceAccessor && own?.set === spaceAccessor.set) {
        delete spaces.activeWorkspace;
      }
      // Put back only what is still ours; a wrapper on top of ours keeps
      // calling ours, which is now a pass-through.
      for (const [name, ours] of [
        ["onQueryResults", onQueryResults],
        ["autoOpen", autoOpen],
      ]) {
        if (view[name] !== ours) {
          continue;
        }
        if (saved[name].own) {
          view[name] = saved[name].value;
        } else {
          delete view[name];
        }
      }
    },
  };
}

// Guards every browser window: those open now (once their startup is done,
// browser-init.js:748-750), those opened later (the
// "browser-delayed-startup-finished" notification), until each one unloads.
// A window that cannot be guarded is skipped and reported through
// onGuardFailed(win, error) (ruling R25: the add-on then fails closed);
// onGuarded(win) follows each window guarded.
export function installViewGuards({
  Services,
  scopeFor,
  decideFor,
  onError = () => {},
  onDropped = () => {},
  onGuardFailed = () => {},
  onGuarded = () => {},
}) {
  const guards = new Map();
  let installed = true;

  function guard(win) {
    if (!installed || guards.has(win)) {
      return;
    }
    let handle;
    try {
      handle = installViewGuard(win, { scopeFor, decideFor, onError, onDropped });
    } catch (e) {
      onError(`cannot guard a window's address bar: ${e}`);
      onGuardFailed(win, e);
      return;
    }
    const onUnload = () => release(win);
    win.addEventListener?.("unload", onUnload, { once: true });
    guards.set(win, { handle, onUnload });
    onGuarded(win);
  }

  function release(win) {
    const g = guards.get(win);
    if (!g) {
      return;
    }
    guards.delete(win);
    win.removeEventListener?.("unload", g.onUnload);
    g.handle.uninstall();
  }

  const observer = {
    observe(subject, topic) {
      if (topic === "browser-delayed-startup-finished") {
        guard(subject);
      }
    },
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.gBrowserInit?.delayedStartupFinished) {
      guard(win);
    }
  }

  return {
    // `{ win, check, detail }` for every started browser window that is not
    // guarded, or whose guard is no longer whole.
    problems() {
      const out = [];
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (win.closed || !win.gBrowserInit?.delayedStartupFinished) {
          continue;
        }
        const g = guards.get(win);
        if (!g) {
          out.push({ win, check: "view-guard", detail: "a browser window is not guarded" });
          continue;
        }
        for (const p of g.handle.problems()) {
          out.push({ win, ...p });
        }
      }
      return out;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      installed = false;
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      for (const win of [...guards.keys()]) {
        release(win);
      }
    },
  };
}
