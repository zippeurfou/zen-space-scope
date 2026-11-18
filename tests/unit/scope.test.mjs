import test from "node:test";
import assert from "node:assert/strict";
import { activeScope, containerConflicts, isSpaceless, watchConflicts } from "../../src/glue/scope.sys.mjs";

// Shaped like nsZenWorkspaces (ZenSpaceManager.mjs): getWorkspaces() returns
// the space objects (:809-817); containerTabId is a number, or missing for a
// space without a container (:412-416).
const winWith = spaces => ({ gZenWorkspaces: { getWorkspaces: () => spaces } });
const space = (name, containerTabId, uuid = name) => ({ uuid, name, containerTabId });

test("two spaces in the same container are a conflict", () => {
  const win = winWith([space("Work", 0), space("Perso", 6), space("Lab", 6)]);
  assert.deepEqual(containerConflicts(win), [{ ucid: 6, spaces: ["Perso", "Lab"] }]);
});

test("spaces with no container count as container 0", () => {
  const win = winWith([space("A", undefined), space("B", 0), space("C", null), space("D", 3)]);
  assert.deepEqual(containerConflicts(win), [{ ucid: 0, spaces: ["A", "B", "C"] }]);
});

test("positive control: one space per container has no conflict", () => {
  const win = winWith([space("Work", 0), space("Perso", 6), space("Lab", 7)]);
  assert.deepEqual(containerConflicts(win), []);
});

test("conflicts are listed by container id, and an unnamed space by its uuid", () => {
  const win = winWith([space("", 9, "u1"), space("B", 2), space("C", 9), space("D", 2)]);
  assert.deepEqual(containerConflicts(win), [
    { ucid: 2, spaces: ["B", "D"] },
    { ucid: 9, spaces: ["u1", "C"] },
  ]);
});

test("a window with no spaces API throws, so the caller can log it", () => {
  assert.throws(() => containerConflicts({}), /getWorkspaces/);
  assert.throws(() => containerConflicts(winWith(null)), /spaces/);
});

function watchServices(wins) {
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

function eventWindow() {
  const listeners = new Map();
  return {
    gBrowserInit: { delayedStartupFinished: true },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    fire: type => listeners.get(type)?.(),
    has: type => listeners.has(type),
    setTimeout: fn => fn(),
  };
}

test("watchConflicts calls back when a window reports a change in the spaces, also in later windows", () => {
  const a = eventWindow();
  const later = eventWindow();
  later.gBrowserInit.delayedStartupFinished = false;
  const Services = watchServices([a, later]);
  let calls = 0;
  const watch = watchConflicts({ Services, onChange: () => calls++ });
  assert.equal(a.has("ZenWorkspaceDataChanged"), true);
  assert.equal(later.has("ZenWorkspaceDataChanged"), false);
  a.fire("ZenWorkspaceDataChanged");
  assert.equal(calls, 1);

  later.gBrowserInit.delayedStartupFinished = true;
  Services.obs.notify(later, "browser-delayed-startup-finished");
  assert.equal(later.has("ZenWorkspaceDataChanged"), true);
  later.fire("ZenWorkspaceDataChanged");
  assert.equal(calls, 2);

  watch.stop();
  assert.equal(Services.observed, false);
  assert.equal(a.has("ZenWorkspaceDataChanged"), false);
  assert.equal(later.has("ZenWorkspaceDataChanged"), false);
});

// Shaped like nsZenWorkspaces: privateWindowOrDisabled (ZenSpaceManager.mjs:
// 771-773) is true for popups, taskbar tabs, private and unsynced windows.
const scopedWin = (over = {}) => ({
  gZenWorkspaces: {
    privateWindowOrDisabled: false,
    getActiveWorkspaceFromCache: () => ({ uuid: "perso", name: "Perso" }),
    getCurrentSpaceContainerId: () => 6,
    ...over,
  },
});

test("activeScope: a window with a space answers its space and container", () => {
  assert.deepEqual(activeScope(scopedWin()), { ucid: 6, spaceId: "perso", spaceName: "Perso" });
  assert.equal(isSpaceless(scopedWin()), false);
});

test("activeScope (R37): a private or unsynced window has no scope, whatever its placeholder space says", () => {
  // Zen's placeholder: a space named "Space" in container 0 (:165-169, :854-869).
  const win = scopedWin({
    privateWindowOrDisabled: true,
    getActiveWorkspaceFromCache: () => ({ uuid: "placeholder", name: "Space" }),
    getCurrentSpaceContainerId: () => 0,
  });
  const scope = activeScope(win);
  assert.equal(scope.noSpace, true);
  assert.match(scope.error, /no space/);
  assert.equal(scope.ucid, undefined);
  assert.equal(scope.spaceId, undefined);
  assert.equal(isSpaceless(win), true);
});

test("activeScope (R37): a popup, whose spaces never load, has no scope and is not an unknown failure", () => {
  const win = scopedWin({
    privateWindowOrDisabled: true,
    getActiveWorkspaceFromCache: () => null,
  });
  assert.equal(activeScope(win).noSpace, true);
  assert.equal(isSpaceless(win), true);
});

test("activeScope (R37): a missing privateWindowOrDisabled getter is an error, not a window without a space", () => {
  for (const value of [undefined, null, 0, 1, "true"]) {
    const win = scopedWin({ privateWindowOrDisabled: value });
    const scope = activeScope(win);
    assert.match(scope.error, /privateWindowOrDisabled/, String(value));
    assert.equal(scope.noSpace, undefined, String(value));
    assert.equal(scope.ucid, undefined, String(value));
    assert.equal(isSpaceless(win), false, String(value));
  }
});

test("isSpaceless never throws", () => {
  assert.equal(isSpaceless(null), false);
  assert.equal(isSpaceless({}), false);
  const throwing = { gZenWorkspaces: {} };
  Object.defineProperty(throwing.gZenWorkspaces, "privateWindowOrDisabled", {
    get() {
      throw new Error("docShell is gone");
    },
  });
  assert.equal(isSpaceless(throwing), false);
  assert.match(activeScope(throwing).error, /docShell is gone/);
});
