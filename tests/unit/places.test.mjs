import test from "node:test";
import assert from "node:assert/strict";
import { ContainerIndex } from "../../src/lib/index.mjs";
import { loadIndex, watchPlaces } from "../../src/glue/places.sys.mjs";

// A stub of PlacesUtils: promiseDBConnection().execute(sql, params, onRow)
// (Sqlite.sys.mjs) over a fixed table of [url, ucid] rows, and observers.
function stubPlaces(rows) {
  const listeners = [];
  let gate = null;
  const P = {
    rows,
    hold() {
      let open;
      gate = new Promise(r => (open = r));
      return () => open();
    },
    promiseDBConnection: async () => ({
      async execute(sql, params, onRow) {
        if (gate) {
          await gate;
        }
        const hits = params?.url ? P.rows.filter(([u]) => u === params.url) : P.rows;
        for (const [url, ucid] of hits) {
          onRow({ getResultByName: n => (n === "url" ? url : ucid) });
        }
      },
    }),
    observers: {
      addListener: (types, fn) => listeners.push(fn),
      removeListener: (types, fn) => listeners.splice(listeners.indexOf(fn), 1),
    },
    emit: (...events) => listeners.forEach(fn => fn(events)),
    listenerCount: () => listeners.length,
  };
  return P;
}
const tick = () => new Promise(r => setTimeout(r, 0));

test("loadIndex reads every url and container", async () => {
  const index = new ContainerIndex();
  await loadIndex(index, stubPlaces([["http://a.test/", 0], ["http://a.test/", 6], ["http://b.test/", 6]]));
  assert.deepEqual([...index.urlContainers("http://a.test/")], [0, 6]);
  assert.deepEqual([...index.urlContainers("http://b.test/")], [6]);
});

test("a container-less row counts as container 0", async () => {
  const index = new ContainerIndex();
  await loadIndex(index, stubPlaces([["http://a.test/", null]]));
  assert.deepEqual([...index.urlContainers("http://a.test/")], [0]);
});

test("visits, removals and clears update the index", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([]);
  const w = watchPlaces(index, P);
  P.emit({ type: "page-visited", url: "http://a.test/", userContextId: 6 });
  assert.deepEqual([...index.urlContainers("http://a.test/")], [6]);
  P.emit({ type: "page-removed", url: "http://a.test/", isPartialVisistsRemoval: false });
  assert.equal(index.urlContainers("http://a.test/"), undefined);
  P.emit({ type: "page-visited", url: "http://b.test/", userContextId: 0 });
  P.emit({ type: "history-cleared" });
  assert.equal(index.urlCount, 0);
  w.stop();
  assert.equal(P.listenerCount(), 0);
});

test("a partial removal re-reads the containers left", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([["http://a.test/", 0]]);
  watchPlaces(index, P);
  index.addVisit("http://a.test/", 6);
  index.addVisit("http://a.test/", 0);
  P.emit({ type: "page-removed", url: "http://a.test/", isPartialVisistsRemoval: true });
  await tick();
  assert.deepEqual([...index.urlContainers("http://a.test/")], [0]);
});

test("a visit event without a container re-reads the page", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([["http://a.test/", 6]]);
  watchPlaces(index, P);
  P.emit({ type: "page-visited", url: "http://a.test/" });
  await tick();
  assert.deepEqual([...index.urlContainers("http://a.test/")], [6]);
});

test("a load that straddles a history clear adds nothing stale", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([["http://a.test/", 0]]);
  const w = watchPlaces(index, P);
  const open = P.hold();
  const view = w.snapshot();
  const loading = loadIndex(index, P, { isCurrent: view.isCurrent });
  P.emit({ type: "history-cleared" });
  open();
  await loading;
  view.release();
  assert.equal(index.urlCount, 0);
});

test("a load that straddles a page removal skips only that page", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([["http://a.test/", 0], ["http://b.test/", 0]]);
  const w = watchPlaces(index, P);
  const open = P.hold();
  const view = w.snapshot();
  const loading = loadIndex(index, P, { isCurrent: view.isCurrent });
  P.emit({ type: "page-removed", url: "http://a.test/", isPartialVisistsRemoval: false });
  open();
  await loading;
  view.release();
  assert.equal(index.urlContainers("http://a.test/"), undefined);
  assert.deepEqual([...index.urlContainers("http://b.test/")], [0]);
});

test("purge-caches reloads the index from Places", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([["http://a.test/", 6]]);
  watchPlaces(index, P);
  index.addVisit("http://gone.test/", 0);
  P.emit({ type: "purge-caches" });
  await tick();
  assert.equal(index.urlContainers("http://gone.test/"), undefined);
  assert.deepEqual([...index.urlContainers("http://a.test/")], [6]);
});

// Firefox announces a visit it did not store (history flooding prevention,
// a URL with credentials) with visit id 0 and container 0, whatever the
// container of the tab (toolkit/components/places/History.cpp
// NotifyOriginRestrictedVisit, NotifyVisitIfHavingUserPass).
test("a visit Places did not store adds no container", async () => {
  const index = new ContainerIndex();
  const P = stubPlaces([["http://a.test/", 6]]);
  watchPlaces(index, P);
  P.emit({ type: "page-visited", url: "http://a.test/", userContextId: 6, visitId: 1 });
  P.emit({ type: "page-visited", url: "http://a.test/", userContextId: 0, visitId: 0 });
  P.emit({ type: "page-visited", url: "http://a.test/never-stored", userContextId: 0, visitId: 0 });
  await tick();
  assert.deepEqual([...index.urlContainers("http://a.test/")], [6]);
  assert.equal(index.urlContainers("http://a.test/never-stored"), undefined);
  assert.deepEqual([...index.originContainers("http://a.test/")], [6]);
});

test("a stored visit in a container reaches the index at once", () => {
  const index = new ContainerIndex();
  const P = stubPlaces([]);
  watchPlaces(index, P);
  P.emit({ type: "page-visited", url: "http://a.test/", userContextId: 6, visitId: 12 });
  assert.deepEqual([...index.urlContainers("http://a.test/")], [6]);
});
