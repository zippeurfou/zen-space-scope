// The active space of a browser window and its container (Zen 1.24.2b,
// browser/modules/zen/ZenSpaceManager.mjs: window.gZenWorkspaces :3737,
// getCurrentSpaceContainerId() :418-420, which is 0 for a space without a
// container :411-416, getActiveWorkspaceFromCache() :779).
//
// Some browser windows have none of the user's spaces (ruling R37): Zen's
// privateWindowOrDisabled getter (:771-773) is true for popups and taskbar
// tabs, which never load spaces (no toolbar or menubar chrome flag, :93-99,
// :744-757), and for private and unsynced windows (:763-769), which only get
// a placeholder space named "Space" in container 0 (:165-169, :854-869).
// Such a window gets no scope, so its address bar keeps only the allowlisted
// kinds: the placeholder's container 0 is not the user's space without a
// container.

const NO_SPACE = "the window has no space of its own (private, unsynced or popup window)";

// { ucid, spaceId, spaceName }, or { error } when the window has no scope.
// `noSpace: true` comes with the error for a window Zen gives no space to,
// which is expected; any other error is a lookup that failed.
export function activeScope(win) {
  try {
    const spaces = win?.gZenWorkspaces;
    if (!spaces) {
      return { error: "no gZenWorkspaces on the window" };
    }
    const spaceless = spaces.privateWindowOrDisabled;
    if (typeof spaceless !== "boolean") {
      return { error: "gZenWorkspaces.privateWindowOrDisabled is missing" };
    }
    if (spaceless) {
      return { error: NO_SPACE, noSpace: true };
    }
    if (typeof spaces.getCurrentSpaceContainerId !== "function") {
      return { error: "gZenWorkspaces.getCurrentSpaceContainerId is missing" };
    }
    if (typeof spaces.getActiveWorkspaceFromCache !== "function") {
      return { error: "gZenWorkspaces.getActiveWorkspaceFromCache is missing" };
    }
    const space = spaces.getActiveWorkspaceFromCache();
    if (!space?.uuid) {
      return { error: "the window has no active space" };
    }
    const ucid = spaces.getCurrentSpaceContainerId();
    if (!Number.isInteger(ucid) || ucid < 0) {
      return { error: `the active space's container is not a container id: ${ucid}` };
    }
    return { ucid, spaceId: space.uuid, spaceName: String(space.name ?? "") };
  } catch (e) {
    return { error: `space lookup failed: ${e}` };
  }
}

// Whether Zen says the window has none of the user's spaces. False when it
// cannot tell (a missing getter, which activeScope reports as an error).
// Never throws.
export function isSpaceless(win) {
  try {
    return win?.gZenWorkspaces?.privateWindowOrDisabled === true;
  } catch {
    return false;
  }
}

// Groups of two or more spaces in the same container, by container id. The
// add-on keys everything on the container, so it cannot tell such spaces
// apart. A space without a container is in container 0
// (#spaceContainerId, ZenSpaceManager.mjs:412-416); getWorkspaces() :809-817.
// Throws when the window has no spaces to read.
export function containerConflicts(win) {
  const spaces = win?.gZenWorkspaces;
  if (typeof spaces?.getWorkspaces !== "function") {
    throw new Error("gZenWorkspaces.getWorkspaces is missing");
  }
  const all = spaces.getWorkspaces();
  if (!Array.isArray(all)) {
    throw new Error("gZenWorkspaces.getWorkspaces did not return the spaces");
  }
  const groups = new Map();
  for (const space of all) {
    const ucid = typeof space?.containerTabId === "number" ? space.containerTabId : 0;
    const names = groups.get(ucid) ?? [];
    names.push(String(space?.name || space?.uuid || ""));
    groups.set(ucid, names);
  }
  return [...groups]
    .filter(([, names]) => names.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([ucid, names]) => ({ ucid, spaces: names }));
}

// Calls onChange() when a window reports that the spaces changed (Zen's
// "ZenWorkspaceDataChanged" window event, ZenSpaceManager.mjs:1545, sent
// after a space is created, changed or removed). Windows opened later are
// watched once they start. The call comes on the next tick, so Zen's own
// handlers have run.
export function watchConflicts({ Services, onChange }) {
  const EVENT = "ZenWorkspaceDataChanged";
  const handlers = new Map();
  let stopped = false;

  function watch(win) {
    if (stopped || handlers.has(win) || win.closed || !win.gBrowserInit?.delayedStartupFinished) {
      return;
    }
    const handler = () => {
      if (!stopped) {
        win.setTimeout(() => !stopped && onChange(), 0);
      }
    };
    handlers.set(win, handler);
    win.addEventListener(EVENT, handler);
  }

  const observer = {
    observe(win, topic) {
      if (topic === "browser-delayed-startup-finished") {
        watch(win);
      }
    },
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    watch(win);
  }

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      for (const [win, handler] of handlers) {
        try {
          win.removeEventListener(EVENT, handler);
        } catch {
          // The window is gone.
        }
      }
      handlers.clear();
    },
  };
}
