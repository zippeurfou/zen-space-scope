// The self-check the add-on runs before it turns history-based suggestions
// on (src/glue/prefs.sys.mjs), and the notice it shows while they stay off.
//
// runSelfCheck({ win, wins, Query, PlacesUtils, UrlbarShared, hook, views,
// bookmarks, waitMs }) -> { ok, failed, errors }, where `failed` lists the
// names in CHECKS that failed, in that order, and `errors` maps each to why.
// A check that throws fails. `win` is the window the synthetic query runs
// in; `wins` every started browser window.
//
// runSelfCheckOnEveryWindow({ readyWindows, ...the same without wins }) runs
// it until one run has covered every window started by the time it ended.

import { activeScope } from "./scope.sys.mjs";

export const CHECKS = Object.freeze([
  // Query.prototype.add and start are the hook's wrappers.
  "hook-installed",
  // moz_historyvisits has userContextId (Firefox 160).
  "history-container-column",
  // The active space and its container resolve in every window that has
  // spaces (ruling R37: popups, private and unsynced windows have none).
  "active-space-resolves",
  // A row no container visited is dropped by Query.prototype.add, and a
  // typed address is kept.
  "synthetic-query-filtered",
  // Every window's address-bar view is guarded (ruling R25).
  "view-guard",
  // The activeWorkspace setter is wrapped in every window that has spaces
  // (rulings R27, R37).
  "space-switch-guard",
  // Zen's bookmark spaces were read, or are still being read (ruling R23).
  "bookmark-spaces",
]);

// Never visited: .invalid is reserved (RFC 2606).
const SYNTHETIC_URL = "http://zen-space-scope-self-check.invalid/";
const WAIT_MS = 10000;

// Zen fills gZenWorkspaces in asynchronously after a window starts
// (promiseInitialized, ZenSpaceManager.mjs); a window still loading its spaces
// is checked once they are in, or after waitMs.
async function spacesReady(win, waitMs) {
  const ready = win?.gZenWorkspaces?.promiseInitialized;
  if (!ready || typeof ready.then !== "function") {
    return;
  }
  let timer;
  const timeout = new Promise(resolve => {
    timer = win.setTimeout?.(resolve, waitMs);
  });
  try {
    await Promise.race([ready.catch(() => {}), timeout]);
  } finally {
    win.clearTimeout?.(timer);
  }
}

// Runs one result through Query.prototype.add on a query object that only
// looks like Query (UrlbarProvidersManager.sys.mjs:719, add :914), and tells
// whether Firefox's own add was reached. The hook reads `canceled` once; the
// original add first rejects a provider that is not a UrlbarProvider (:915),
// and otherwise reads `canceled` next (:926), which then answers true, so it
// returns there without adding anything.
function reachesFirefoxAdd(Query, win, provider, result) {
  let reads = 0;
  const query = Object.create(Query.prototype, {
    canceled: {
      get() {
        reads++;
        return reads > 1;
      },
    },
    context: { value: { searchString: "", pendingHeuristicProviders: new Set() } },
    controller: { value: { browserWindow: win } },
  });
  try {
    Query.prototype.add.call(query, provider, result);
  } catch {
    return true;
  }
  return reads > 1;
}

const CHECKERS = {
  "hook-installed": ({ Query, hook }) => {
    if (typeof Query?.prototype?.add !== "function" || typeof Query.prototype.start !== "function") {
      throw new Error("Query.prototype.add or start is missing");
    }
    if (!hook?.isInstalled()) {
      throw new Error("Query.prototype.add or start is not the add-on's");
    }
  },

  "history-container-column": async ({ PlacesUtils }) => {
    const db = await PlacesUtils.promiseDBConnection();
    await db.execute("SELECT userContextId FROM moz_historyvisits LIMIT 0");
  },

  "active-space-resolves": async ({ wins, waitMs }) => {
    if (!wins.length) {
      throw new Error("no browser window");
    }
    for (const w of wins) {
      // A window Zen gives no space to has nothing to resolve (ruling R37),
      // and a popup's spaces never load. A missing privateWindowOrDisabled
      // getter is not that: activeScope answers an error and the check fails.
      if (activeScope(w).noSpace) {
        continue;
      }
      await spacesReady(w, waitMs);
      const scope = activeScope(w);
      if (scope.noSpace) {
        continue;
      }
      if (scope.error) {
        throw new Error(scope.error);
      }
    }
  },

  "synthetic-query-filtered": ({ win, Query, UrlbarShared }) => {
    if (!win) {
      throw new Error("no browser window to query in");
    }
    const { RESULT_TYPE, RESULT_SOURCE } = UrlbarShared;
    const history = {
      type: RESULT_TYPE.URL,
      source: RESULT_SOURCE.HISTORY,
      heuristic: false,
      payload: { url: SYNTHETIC_URL, title: "" },
    };
    if (reachesFirefoxAdd(Query, win, { name: "UrlbarProviderPlaces" }, history)) {
      throw new Error("a history row no container visited was not dropped");
    }
    const typed = {
      type: RESULT_TYPE.URL,
      source: RESULT_SOURCE.OTHER_LOCAL,
      heuristic: true,
      payload: { url: SYNTHETIC_URL, title: "" },
    };
    if (!reachesFirefoxAdd(Query, win, { name: "UrlbarProviderHeuristicFallback" }, typed)) {
      throw new Error("the typed address was dropped");
    }
  },

  "view-guard": ({ views }) => problemsOf(views, "view-guard"),
  "space-switch-guard": ({ views }) => problemsOf(views, "space-switch-guard"),

  "bookmark-spaces": ({ bookmarks }) => {
    if (!bookmarks) {
      throw new Error("Zen's bookmark spaces are not watched");
    }
    if (bookmarks.state === "failed") {
      throw new Error("reading Zen's bookmark spaces failed");
    }
  },
};

function problemsOf(views, check) {
  if (!views) {
    throw new Error("the address-bar views are not guarded");
  }
  const found = views.problems().filter(p => p.check === check);
  if (found.length) {
    throw new Error(`${found.length} window(s): ${found[0].detail}`);
  }
}

export async function runSelfCheck({ win = null, wins = win ? [win] : [], waitMs = WAIT_MS, ...rest }) {
  const opts = { win, wins, waitMs, ...rest };
  const failed = [];
  const errors = {};
  for (const name of CHECKS) {
    try {
      await CHECKERS[name](opts);
    } catch (e) {
      failed.push(name);
      errors[name] = String(e?.message ?? e);
    }
  }
  return { ok: failed.length === 0, failed, errors };
}

// A window that finishes starting while a run awaits is not in that run's
// `wins`. This runs the self-check again until one run has covered every
// window `readyWindows()` lists once it is over, so no window goes without
// its per-window checks. It stops at the first failed run, and fails closed
// if windows keep starting.
const MAX_RUNS = 5;

export async function runSelfCheckOnEveryWindow({ readyWindows, ...rest }) {
  for (let run = 0; run < MAX_RUNS; run++) {
    const wins = readyWindows();
    const result = await runSelfCheck({ ...rest, wins });
    if (!result.ok || readyWindows().every(w => wins.includes(w))) {
      return result;
    }
  }
  const check = "active-space-resolves";
  return {
    ok: false,
    failed: [check],
    errors: { [check]: "browser windows kept starting during the self-check" },
  };
}

// The notification bar on every browser window (gNotificationBox,
// toolkit/content/global/elements/notificationbox.js: appendNotification
// :145, getNotificationWithValue :64, removeNotification :292), one notice
// kind per `value`: while the add-on fails closed (NOTICE), and while two
// spaces share a container (CONFLICT_NOTICE). Windows opened meanwhile get it
// once they start.
export const NOTICE = "zen-space-scope-fail-closed";
export const CONFLICT_NOTICE = "zen-space-scope-container-conflict";
const WINDOW_TOPIC = "browser-delayed-startup-finished";

// The switch runs the checks again, except after a failure while the add-on
// was loading (api.js, setEnabled), which only a Zen restart retries.
const labelFor = (failed, canRetry) =>
  "Zen Space Scope turned off address-bar suggestions from history, bookmarks, " +
  `open tabs and top sites because these checks failed: ${failed.join(", ")}. ` +
  (canRetry
    ? "To retry, switch the add-on off and on again in its options page."
    : "This happened while the add-on was starting: restart Zen to retry.");

const conflictLabelFor = conflicts =>
  "Zen Space Scope cannot tell some spaces apart because they share a container: " +
  conflicts
    .map(c => c.spaces.map(name => JSON.stringify(name)).join(", "))
    .join("; ") +
  ". Suggestions from one of them can show in the other. " +
  "Give each space its own container to keep them apart.";

export function watchNotices({ Services, onError = () => {} }) {
  const notice = makeNotice({ Services, onError, value: NOTICE, priority: "PRIORITY_WARNING_HIGH" });
  return {
    ...notice,
    show: (failed, { canRetry = true } = {}) => notice.show(labelFor(failed, canRetry)),
  };
}

// `conflicts` is containerConflicts()'s answer, in src/glue/scope.sys.mjs.
export function watchConflictNotice({ Services, onError = () => {} }) {
  const notice = makeNotice({
    Services,
    onError,
    value: CONFLICT_NOTICE,
    priority: "PRIORITY_WARNING_MEDIUM",
  });
  return { ...notice, show: conflicts => notice.show(conflictLabelFor(conflicts)) };
}

function makeNotice({ Services, onError, value, priority }) {
  let label = null;
  let stopped = false;
  // Bumped by every show() and clear(), so a notice still being added for an
  // earlier one is removed once it lands.
  let version = 0;

  function remove(win) {
    try {
      const box = win.gNotificationBox;
      const item = box?.getNotificationWithValue(value);
      if (item) {
        box.removeNotification(item, true);
      }
    } catch (e) {
      onError(`removing the fail-closed notice failed: ${e}`);
    }
  }

  function put(win) {
    remove(win);
    const box = win.gNotificationBox;
    if (!box) {
      return;
    }
    const at = version;
    Promise.resolve()
      .then(() => box.appendNotification(value, { label, priority: box[priority] }))
      .then(item => {
        // Cleared or replaced while it was being added.
        if (item && at !== version) {
          box.removeNotification(item, true);
        }
      })
      .catch(e => onError(`showing the fail-closed notice failed: ${e}`));
  }

  function* windows() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && win.gBrowserInit?.delayedStartupFinished) {
        yield win;
      }
    }
  }

  const observer = {
    observe(win, topic) {
      if (topic === WINDOW_TOPIC && label !== null && !stopped) {
        put(win);
      }
    },
  };
  Services.obs.addObserver(observer, WINDOW_TOPIC);

  return {
    show(text) {
      if (stopped) {
        return;
      }
      label = text;
      version++;
      for (const win of windows()) {
        put(win);
      }
    },
    clear() {
      label = null;
      version++;
      for (const win of windows()) {
        remove(win);
      }
    },
    stop() {
      if (stopped) {
        return;
      }
      this.clear();
      stopped = true;
      Services.obs.removeObserver(observer, WINDOW_TOPIC);
    },
  };
}
