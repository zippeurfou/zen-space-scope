import test from "node:test";
import assert from "node:assert/strict";
import { urlSpaces, urlTitles, watchBookmarkSpaces } from "../../src/glue/bookmarks.sys.mjs";

// Bookmark tree nodes shaped like PlacesUtils.promiseBookmarksTree():
// { guid, uri?, children? }.
const bm = (guid, uri) => ({ guid, uri });
const folder = (guid, ...children) => ({ guid, children });
const root = (...children) => folder("root________", ...children);

const sorted = s => [...s].sort();
// A lookup answer, or a map entry, with its spaces sorted.
const view = x => ({ spaces: sorted(x.spaces), unassigned: x.unassigned });
const at = (spaces, unassigned = false) => ({ spaces, unassigned });
// Every bookmark of the url in no space (or not a bookmark at all).
const NO_SPACE = at([], true);
// Not read yet, or the read failed: dropped everywhere.
const CLOSED = at([], false);

test("urlSpaces: assigned bookmarks map to their spaces, unassigned ones are left out", () => {
  const tree = root(folder("unfiled_____", bm("a", "http://a.test/"), bm("b", "http://b.test/")));
  const map = urlSpaces(tree, new Map([["a", new Set(["perso"])]]));
  assert.deepEqual(view(map.get("http://a.test/")), at(["perso"]));
  assert.equal(map.has("http://b.test/"), false);
});

test("urlSpaces: a url with assigned and unassigned bookmarks keeps both (R21)", () => {
  const tree = root(bm("a1", "http://a.test/"), bm("a2", "http://a.test/"), bm("a3", "http://a.test/"));
  const map = urlSpaces(
    tree,
    new Map([
      ["a1", new Set(["perso"])],
      ["a3", new Set(["work"])],
    ])
  );
  assert.deepEqual(view(map.get("http://a.test/")), at(["perso", "work"], true));
});

test("urlSpaces: several assigned bookmarks of a url give the union of their spaces", () => {
  const tree = root(bm("a1", "http://a.test/"), bm("a2", "http://a.test/"));
  const map = urlSpaces(
    tree,
    new Map([
      ["a1", new Set(["perso"])],
      ["a2", new Set(["work"])],
    ])
  );
  assert.deepEqual(view(map.get("http://a.test/")), at(["perso", "work"]));
});

test("urlSpaces: a folder's spaces apply to everything inside it", () => {
  const tree = root(folder("f", bm("a", "http://a.test/"), folder("g", bm("b", "http://b.test/"))));
  const map = urlSpaces(tree, new Map([["f", new Set(["perso"])]]));
  assert.deepEqual(view(map.get("http://a.test/")), at(["perso"]));
  assert.deepEqual(view(map.get("http://b.test/")), at(["perso"]));
});

test("urlSpaces: nested assignments intersect, as Zen's toolbar would show them", () => {
  const tree = root(folder("f", bm("a", "http://a.test/"), bm("b", "http://b.test/")));
  const map = urlSpaces(
    tree,
    new Map([
      ["f", new Set(["perso", "work"])],
      ["a", new Set(["work", "other"])],
      ["b", new Set(["other"])],
    ])
  );
  assert.deepEqual(view(map.get("http://a.test/")), at(["work"]));
  assert.deepEqual(view(map.get("http://b.test/")), at([]));
});

// Stubs of the Zen and Places pieces watchBookmarkSpaces uses:
// window.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace()
// (zen-components/ZenSpaceBookmarksStorage.js:192-209), Services.wm and
// Services.obs, PlacesUtils.promiseBookmarksTree() and PlacesUtils.observers.
function stubs({ assignments = {}, tree = root(), withWindow = true } = {}) {
  const obs = new Map();
  const placesListeners = [];
  const S = {
    assignments,
    tree,
    reads: 0,
    treeReads: 0,
    fail: null,
    gate: null,
    windows: [],
    hold() {
      let open;
      S.gate = new Promise(r => (open = r));
      return () => {
        S.gate = null;
        open();
      };
    },
    addWindow() {
      const win = {
        closed: false,
        ZenWorkspaceBookmarksStorage: {
          async getBookmarkGuidsByWorkspace() {
            S.reads++;
            const gate = S.gate;
            if (gate) {
              await gate;
            }
            if (S.fail) {
              throw new Error(S.fail);
            }
            return structuredClone(S.assignments);
          },
        },
      };
      S.windows.push(win);
      return win;
    },
    Services: {
      wm: { getEnumerator: type => (type === "navigator:browser" ? [...S.windows] : []) },
      obs: {
        addObserver(fn, topic) {
          obs.set(topic, [...(obs.get(topic) ?? []), fn]);
        },
        removeObserver(fn, topic) {
          obs.set(
            topic,
            (obs.get(topic) ?? []).filter(f => f !== fn)
          );
        },
      },
    },
    PlacesUtils: {
      async promiseBookmarksTree() {
        S.treeReads++;
        return structuredClone(S.tree);
      },
      observers: {
        addListener: (types, fn) => placesListeners.push({ types, fn }),
        removeListener: (types, fn) =>
          placesListeners.splice(
            placesListeners.findIndex(l => l.fn === fn),
            1
          ),
      },
    },
    notify(topic, subject = null, data = "") {
      for (const fn of obs.get(topic) ?? []) {
        fn(subject, topic, data);
      }
    },
    emit(...events) {
      for (const { types, fn } of [...placesListeners]) {
        const hits = events.filter(e => types.includes(e.type));
        if (hits.length) {
          fn(hits);
        }
      }
    },
    observerCount: () =>
      [...obs.values()].reduce((n, fns) => n + fns.length, 0) + placesListeners.length,
  };
  if (withWindow) {
    S.addWindow();
  }
  return S;
}
const tick = () => new Promise(r => setTimeout(r, 0));

test("before the first read every bookmark is dropped (fail closed)", async () => {
  const S = stubs();
  const release = S.hold();
  const w = watchBookmarkSpaces(S);
  assert.equal(w.state, "loading");
  assert.deepEqual(view(w.lookup("http://a.test/")), CLOSED);
  release();
  await w.ready;
  assert.equal(w.state, "ready");
  assert.deepEqual(view(w.lookup("http://a.test/")), NO_SPACE);
  w.stop();
});

test("without assignments every bookmark is unassigned", async () => {
  const S = stubs({ tree: root(bm("a", "http://a.test/")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  assert.deepEqual(view(w.lookup("http://a.test/")), NO_SPACE);
  w.stop();
});

test("an assigned bookmark answers its spaces", async () => {
  const S = stubs({
    assignments: { perso: ["a"] },
    tree: root(bm("a", "http://a.test/"), bm("b", "http://b.test/")),
  });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  assert.deepEqual(view(w.lookup("http://a.test/")), at(["perso"]));
  assert.deepEqual(view(w.lookup("http://b.test/")), NO_SPACE);
  w.stop();
});

test("Zen's workspace-bookmarks-updated notification refreshes the cache", async () => {
  const S = stubs({ tree: root(bm("a", "http://a.test/")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  assert.deepEqual(view(w.lookup("http://a.test/")), NO_SPACE);
  S.assignments = { perso: ["a"] };
  S.notify("workspace-bookmarks-updated", null, JSON.stringify({ bookmarkGuid: "a" }));
  assert.equal(w.state, "loading");
  await w.ready;
  assert.equal(w.state, "ready");
  assert.deepEqual(view(w.lookup("http://a.test/")), at(["perso"]));
  w.stop();
});

test("bookmark changes in Places refresh the cache", async () => {
  const S = stubs({ assignments: { perso: ["a"] }, tree: root(bm("a", "http://a.test/")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  for (const type of [
    "bookmark-added",
    "bookmark-removed",
    "bookmark-moved",
    "bookmark-url-changed",
    "bookmark-guid-changed",
    "bookmark-title-changed",
    "purge-caches",
  ]) {
    const before = S.reads;
    S.emit({ type });
    await w.ready;
    assert.equal(S.reads, before + 1, type);
  }
  // A second, unassigned bookmark of the same url is counted too.
  S.tree = root(bm("a", "http://a.test/"), bm("c", "http://a.test/"));
  S.emit({ type: "bookmark-added" });
  await w.ready;
  assert.deepEqual(view(w.lookup("http://a.test/")), at(["perso"], true));
  w.stop();
});

test("changes during a read are read again, and the last read wins", async () => {
  const S = stubs({ tree: root(bm("a", "http://a.test/")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  const release = S.hold();
  S.notify("workspace-bookmarks-updated");
  await tick();
  S.assignments = { perso: ["a"] };
  S.notify("workspace-bookmarks-updated");
  S.notify("workspace-bookmarks-updated");
  release();
  await w.ready;
  assert.equal(S.reads, 3, "the first read, the held one, and one more for both changes");
  assert.deepEqual(view(w.lookup("http://a.test/")), at(["perso"]));
  w.stop();
});

test("a failed read drops every bookmark until a later read succeeds", async () => {
  const errors = [];
  const S = stubs({ tree: root(bm("a", "http://a.test/")) });
  const w = watchBookmarkSpaces({ ...S, onError: e => errors.push(e) });
  await w.ready;
  S.fail = "no such table";
  S.notify("workspace-bookmarks-updated");
  await w.ready;
  assert.equal(w.state, "failed");
  assert.deepEqual(view(w.lookup("http://a.test/")), CLOSED);
  assert.match(errors[0], /no such table/);
  S.fail = null;
  S.notify("workspace-bookmarks-updated");
  await w.ready;
  assert.equal(w.state, "ready");
  assert.deepEqual(view(w.lookup("http://a.test/")), NO_SPACE);
  w.stop();
});

test("without a browser window yet it waits for one", async () => {
  const S = stubs({ assignments: { perso: ["a"] }, tree: root(bm("a", "http://a.test/")), withWindow: false });
  const w = watchBookmarkSpaces(S);
  await tick();
  assert.equal(w.state, "loading");
  assert.deepEqual(view(w.lookup("http://a.test/")), CLOSED);
  const win = S.addWindow();
  S.notify("browser-delayed-startup-finished", win);
  await w.ready;
  assert.equal(w.state, "ready");
  assert.deepEqual(view(w.lookup("http://a.test/")), at(["perso"]));
  w.stop();
});

test("closed windows are not read from", async () => {
  const S = stubs({ assignments: { perso: ["a"] }, tree: root(bm("a", "http://a.test/")) });
  S.windows[0].closed = true;
  const w = watchBookmarkSpaces(S);
  await tick();
  assert.equal(S.reads, 0);
  assert.equal(w.state, "loading");
  w.stop();
});

test("stop removes every observer and ignores later changes", async () => {
  const S = stubs({ tree: root(bm("a", "http://a.test/")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  w.stop();
  assert.equal(S.observerCount(), 0);
  const reads = S.reads;
  S.notify("workspace-bookmarks-updated");
  S.emit({ type: "bookmark-added" });
  await tick();
  assert.equal(S.reads, reads);
});

// R26: bookmark titles per url, so a bookmark row's own title can be told
// from the shared page title.
const titled = (guid, uri, title) => ({ guid, uri, title });

test("urlTitles: every non-empty bookmark title of a url, in any folder", () => {
  const map = urlTitles(
    root(
      titled("a", "http://a.test/", "One"),
      folder("f", titled("b", "http://a.test/", "Two"), titled("c", "http://a.test/", "")),
      titled("d", "http://d.test/", undefined)
    )
  );
  assert.deepEqual(sorted(map.get("http://a.test/")), ["One", "Two"]);
  assert.equal(map.get("http://d.test/"), undefined);
});

test("titles(url) answers bookmark titles without any space assignment", async () => {
  const S = stubs({ tree: root(titled("a", "http://a.test/", "Mine")) });
  const w = watchBookmarkSpaces(S);
  assert.equal(w.titles("http://a.test/"), null, "not known before the first read");
  await w.ready;
  assert.deepEqual(sorted(w.titles("http://a.test/")), ["Mine"]);
  assert.deepEqual(sorted(w.titles("http://b.test/")), []);
  w.stop();
});

test("a bookmark title change refreshes the titles", async () => {
  const S = stubs({ tree: root(titled("a", "http://a.test/", "Old")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  S.tree = root(titled("a", "http://a.test/", "New"));
  S.emit({ type: "bookmark-title-changed" });
  await w.ready;
  assert.deepEqual(sorted(w.titles("http://a.test/")), ["New"]);
  w.stop();
});

test("a failed read forgets the titles: they are not known", async () => {
  const S = stubs({ tree: root(titled("a", "http://a.test/", "Mine")) });
  const w = watchBookmarkSpaces(S);
  await w.ready;
  S.fail = "boom";
  S.emit({ type: "bookmark-added" });
  await w.ready;
  assert.equal(w.titles("http://a.test/"), null);
  w.stop();
});
