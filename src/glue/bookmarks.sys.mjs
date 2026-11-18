// Zen's bookmark-to-space assignment, cached so the address-bar hook can ask
// synchronously. Zen 1.24.2b keeps it in zen_bookmarks_workspaces (one row per
// bookmark guid and space uuid) and reads it through
// window.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace()
// (zen-components/ZenSpaceBookmarksStorage.js:192-209), a read on the
// read-only Places connection. The bookmark dialog writes it through
// PlacesUIUtils BookmarkState.updateBookmarkWorkspaces(), which then notifies
// "workspace-bookmarks-updated" (moz-src/browser/components/places/
// PlacesUIUtils.sys.mjs:342-393); ZenSpaceManager.mjs:171-177 refreshes its own
// cache on that topic. Nothing here writes.

const ZEN_TOPIC = "workspace-bookmarks-updated";
// A browser window finished starting, so its ZenWorkspaceBookmarksStorage
// exists (the script runs while the window loads).
const WINDOW_TOPIC = "browser-delayed-startup-finished";
// Bookmark changes can change which bookmarks a url has, or where they sit.
const PLACES_EVENTS = [
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-url-changed",
  "bookmark-guid-changed",
  "bookmark-title-changed",
  "purge-caches",
];
const NO_TITLES = Object.freeze(new Set());

function intersect(a, b) {
  return new Set([...a].filter(x => b.has(x)));
}

// For each url with at least one bookmark in a space: `{ spaces, unassigned }`,
// the union of its bookmarks' spaces and whether one of its bookmarks is in no
// space (R21: a url is judged over all its bookmarks). Urls whose bookmarks
// are all in no space are left out. `tree` is
// PlacesUtils.promiseBookmarksTree() (gre/modules/PlacesUtils.sys.mjs:1726,
// which leaves tag folders out); `assigned` maps a bookmark or folder guid to
// its spaces. A folder's spaces cover what is inside it, and nested
// assignments intersect: Zen's toolbar hides a folder outside its spaces
// (browserPlacesViews.js:350-355, :1096-1099, ZenSpaceManager.mjs:3410-3431),
// so its content shows only where both allow it.
export function urlSpaces(tree, assigned) {
  const urls = new Map();
  const entry = url => {
    let e = urls.get(url);
    if (!e) {
      e = { spaces: new Set(), unassigned: false, assigned: false };
      urls.set(url, e);
    }
    return e;
  };
  const walk = (node, inherited) => {
    const own = assigned.get(node.guid);
    const effective = own ? (inherited ? intersect(inherited, own) : own) : inherited;
    if (node.uri) {
      const e = entry(node.uri);
      if (effective === null) {
        e.unassigned = true;
      } else {
        e.assigned = true;
        for (const space of effective) {
          e.spaces.add(space);
        }
      }
    }
    for (const child of node.children ?? []) {
      walk(child, effective);
    }
  };
  walk(tree, null);
  const result = new Map();
  for (const [url, { spaces, unassigned, assigned: any }] of urls) {
    if (any) {
      result.set(url, { spaces, unassigned });
    }
  }
  return result;
}

// For each bookmarked url, its bookmarks' non-empty titles (ruling R26: a
// bookmark row's own title is per bookmark, unlike the page title). `tree` is
// PlacesUtils.promiseBookmarksTree(), whose nodes carry `title`
// (gre/modules/PlacesUtils.sys.mjs:104).
export function urlTitles(tree) {
  const titles = new Map();
  const walk = node => {
    if (node.uri && typeof node.title === "string" && node.title) {
      let set = titles.get(node.uri);
      if (!set) {
        set = new Set();
        titles.set(node.uri, set);
      }
      set.add(node.title);
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(tree);
  return titles;
}

function byGuid(byWorkspace) {
  const assigned = new Map();
  for (const [space, guids] of Object.entries(byWorkspace ?? {})) {
    for (const guid of guids) {
      let set = assigned.get(guid);
      if (!set) {
        set = new Set();
        assigned.set(guid, set);
      }
      set.add(space);
    }
  }
  return assigned;
}

// The assignment is per profile; any open browser window's storage reads it.
function findStorage(Services) {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed && win.ZenWorkspaceBookmarksStorage) {
      return win.ZenWorkspaceBookmarksStorage;
    }
  }
  return null;
}

// Keeps the url -> spaces cache in step with Zen and Places. `lookup(url)`
// answers synchronously with `{ spaces, unassigned }` (see urlSpaces; a url
// with no bookmark in a space gets no spaces and `unassigned: true`). Until
// the first read succeeds, or after a failed read, it answers no spaces and
// `unassigned: false`, so every bookmark is dropped (fail closed). `state` is
// "loading", "ready" or "failed"; `ready` settles once the reads asked for so
// far are done.
export function watchBookmarkSpaces({ PlacesUtils, Services, onError = () => {} }) {
  let map = null;
  let titles = null;
  let state = "loading";
  let stopped = false;
  let running = null;
  let dirty = false;

  async function load() {
    const storage = findStorage(Services);
    if (!storage) {
      return; // still loading; WINDOW_TOPIC asks again
    }
    const assigned = byGuid(await storage.getBookmarkGuidsByWorkspace());
    // Read even without assignments: the titles are needed either way.
    const tree = await PlacesUtils.promiseBookmarksTree();
    const next = assigned.size ? urlSpaces(tree, assigned) : new Map();
    const nextTitles = urlTitles(tree);
    if (!stopped) {
      map = next;
      titles = nextTitles;
      state = "ready";
    }
  }

  function refresh() {
    if (stopped) {
      return;
    }
    if (running) {
      dirty = true;
      return;
    }
    running = (async () => {
      do {
        dirty = false;
        try {
          await load();
        } catch (e) {
          if (!stopped) {
            map = null;
            titles = null;
            state = "failed";
            onError(`reading Zen's bookmark spaces failed, bookmarks hidden: ${e}`);
          }
        }
      } while (dirty && !stopped);
      running = null;
    })();
  }

  // A change while a read runs is read again, so `state` stays "loading"
  // until the cache has caught up with every change seen so far.
  const onChange = () => {
    if (!stopped) {
      state = "loading";
      refresh();
    }
  };
  const onWindow = () => {
    if (state !== "ready") {
      refresh();
    }
  };

  Services.obs.addObserver(onChange, ZEN_TOPIC);
  Services.obs.addObserver(onWindow, WINDOW_TOPIC);
  PlacesUtils.observers.addListener(PLACES_EVENTS, onChange);
  refresh();

  return {
    lookup(url) {
      if (map === null) {
        return { spaces: new Set(), unassigned: false };
      }
      return map.get(url) ?? { spaces: new Set(), unassigned: true };
    },
    // The url's non-empty bookmark titles; null before the first read or
    // after a failed one, when they are not known.
    titles(url) {
      if (titles === null) {
        return null;
      }
      return titles.get(url) ?? NO_TITLES;
    },
    get state() {
      return state;
    },
    get ready() {
      return running ?? Promise.resolve();
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      Services.obs.removeObserver(onChange, ZEN_TOPIC);
      Services.obs.removeObserver(onWindow, WINDOW_TOPIC);
      PlacesUtils.observers.removeListener(PLACES_EVENTS, onChange);
      map = null;
      titles = null;
    },
  };
}
