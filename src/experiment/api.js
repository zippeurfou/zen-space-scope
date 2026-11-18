// Parent-process side of the add-on. This ext-*.js sandbox has no URL
// constructor (gre/modules/ExtensionCommon.sys.mjs:1823-1866), so the logic
// lives in modules loaded through resource://zen-space-scope-<version>/,
// which maps to the add-on root. Those modules keep no state of their own:
// all of it lives here, so a disable and re-enable starts clean.

/* globals ExtensionAPI, ChromeUtils, Services, Cc, Ci */
"use strict";

const NAME = "zen-space-scope";
// Modules stay cached per URL for the life of the process, so each version
// gets its own resource host and an in-place update loads its own modules.
const hostFor = version => `${NAME}-${String(version).replace(/[^A-Za-z0-9]/g, "-")}`;
const MODULES = {
  index: "src/lib/index.mjs",
  rules: "src/lib/rules.mjs",
  describe: "src/glue/describe.sys.mjs",
  hook: "src/glue/hook.sys.mjs",
  places: "src/glue/places.sys.mjs",
  bookmarks: "src/glue/bookmarks.sys.mjs",
  scope: "src/glue/scope.sys.mjs",
  tabs: "src/glue/tabs.sys.mjs",
  view: "src/glue/view.sys.mjs",
  prefs: "src/glue/prefs.sys.mjs",
  selfcheck: "src/glue/selfcheck.sys.mjs",
};
// Zen 1.24.2b internals.
const INTERNALS = {
  Query: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
};
// History providers asked for more candidates while scoping (hook.sys.mjs,
// "Keeping lists full"). Missing ones only make lists shorter, never leak.
const WIDENED = {
  Places: [
    "UrlbarProviderPlaces",
    "moz-src:///browser/components/urlbar/UrlbarProviderPlaces.sys.mjs",
  ],
  InputHistory: [
    "UrlbarProviderInputHistory",
    "moz-src:///browser/components/urlbar/UrlbarProviderInputHistory.sys.mjs",
  ],
};
const LOG_LIMIT = 2000;
// A bookmark lookup answer that drops every bookmark row.
const NO_BOOKMARK = Object.freeze({ spaces: new Set(), unassigned: false });

// The one shape of the status, for a running add-on and for one that shut down.
const statusOf = ({
  version,
  state,
  failedChecks = [],
  conflicts = [],
  urlCount = 0,
  bookmarks = "loading",
  debug = false,
  canRetry = false,
}) => ({
  state,
  failedChecks: [...failedChecks],
  conflicts,
  urlCount,
  bookmarks,
  debug,
  canRetry,
  version,
});

const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(
  Ci.nsISubstitutingProtocolHandler
);

// Fail closed (docs/design.md; rulings R19, R23, R25, R27). History-based
// suggestions are on only while the state is "active"; the user.js block keeps
// them off at every startup, and src/glue/prefs.sys.mjs is the only writer.
//
//   starting    -> active       the hook and view guards are in, the
//                                self-check passed, the prefs are turned on
//   starting    -> fail-closed  a module, an internal, the index, the hook,
//                                a view guard or a self-check failed, or the
//                                activation threw ("activation")
//   active      -> fail-closed  a later failure: a bookmark read, a window
//                                that cannot be guarded, or the self-check
//                                run for a window opened later
//   active, fail-closed -> disabled   setEnabled(false)
//   disabled, fail-closed -> starting setEnabled(true) runs the checks again
//   any         -> shut down    the add-on is disabled, removed or updated,
//                                or Zen quits
//
// Every way out of "active" turns the prefs off first and empties the
// address bars' replay caches and rows. A failure keeps the hook and the
// view guards in place, since they only ever remove rows. getStatus() waits for start-up to
// end, so it reports "starting" only while setEnabled(true) runs the checks
// again.
const whereOf = scope =>
  scope?.error
    ? `no space (${scope.error})`
    : `space ${JSON.stringify(scope.spaceName)} ucid ${scope.ucid}`;

function decisionLine({ keep, kind, reason, d }) {
  let line = `  ${keep ? "keep" : "drop"} ${kind} ${d.provider} ${d.url ?? "-"}: ${reason}`;
  if (kind === "UNKNOWN") {
    line += ` [type ${d.type}, source ${d.source}, heuristic ${d.heuristic}, autofill ${d.autofillType}]`;
  }
  return line;
}

class Scoper {
  constructor(rootURI, version) {
    this.rootURI = rootURI;
    this.version = version;
    this.host = hostFor(version);
    this.state = "starting";
    this.failedChecks = [];
    this.debug = false;
    this.log = [];
    this.index = null;
    this.watcher = null;
    this.bookmarks = null;
    this.hook = null;
    this.views = null;
    this.notices = null;
    // Spaces that share a container (containerConflicts), and the key of the
    // conflict notice on screen.
    this.conflicts = [];
    this.conflictNotice = null;
    this.conflictWatch = null;
    this.conflictKey = "";
    this.startPromise = null;
    this.stopped = false;
    // Modules, internals and the index are in, so the checks can run again.
    this.loaded = false;
    // Bumped by every activation, disable and shutdown; an activation or a
    // check that finds it changed drops its outcome.
    this.run = 0;
    this.windowWaiters = new Set();
  }

  record(line) {
    this.log.push(line);
    if (this.log.length > LOG_LIMIT) {
      this.log.splice(0, this.log.length - LOG_LIMIT);
    }
  }

  error(message) {
    console.error(`[${NAME}] ${message}`);
    this.record(`error: ${message}`);
  }

  start() {
    this.startPromise ??= this.init().catch(e => {
      this.fail("start", e);
    });
    return this.startPromise;
  }

  // Turns the guarded prefs off as far as it can; never throws.
  suggestionsOff() {
    try {
      this.m?.prefs?.setSuggestions(false, Services);
    } catch (e) {
      this.error(String(e));
    }
  }

  fail(check, e) {
    this.error(`check ${check} failed: ${e}`);
    if (this.stopped || this.state === "disabled") {
      return;
    }
    this.suggestionsOff();
    this.clearViews();
    if (!this.failedChecks.includes(check)) {
      this.failedChecks.push(check);
    }
    this.state = "fail-closed";
    this.notices?.show(this.failedChecks, { canRetry: this.loaded });
  }

  async init() {
    resProto.setSubstitution(this.host, this.rootURI);
    const m = {};
    for (const [key, path] of Object.entries(MODULES)) {
      m[key] = ChromeUtils.importESModule(`resource://${this.host}/${path}`);
    }
    this.m = m;
    // user.js has them off already; this also covers a profile without the
    // block, or prefs a crash left on.
    this.suggestionsOff();
    this.notices = m.selfcheck.watchNotices({ Services, onError: msg => this.error(msg) });
    this.conflictNotice = m.selfcheck.watchConflictNotice({
      Services,
      onError: msg => this.error(msg),
    });
    this.conflictWatch = m.scope.watchConflicts({
      Services,
      onChange: () => this.refreshConflicts(),
    });
    const lib = {};
    for (const [name, url] of Object.entries(INTERNALS)) {
      try {
        lib[name] = ChromeUtils.importESModule(url)[name];
      } catch (e) {
        this.fail("hook-installed", `cannot import ${name} from ${url}: ${e}`);
        return;
      }
    }
    lib.widen = {};
    for (const [key, [name, url]] of Object.entries(WIDENED)) {
      try {
        lib.widen[key] = ChromeUtils.importESModule(url)[name];
      } catch (e) {
        this.error(`cannot import ${name} from ${url}, its lists may be shorter: ${e}`);
      }
    }
    this.lib = lib;

    this.index = new m.index.ContainerIndex();
    this.watcher = m.places.watchPlaces(this.index, lib.PlacesUtils, {
      onError: msg => this.error(msg),
    });
    // Bookmarks stay hidden until their spaces are read (the lookup fails
    // closed while loading), so start-up does not wait for them.
    this.watchBookmarks();
    const view = this.watcher.snapshot();
    try {
      await m.places.loadIndex(this.index, lib.PlacesUtils, { isCurrent: view.isCurrent });
    } catch (e) {
      this.fail("history-container-column", e);
      return;
    } finally {
      view.release();
    }
    if (this.stopped) {
      return;
    }
    this.loaded = true;
    await this.activate();
  }

  watchBookmarks() {
    this.bookmarks?.stop();
    this.bookmarks = this.m.bookmarks.watchBookmarkSpaces({
      PlacesUtils: this.lib.PlacesUtils,
      Services,
      // Called only when a read fails (ruling R23).
      onError: msg => this.fail("bookmark-spaces", msg),
    });
  }

  // Installs the hook and the view guards, runs the self-check, and turns
  // the suggestions on if all of it passed. Two spaces in one container are a
  // warning, not a failed check: the add-on still scopes, but cannot tell
  // those spaces apart.
  async activate() {
    const run = this.run + 1; // the one runActivation takes
    try {
      await this.runActivation();
    } catch (e) {
      // Nothing planned for this: fail closed rather than stay at "starting"
      // (ruling R40). A newer activation or a disable has taken over if the
      // run moved on.
      if (run === this.run) {
        this.fail("activation", e);
      } else {
        this.error(`an activation that was replaced failed: ${e}`);
      }
    } finally {
      this.refreshConflicts();
    }
  }

  async runActivation() {
    const run = ++this.run;
    this.state = "starting";
    this.failedChecks = [];
    this.notices?.clear();
    this.suggestionsOff();
    this.uninstallHook();
    if (this.bookmarks?.state === "failed") {
      this.watchBookmarks();
    }
    this.install();
    if (!this.failedChecks.length) {
      const win = await this.readyWindow();
      if (run !== this.run) {
        return;
      }
      const { failed, errors } = await this.selfCheck(win);
      if (run !== this.run) {
        return;
      }
      for (const check of failed) {
        this.fail(check, errors[check]);
      }
    }
    if (this.failedChecks.length) {
      return;
    }
    try {
      this.m.prefs.setSuggestions(true, Services);
    } catch (e) {
      this.fail("suggestion-prefs", e);
      return;
    }
    this.state = "active";
  }

  // Over every started browser window, also one that starts while the
  // checks run (selfcheck.sys.mjs, runSelfCheckOnEveryWindow).
  selfCheck(win) {
    return this.m.selfcheck.runSelfCheckOnEveryWindow({
      win,
      readyWindows: () => this.readyWindows(),
      Query: this.lib.Query,
      PlacesUtils: this.lib.PlacesUtils,
      UrlbarShared: this.lib.UrlbarShared,
      hook: this.hook,
      views: this.views,
      bookmarks: this.bookmarks,
    });
  }

  // The self-check again once a window opened later is guarded.
  async recheck(win) {
    if (this.state !== "active") {
      return;
    }
    const run = this.run;
    const { failed, errors } = await this.selfCheck(win);
    if (run !== this.run || this.state !== "active") {
      return;
    }
    for (const check of failed) {
      this.fail(check, errors[check]);
    }
  }

  install() {
    try {
      this.hook = this.m.hook.installHook({
        Query: this.lib.Query,
        captureScope: query => this.scopeOf(query),
        decideFor: (query, provider, result, scope) => {
          const verdict = this.decideFor(provider, result, scope);
          if (verdict.keep) {
            this.retitle(result, verdict, scope);
          }
          return verdict;
        },
        onQueryDone: (query, stats) => this.onQueryDone(query, stats),
        widen: this.lib.widen,
      });
      for (const key of Object.keys(WIDENED)) {
        if (this.lib.widen[key] && !this.hook.widened.includes(WIDENED[key][0])) {
          this.error(`${WIDENED[key][0]} was not widened, its lists may be shorter`);
        }
      }
    } catch (e) {
      this.fail("hook-installed", e);
      return;
    }
    // Rows the view replays from its caches never reach the hook.
    try {
      this.views = this.m.view.installViewGuards({
        Services,
        scopeFor: win => this.m.scope.activeScope(win),
        decideFor: (scope, result) => this.decideFor(null, result, scope).keep,
        onDropped: (scope, rows) => this.onViewDropped(scope, rows),
        onError: msg => this.error(msg),
        onGuardFailed: (win, e) => {
          this.fail("view-guard", e);
          this.wakeWaiters(win);
        },
        onGuarded: win => {
          if (!this.windowWaiters.size) {
            this.recheck(win);
          } else if (!this.m.scope.isSpaceless(win)) {
            // An activation waits for a window with a space (readyWindow).
            this.wakeWaiters(win);
          }
        },
      });
    } catch (e) {
      this.fail("view-guard", e);
    }
  }

  // Reads the spaces of a window that has the user's (ruling R37: a popup
  // has none, a private or unsynced window only Zen's placeholder, which
  // would read as "no conflict") and keeps the conflict notice in step:
  // shown while spaces conflict and the add-on is not turned off. Without
  // such a window the last answer stands. Never throws.
  refreshConflicts() {
    if (this.stopped || !this.m) {
      return;
    }
    try {
      const win = this.readyWindows().find(w => !this.m.scope.isSpaceless(w));
      if (!win) {
        return;
      }
      this.conflicts = this.m.scope.containerConflicts(win);
    } catch (e) {
      this.error(`reading the spaces' containers failed: ${e}`);
      return;
    }
    const key = this.conflicts.length && this.state !== "disabled" ? JSON.stringify(this.conflicts) : "";
    if (key === this.conflictKey) {
      return;
    }
    this.conflictKey = key;
    if (key) {
      this.conflictNotice?.show(this.conflicts);
    } else {
      this.conflictNotice?.clear();
    }
  }

  readyWindows() {
    const wins = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (!w.closed && w.gBrowserInit?.delayedStartupFinished) {
        wins.push(w);
      }
    }
    return wins;
  }

  // A started browser window that has the user's spaces (ruling R37): the
  // most recent one, or else any, or else the first one to start, once its
  // view guard is in (or a window's guard failed). Null if the add-on shuts
  // down first. While only popups, private or unsynced windows are open the
  // add-on keeps waiting, with suggestions off; those windows show no
  // history-based suggestion either way.
  readyWindow() {
    const usable = w =>
      w && !w.closed && w.gBrowserInit?.delayedStartupFinished && !this.m.scope.isSpaceless(w);
    const recent = Services.wm.getMostRecentWindow("navigator:browser");
    if (usable(recent)) {
      return recent;
    }
    const any = this.readyWindows().find(usable);
    if (any) {
      return any;
    }
    return new Promise(resolve => this.windowWaiters.add(resolve));
  }

  wakeWaiters(win) {
    const waiters = [...this.windowWaiters];
    this.windowWaiters.clear();
    for (const resolve of waiters) {
      resolve(win);
    }
  }

  // Drops what the address bars could replay or still show: the cached
  // query contexts (UrlbarView.mjs:853-854, :896-901) and the rows of the
  // last query, which the view reopens as they are when the input still
  // holds their search string (:884-889, :927-933). Called on every way out
  // of "active"; on a disable or shutdown, before the view guards go, since
  // nothing filters a replay after that.
  clearViews() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      try {
        const view = win.gURLBar?.view;
        view?.queryContextCache?.clear?.();
        view?.close?.();
        view?.clear?.();
      } catch (e) {
        this.error(`clearing an address bar failed: ${e}`);
      }
    }
  }

  uninstallHook() {
    this.hook?.uninstall();
    this.hook = null;
    this.views?.uninstall();
    this.views = null;
  }

  // Places keeps one title per url for every container (ruling R24). A kept
  // switch-to-tab row shows its own tab's label. A Places-titled row keeps
  // its title only when the title's source (the url, or the whole origin for
  // origin autofill) was visited in the active container and in no other
  // (ruling R36, titlePolicy); otherwise it shows no title and the view falls
  // back to the url's host (UrlbarResult.mjs:488-509). A bookmark row showing
  // its bookmark's own title keeps it (ruling R26). The result is an
  // in-memory object about to be rendered; nothing is written back.
  retitle(result, { kind, d }, scope) {
    const payload = result.payload;
    if (!payload || typeof d?.url !== "string") {
      return;
    }
    const { KIND, titlePolicy } = this.m.rules;
    let policyKind = kind;
    if (kind === KIND.SWITCH_TAB) {
      const label = this.m.tabs.openTabLabel(this.windowsFor(scope?.win), d.url, d.tabContainer);
      if (label) {
        payload.title = label;
        return;
      }
      // No open tab to read: the title is Places', like a history row's.
      policyKind = KIND.HISTORY;
    }
    const about = {
      ucid: scope?.error ? undefined : scope?.ucid,
      title: payload.title,
      bookmarkTitles: this.bookmarks?.titles(d.url) ?? undefined,
      titleBookmarks: this.titleBookmarks(policyKind, d.url, scope),
    };
    if (titlePolicy(policyKind, d.url, this.index, about) === "blank" && payload.title) {
      payload.title = "";
      if (this.debug) {
        this.record(`  title blanked ${policyKind} ${d.url}: ${this.blankReason(policyKind, d.url, about)}`);
      }
    }
  }

  // For each url an autofill row's title can come from, its bookmark titles
  // and whether its bookmarks show in the scope's space (ruling R43); null
  // while the bookmark titles are not known.
  titleBookmarks(kind, url, scope) {
    const { titleBookmarkUrls, bookmarkVisible } = this.m.rules;
    const urls = titleBookmarkUrls(kind, url);
    if (!urls.length) {
      return [];
    }
    if (!this.bookmarks) {
      return null;
    }
    const ctx = this.ctxOf(scope);
    const sources = [];
    for (const u of urls) {
      const titles = this.bookmarks.titles(u);
      if (titles === null) {
        return null;
      }
      if (titles.size) {
        sources.push({ titles, visible: bookmarkVisible(u, ctx) });
      }
    }
    return sources;
  }

  // Why a title was blanked, for the debug log.
  blankReason(kind, url, about) {
    const { KIND, autofillBookmarkTitle } = this.m.rules;
    if (kind === KIND.AUTOFILL_URL || kind === KIND.AUTOFILL_ORIGIN) {
      if (about.titleBookmarks === null) {
        return "bookmark titles not known";
      }
      if (autofillBookmarkTitle(about.title, about.titleBookmarks) === "blank") {
        return "a title of bookmarks this space does not show";
      }
    }
    // The containers the index holds for the title's source.
    const seen =
      kind === KIND.AUTOFILL_ORIGIN ? this.index.originContainers(url) : this.index.urlContainers(url);
    return `visited in containers [${[...(seen ?? [])].join(", ")}]`;
  }

  // The query's window first, then the other browser windows of the same
  // private-browsing kind.
  windowsFor(win) {
    const isPrivate = w => this.lib.PrivateBrowsingUtils.isWindowPrivate(w);
    const wins = win ? [win] : [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w !== win && !w.closed && (!win || isPrivate(w) === isPrivate(win))) {
        wins.push(w);
      }
    }
    return wins;
  }

  // The window the query runs in: UrlbarParentController.browserWindow
  // (UrlbarParentController.sys.mjs:178-182). A query without a controller
  // (UrlbarProvidersManager.sys.mjs:428; paste-and-go, drop-and-go and Enter
  // with no row, UrlbarParentController.sys.mjs:259-262) has no window to
  // take a space from, so it gets no scope and keeps only allowlisted kinds.
  // So does a query in a window without a space of its own (ruling R37,
  // scope.sys.mjs).
  scopeOf(query) {
    const win = query.controller?.browserWindow;
    if (!win) {
      return { error: "the query has no window" };
    }
    return { ...this.m.scope.activeScope(win), win };
  }

  decideFor(provider, result, scope) {
    const d = this.m.describe.describe(provider, result, this.lib.UrlbarShared);
    return { ...this.m.rules.decide(d, this.ctxOf(scope)), d };
  }

  // The rules' context for a query's scope. Without a scope nothing matches,
  // so only the allowlisted kinds pass.
  ctxOf(scope) {
    return scope?.error
      ? { ucid: -1, spaceId: "", index: this.emptyIndex(), bookmarkSpaces: () => NO_BOOKMARK }
      : {
          ucid: scope.ucid,
          spaceId: scope.spaceId,
          index: this.index,
          bookmarkSpaces: url => (this.bookmarks ? this.bookmarks.lookup(url) : NO_BOOKMARK),
        };
  }

  emptyIndex() {
    this.empty ??= new this.m.index.ContainerIndex();
    return this.empty;
  }

  onQueryDone(query, { scope, decisions, errors }) {
    for (const e of errors) {
      this.error(`decision failed, result dropped: ${e}`);
    }
    if (!this.debug) {
      return;
    }
    const kept = decisions.filter(v => v.keep).length;
    this.record(
      `query ${JSON.stringify(query.context?.searchString ?? "")} ${whereOf(scope)}: ` +
        `kept ${kept}, dropped ${decisions.length - kept}`
    );
    for (const verdict of decisions) {
      this.record(decisionLine(verdict));
    }
  }

  // Rows the address-bar view removed before rendering (cached or replayed
  // rows that never went through the hook), in the hook's format.
  onViewDropped(scope, rows) {
    if (!this.debug) {
      return;
    }
    this.record(`view ${whereOf(scope)}: dropped ${rows.length}`);
    for (const row of rows) {
      try {
        this.record(decisionLine(this.decideFor(null, row, scope)));
      } catch (e) {
        this.error(`describing a dropped row failed: ${e}`);
      }
    }
  }

  async status() {
    await this.start();
    this.refreshConflicts();
    return statusOf({
      version: this.version,
      state: this.state,
      failedChecks: this.failedChecks,
      conflicts: this.conflicts,
      urlCount: this.index?.urlCount ?? 0,
      bookmarks: this.bookmarks?.state ?? "loading",
      debug: this.debug,
      canRetry: this.loaded && !this.stopped,
    });
  }

  // The debug log holds the urls of every decision, so it goes when debug
  // is turned off (ruling R40).
  setDebug(on) {
    this.debug = !!on;
    if (!this.debug) {
      this.log.length = 0;
    }
  }

  // On runs the checks again, from "disabled" or "fail-closed"; a start-up
  // that failed before the index was in cannot be retried (`canRetry` in the
  // status, and the notice's advice, say so).
  async setEnabled(on) {
    await this.start();
    if (this.stopped || !this.loaded) {
      return this.status();
    }
    if (on) {
      if (this.state !== "active") {
        await this.activate();
      }
    } else {
      this.run++;
      this.suggestionsOff();
      this.clearViews();
      this.uninstallHook();
      this.failedChecks = [];
      this.notices?.clear();
      this.state = "disabled";
      this.refreshConflicts();
    }
    return this.status();
  }

  shutdown() {
    this.stopped = true;
    this.run++;
    this.suggestionsOff();
    this.clearViews();
    this.uninstallHook();
    this.notices?.stop();
    this.conflictNotice?.stop();
    this.conflictWatch?.stop();
    this.conflictWatch = null;
    this.wakeWaiters(null);
    this.watcher?.stop();
    this.watcher = null;
    this.bookmarks?.stop();
    this.bookmarks = null;
    this.index?.clear();
    this.state = "disabled";
    resProto.setSubstitution(this.host, null);
  }
}

this.spaceScope = class extends ExtensionAPI {
  // Null once shut down: an API call after onShutdown must not start a new
  // Scoper, which would hook the address bar again.
  get scoper() {
    if (this.closed) {
      return null;
    }
    this._scoper ??= new Scoper(this.extension.rootURI, this.extension.version);
    return this._scoper;
  }

  onShutdown() {
    this.closed = true;
    this._scoper?.shutdown();
    this._scoper = null;
  }

  getAPI() {
    const version = this.extension.version;
    const closed = async () => statusOf({ version, state: "disabled" });
    return {
      spaceScope: {
        start: () => this.scoper?.status() ?? closed(),
        getStatus: () => this.scoper?.status() ?? closed(),
        setEnabled: on => this.scoper?.setEnabled(on) ?? closed(),
        setDebug: async on => {
          this.scoper?.setDebug(on);
        },
        getLog: async () => [...(this.scoper?.log ?? [])],
      },
    };
  }
};
