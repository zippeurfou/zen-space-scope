# Design

This is how zen-space-scope works and why it is built this way. The README covers install and use. This page is for people who want to check the reasoning or change the code.

Line numbers in code comments point at the Zen 1.24.2b sources. Comments also cite decisions as "ruling R20". Those numbers are resolved in the decision log at the end.

## Problem

Zen spaces can each use a container, so every space has its own cookies and logins. History is not split the same way. The profile has one history, and the address bar suggests from all of it. Type a few letters in a work space while sharing your screen and a page you only opened in a personal space can show up in the dropdown, with its title.

Zen 1.24.2b has no setting for this. But Firefox 160, which it is built on, records the container of every history visit. That is enough to filter the address bar per container.

## Goals

* In each space, the address bar only suggests what that space's container has seen: history, autofill, top sites, "Switch to tab" rows and bookmarks.
* Suggestions inside a space keep working, and dropping other spaces' rows should not leave the list visibly shorter.
* Only kinds known to be safe pass without a container check: search-engine results and suggestions, the typed address, calculator, unit conversion, Zen's own actions and spaces, Firefox's static `about:` pages, and the static restriction labels such as `@history`. Every other kind is dropped unless it can be tied to the active container. That includes kinds a future Zen adds.
* Fail closed, also when the add-on is not running. A missing, disabled, starting or broken add-on means no history-based suggestions, never all of them.
* A warning when two spaces share a container, because the add-on cannot tell them apart.
* A scripted install and uninstall, and an automated test against each new Zen release.

## Non-goals

* The History sidebar, the Library window and the History menu. One profile shares them.
* Other add-ons that search history on their own.
* Search engines or "@" shortcuts per space.
* Setups where several spaces share a container or have none. At most one space can go without a container.
* Regular Firefox and other Firefox-based browsers.
* A listing on addons.mozilla.org. The add-on is privileged and unsigned.

It must also never write to history, bookmarks or any user data, never change the Zen application files, never make a network call of its own, and never make typing wait on a database query.

## How it works

### The container index

At start-up the add-on reads every (URL, container) pair of the visit history through Places' read-only connection, into an in-memory index: URL to containers, and origin to its URLs. Places events (page visited, page removed, history cleared) keep it current. Every decision is then a synchronous lookup, so typing never waits.

Firefox does not store every visit. Once your last click or key press is more than 3 seconds old, its history flooding prevention drops the 4th visit of a site within 5 seconds: a sign-in redirect chain, a page that rewrites its address as you scroll, an app that routes on a timer. Firefox still sends a "page visited" event for it, but with container 0 whatever the tab's container, and a visit id of 0. The index skips every event with a visit id of 0, the same visits the database never got. Before this, such a visit showed a page from a container in the space without a container until Zen restarted. A visit Firefox drops is not suggested anywhere, which is what Firefox does too.

Visits recorded before Firefox 160, imported visits and synced visits all carry container 0. The one space without a container owns them. If every space has a container, container-0 history is hidden everywhere.

### The query hook

Every address-bar provider hands its results to one method, `Query.prototype.add`. The add-on wraps it. It also wraps `start`, to capture the scope when the query begins. The scope is the window's active space and that space's container, read from `gZenWorkspaces`. The selected tab's container would be the wrong source, because it can lag right after a new tab opens.

The hook classifies each result by provider, type and source, then judges it:

| Kind | Kept when |
|---|---|
| History, adaptive history, typed full URL from history | the exact URL was visited in the active container |
| URL autofill | the exact URL was visited there, or it ends in "/" and a URL under it was |
| Origin autofill | any page of the origin was visited there |
| Top site | the exact URL was visited there (a bookmarked one follows the bookmark rule) |
| Switch to tab | the open tab is in the active container |
| Bookmark | see "Bookmarks" below |
| Safe kinds | always |
| Recent searches, past searches (form history), synced tabs, anything unknown | never |

A top site is the most visited page of its site, and its row carries that page's URL and title. So the hook judges it as a page, not as a site. Judging it by site showed one space's page in another space that used the same site.

A query with no window (paste-and-go, drop-and-go) has no space to take, so it keeps only the safe kinds.

### Bookmarks

Zen can assign a bookmark to spaces, and leaves a new bookmark unassigned. A bookmark row is kept when:

* one of the URL's bookmarks is assigned to the active space, or
* one of them is unassigned and the active container visited the page, or
* one of them is unassigned, no container ever visited the page, and the active space is the one without a container.

The add-on reads the assignments from Zen's own storage and caches them. Until the first read succeeds, and after a failed one, it hides every bookmark.

### Titles

Places keeps one title per URL, whatever the container. A webmail inbox opened in two spaces shows the last account that loaded it. So keeping the right rows is not enough. A kept row's title can belong to another space.

A row keeps its Places title only when the containers that visited the title's source are exactly the active one. The source is the row's exact URL, with one exception. An origin autofill takes its title from the site's home page in any of its http, https and www variants, so there the whole origin has to belong to the active container alone. In every other case the add-on blanks the title and the row shows the host.

Two kinds have a title of their own. A "Switch to tab" row shows its tab's label, and a bookmark row keeps the bookmark's own title.

Autofill rows can carry a bookmark's title too. When the page is bookmarked, Firefox takes the title of any of its bookmarks, whatever space the bookmark belongs to. So an autofill title that matches one of the page's bookmark titles stays only when those bookmarks show in the active space. Otherwise the row shows the host. An autofill title that matches no bookmark follows the rule above. Until the add-on has read the bookmarks, and after a failed read, it blanks autofill titles. The add-on judges a page bookmarked in several spaces by all of its bookmarks together. When their names differ, either name can show wherever the page's bookmarks show. A later version may judge titles per bookmark.

### The view guard

Some rows never go through a query. The address-bar view caches recent results per window, not per space, and replays them when the bar opens: the last empty-bar list, recent typed queries, and the rows still in a closed panel. A space switch does not close an open panel either.

So the add-on wraps each window's view too. The guard filters every render again with the window's current scope, and clears the caches and the rows when the scope changes. Zen tells its listeners about a space switch only after the animation, so the guard also wraps the active-space setter to clear the panel at the instant of the switch.

### Keeping lists full

The history providers cap how many candidates they fetch from the number of rows the bar shows. Dropping rows afterwards would leave short lists. For a scoped query the add-on makes those providers fetch ten times more candidates, at most 100. The muxer still cuts the list at the usual length, so the active space's own pages fill the gaps. Nothing waits longer on the database: the providers were already asynchronous.

This is not a guarantee. If other spaces hold most of the top matches, the list can still come out short. The empty-bar top sites are not refilled at all.

### Failing closed

The installer writes a block into the profile's `user.js` that keeps the history-based suggestion prefs off. Zen applies `user.js` at every startup, so the default state of the profile is "no history suggestions". The add-on turns those prefs on only after its self-check passes, and turns them off again on any later failure, when it is switched off, and when it shuts down. The list of guarded prefs lives in `src/guarded-prefs.json`, shared by the add-on, the installer and the tests.

The self-check asks seven things. Is the hook in place? Does Places have the container column? Does the active space resolve in every window that has spaces? Does a synthetic history row that no container visited get dropped, while a typed address is kept? Is every window's view guarded? Is the space-switch wrap in place? Could Zen's bookmark spaces be read? It runs again for every window opened later.

A failure shows a notification naming the failed checks. The hook and the guards stay in place after a failure, since they only ever remove rows.

### Windows without a space

Private windows, unsynced windows and popups (a sign-in or payment window, for example) have none of the user's spaces. Zen gives them a placeholder space in container 0 at most. Treating that placeholder as the space without a container would show container-0 history there. So these windows get no scope: they keep only the safe kinds. The per-space self-checks skip them, so a sign-in popup cannot make the add-on fail closed. The view guard still covers them.

Zen says which windows these are through one getter. If a future Zen drops it, that is a failed check.

### Container conflicts

Everything is keyed on the container. Two spaces in the same container, or two spaces without one, look the same to the add-on. It still filters, but it shows a warning that names those spaces, in a notification and on its options page.

### Install and uninstall

The add-on is a WebExtension Experiment. It needs unsigned add-ons and experiment add-ons allowed, and the `user.js` block turns both on. The same block lets an add-on file in the profile's `extensions` folder start without a prompt. A scripted install depends on that. It also weakens the profile, and the README says so before the install steps.

The install script finds the profile from Zen's own install records and refuses when it cannot be sure: several installs, several data directories, a profile entry that is empty or points at the data directory, or a running Zen. It copies the add-on file first and writes the block second, so a failure in between changes no pref.

Uninstall removes the file and the block, and also deletes from `prefs.js` the lines of exactly the prefs the block set, because Zen copies `user.js` values there.

### Updates

Releases are GitHub release files with an update manifest. The manifest's link is the versioned file URL with its sha256, and Zen's add-on manager checks it daily. Each version loads its modules from its own resource host, so an update in place runs the new code without a restart. A self-update does not touch `user.js`. When a release adds a guarded pref, its notes say so, and users run the installer again.

## Approaches considered

**What to separate on.** Containers, using Firefox's per-visit record, or spaces, with the add-on keeping its own log of which space each visit came from. Containers won: Firefox keeps the data, clearing history just works, and the add-on stores nothing. A second visit log would have gaps whenever the add-on is off, and edge cases for tabs that move between spaces. The cost is the requirement of one container per space.

**Where to filter.** Wrapping `Query.prototype.add` covers every provider with one hook. Patching each provider is brittle, since the history SQL sits in module-private code. An extra provider cannot remove other providers' results.

**How to package.** A WebExtension Experiment installed in the profile survives Zen updates. Tools that patch the application files break on every update. A regular extension has no access to the address bar. A change in Zen itself would be the natural home for the feature, but an add-on works with the Zen that exists today.

**How to distribute.** Versioned GitHub releases with an update manifest. A link file pointing at a git checkout has no pinned versions. Enterprise policies show a "managed by your organization" notice and need system-level changes.

## Testing

* Unit tests in Node cover the rules, the index and each glue module, with stubbed Firefox internals.
* Install tests run the installer against fake profile trees.
* Acceptance tests drive a real Zen through Marionette, in a fresh temporary profile each, with local test pages and no internet. They create two spaces, visit pages in each, and read the address bar the way a user sees it. Every "nothing leaks" check has a positive control on the same setup.
* CI runs all of it on every push and once a day against the latest Zen release, so a Zen update that breaks the add-on shows up without a push.

## Decision log

Numbers that are missing were process decisions with no trace in the code.

| Ruling | Decision |
|---|---|
| R4 | `src/guarded-prefs.json` is the one list of guarded prefs. The add-on, the installer's `user.js` block and `src/user.js.example` all come from it, and tests check they agree. |
| R5 | The "lists stay full" test compares against a fresh profile with Zen's defaults and no add-on. |
| R13 | `uv.lock` files are not committed. uv writes the URL of the machine's package index into them, and CI resolves test dependencies from PyPI. |
| R14 | `about:` suggestions are Firefox's own static pages, so they always show. Adaptive autofill follows the same rules as plain autofill. |
| R15 | Firefox autofills a URL up to the next slash, so a URL autofill is judged on what the active container visited under it. R38 tightens this. |
| R16 | Each version of the add-on loads its modules from its own resource host, so an update in place runs the new code. The status reports the version. |
| R19 | Failing closed covers start-up and every failure. Suggestions stay off until the self-check passes and go off on any failure. A query with no window keeps only the safe kinds. No call after shutdown can hook the address bar again. |
| R20 | An unassigned bookmark shows where its page was visited. One that no container ever visited shows only in the space without a container. Zen leaves new bookmarks unassigned, so showing them everywhere would leak. |
| R21 | A URL bookmarked several times is judged over all its bookmarks. |
| R23 | A failed read of Zen's bookmark spaces hides every bookmark and is a failed check. |
| R24 | Two leaks sit outside the query hook. The view replays cached rows across spaces, and Places keeps one title per URL. The view guard handles the first and the title rules the second. R36 refines the title rule. |
| R25 | A window whose address-bar view cannot be guarded is a failed check. |
| R26 | A bookmark row keeps its bookmark's own title. A bookmark without one falls back to the page title and follows the title rules. |
| R27 | The view guard wraps Zen's active-space setter, to clear the panel at the instant of a switch. A window with spaces but without that wrap is a failed check. |
| R29 | The `user.js` block is the two add-on prefs, the two sideload prefs and every guarded pref at its off value. The example file and the installer's output must match. |
| R32 | Uninstall also deletes from `prefs.js` the lines of exactly the prefs the block set, because Zen copies `user.js` values there. Custom values from before the install are not restored. |
| R33 | The installer tells a running Zen by the lock Zen holds on the profile's `.parentlock` (and the `lock` symlink on Linux). It refuses when Zen runs, and when it cannot tell. |
| R34 | The block keeps `extensions.startupScanScopes=1` and `extensions.autoDisableScopes=14`, so an add-on file in the profile is found at startup and starts without a prompt. The README states what that enables. |
| R35 | Release rules: the tag must match the manifest version, a release holds exactly one add-on file plus the update manifest, the manifest links the versioned file with its sha256, workflows get the least permissions they need with actions pinned to a commit, and a test proves a self-updated add-on comes back active. |
| R36 | A top site is kept only when its exact URL was visited in the active container. A Places title is kept only when the containers of its source are exactly the active one: the exact URL for most rows, the whole origin for origin autofill. Replaces "top sites are judged by origin" and "blank when visited in more than one container". |
| R37 | Private windows, unsynced windows and popups have no space of their own, so they keep only the safe kinds and are left out of the per-space self-checks. Replaces "private windows are filtered like any other window". |
| R38 | A URL autofill is kept on an exact URL match, or under it when it ends in "/". A raw string prefix kept `.../doc` where only `.../docs/x` was visited. |
| R40 | Smaller ones from the last review: past searches are a guarded pref, an activation that throws fails closed, the debug log is emptied when debug is turned off, the notice says whether the switch or a restart retries, and the installer names its platforms on Windows. |
| R42 | The index ignores "page visited" events with a visit id of 0. Firefox sends them for visits it did not store, with container 0 whatever the tab's container, so they showed a page from a container in the space without a container until a restart. User-visible: a visit Firefox drops is never suggested, as in Firefox. The acceptance tests make one click at start, so flooding prevention runs as it does for a real user, and never turn it off. |
| R43 | An autofill title that is one of the page's bookmark titles stays only where those bookmarks show. Other autofill titles follow R36. |
