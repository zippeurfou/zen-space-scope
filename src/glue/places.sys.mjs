// Keeps a ContainerIndex in step with Places history. Read-only: queries go
// through PlacesUtils.promiseDBConnection(), a read-only clone
// (gre/modules/PlacesUtils.sys.mjs:1579). moz_historyvisits.userContextId is
// the container of each visit (Firefox 160).

const SQL_ALL = `SELECT DISTINCT h.url AS url, v.userContextId AS ucid
  FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id`;
const SQL_ONE = `${SQL_ALL} WHERE h.url_hash = hash(:url) AND h.url = :url`;

const EVENTS = ["page-visited", "page-removed", "history-cleared", "purge-caches"];

async function read(PlacesUtils, sql, params) {
  const db = await PlacesUtils.promiseDBConnection();
  const rows = [];
  await db.execute(sql, params, row => {
    rows.push([row.getResultByName("url"), row.getResultByName("ucid") ?? 0]);
  });
  return rows;
}

// Adds every (url, container) pair of history to `index`. `isCurrent(url)`
// returns false for URLs removed since the read started, whose rows are then
// stale. Throws if the history table has no container column.
export async function loadIndex(index, PlacesUtils, { isCurrent = () => true } = {}) {
  const rows = await read(PlacesUtils, SQL_ALL, null);
  for (const [url, ucid] of rows) {
    if (isCurrent(url)) {
      index.addVisit(url, ucid);
    }
  }
}

// Follows Places events (gre/modules/PlacesUtils.sys.mjs:454 observers;
// page-removed fields at gre/modules/History.sys.mjs:970-978).
// `snapshot()` returns `{ isCurrent(url), release() }` for a read that
// started now, so loadIndex can skip what was removed while it ran.
export function watchPlaces(index, PlacesUtils, { onError = () => {} } = {}) {
  let stopped = false;
  let generation = 0; // bumped when the whole history goes
  let removals = 0; // bumped per removed page
  const removedAt = new Map(); // url -> value of `removals` when removed
  let openSnapshots = 0;

  function snapshot() {
    const gen = generation;
    const seq = removals;
    openSnapshots++;
    let released = false;
    return {
      isCurrent: url =>
        !stopped && gen === generation && !((removedAt.get(url) ?? -1) >= seq),
      release() {
        if (!released && --openSnapshots === 0) {
          removedAt.clear();
        }
        released = true;
      },
    };
  }

  async function guarded(load, what) {
    const view = snapshot();
    try {
      await load(view.isCurrent);
    } catch (e) {
      onError(`${what}: ${e}`);
    } finally {
      view.release();
    }
  }

  // For events that do not carry the containers left for a URL.
  const reread = url =>
    guarded(async isCurrent => {
      for (const [u, ucid] of await read(PlacesUtils, SQL_ONE, { url })) {
        if (isCurrent(u)) {
          index.addVisit(u, ucid);
        }
      }
    }, `re-reading ${url}`);

  function forgetAll() {
    generation++;
    removedAt.clear();
    index.clear();
  }

  function listener(events) {
    for (const event of events) {
      switch (event.type) {
        case "page-visited":
          // Visit id 0: Places announced a visit it did not store, and the
          // event says container 0 whatever the tab's container. Firefox 160
          // does this for a visit that history flooding prevention restricts
          // (toolkit/components/places/History.cpp:2066-2082, then
          // NotifyOriginRestrictedVisit at :1492-1497, a bare VisitData) and
          // for a URL with credentials (NotifyVisitIfHavingUserPass). A stored
          // visit always has an id (:1188-1224). No history row comes from
          // such a visit, so the index ignores it, as the database does.
          if (event.visitId === 0) {
            break;
          }
          if (typeof event.userContextId === "number") {
            index.addVisit(event.url, event.userContextId);
          } else {
            reread(event.url);
          }
          break;
        case "page-removed":
          removedAt.set(event.url, removals++);
          index.removeUrl(event.url);
          // The page lost some visits but keeps others, in unknown containers.
          if (event.isPartialVisistsRemoval) {
            reread(event.url);
          }
          break;
        case "history-cleared":
          forgetAll();
          break;
        case "purge-caches":
          forgetAll();
          guarded(isCurrent => loadIndex(index, PlacesUtils, { isCurrent }), "reloading");
          break;
      }
    }
  }

  PlacesUtils.observers.addListener(EVENTS, listener);
  return {
    snapshot,
    stop() {
      if (!stopped) {
        stopped = true;
        PlacesUtils.observers.removeListener(EVENTS, listener);
      }
    },
  };
}
