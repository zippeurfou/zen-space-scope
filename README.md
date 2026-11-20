# zen-space-scope

A Zen Browser add-on that keeps address-bar suggestions inside the active space's container.

I made it for screen sharing. If you use one space for work and another for personal stuff, the address bar in Zen still suggests pages from both. Type "g" while presenting and your personal Gmail is right there in the dropdown. This add-on makes the dropdown only show what the active space's container has seen.

It is a privileged, unsigned add-on, so please read "What the install enables" before you run anything.

## What it does

In the active space, the address bar only suggests pages visited in that space's container. This covers:

* history, autofill (the text Zen completes inline) and top sites;
* "Switch to tab" rows;
* bookmarks.

Every row is judged on its exact page, top sites included. A site both spaces use only shows the pages the active space opened. The one exception is autofill of a site's address (`example.com/`), which needs any page of that site visited in the space.

Three kinds of suggestions are dropped instead of scoped, because they can't be tied to a container: recent searches, past searches from your form history, and tabs from your other devices. Search-engine suggestions, the typed address, calculator, unit conversion and Zen's own actions and spaces always show.

Private windows, unsynced windows and popups (a sign-in or payment window, say) have no space. Zen gives them a placeholder at most, so they show no history-based suggestions, only the kinds that always show.

How it treats bookmarks:

* A bookmark assigned to spaces (in Zen's bookmark dialog) only shows in those spaces.
* An unassigned bookmark shows in a space if that space's container visited the page. If nobody ever visited the page, it shows only in the space without a container.
* A URL bookmarked several times is judged on all its bookmarks.

How it treats titles: Places (Firefox's history database) keeps one title per URL, so a page opened in two spaces can carry a title from the other one (a webmail inbox with an account name, say). A row keeps its title only when the page was visited in the active space's container and in no other. Otherwise it shows the page's host. Autofill of a site's address is stricter, because its title can come from the site's home page in any variant (http, https, www). It keeps the title only when no other container visited the site. "Switch to tab" rows show the tab's own title, and bookmark rows keep their own bookmark title.

To keep the lists full, the history sources fetch more candidates than the bar shows, and all of them are filtered. That is not a guarantee: if other spaces hold most of the top matches for what you typed, the list can come out shorter. The list shown when you open the bar before typing (top sites) is not refilled either, so a space can show fewer tiles.

It never writes to your history or bookmarks, reads Places through a read-only connection, and makes no network calls. The one exception is the update check Zen itself runs (see "Update").

## Requirements

* Zen 1.24.2b or later (Firefox 160).
* One container per space. At most one space can have no container, and that space owns old, imported and synced history (recorded as container 0). If two spaces share a container, the add-on can't tell them apart: it shows a warning, and suggestions from one can show in the other.
* For the install script: [uv](https://docs.astral.sh/uv/), on macOS or Linux. The script uses only the Python standard library. Building the add-on from a checkout (the default) also needs `zip`.

## Install

First, what the install enables in your profile. The add-on is unsigned and uses an experiment API, so the installer writes a block into your profile's `user.js` that turns on:

* unsigned add-ons (`xpinstall.signatures.required=false`);
* experiment add-ons (`extensions.experiments.enabled=true`);
* any add-on file in the profile's `extensions` folder starting without a prompt (`extensions.autoDisableScopes=14`);
* a startup scan of that folder (`extensions.startupScanScopes=1`).

The add-on itself runs with full browser privileges: it can read everything you do in the browser. That is how it gets at the address bar, and it is why it should come only from this repository's releases.

The block also keeps the history-based suggestion prefs off (see "How failing closed works"). Only drop add-on files you trust into that folder.

With the script:

1. Quit Zen (Cmd+Q). The script refuses to touch a profile while Zen runs.
2. Get the code:

   ```sh
   git clone https://github.com/zippeurfou/zen-space-scope.git
   cd zen-space-scope
   ```

3. See what it would do, without writing anything:

   ```sh
   uv run scripts/install.py --dry-run
   ```

4. Run it:

   ```sh
   uv run scripts/install.py
   ```

5. Start Zen. The add-on enables itself without a prompt and checks its own setup. Open `about:addons`, pick Zen Space Scope, and check that the options page says `active`.

By default the script builds the add-on from your checkout. To install the latest GitHub release instead, add `--latest`. That only works once a release has been published.

The script prints each change it makes. It keeps everything else in your `user.js`, and writes through it if it is a symlink. Running it again updates the block in place.

Flags:

| Flag | What it does |
|---|---|
| `--profile PATH` | Use this profile directory. Needed when `--zen-dir` and auto-detection can't pick one. Find yours at `about:profiles`. |
| `--zen-dir PATH` | Zen's data directory (the one holding `profiles.ini`), when it isn't in the default place, or when the script finds several. |
| `--xpi PATH` | Install this XPI instead of building from the checkout. |
| `--latest` | Download the latest GitHub release and install that. Over HTTPS only, and it checks the add-on id before writing anything. |
| `--dry-run` | Print every change and write nothing. |
| `--uninstall` | Remove the add-on, the block, and the prefs it set (see "Uninstall"). |
| `--print-block` | Print the `user.js` block and exit. Touches no profile. |

`--xpi` and `--latest` can't be combined. With several Zen installs in the data directory, the script lists the default profile of each and asks for `--profile`. With several data directories (on Linux, a native install next to a Flatpak one), it lists them and asks for `--zen-dir` or `--profile`. It never treats the data directory itself as a profile.

By hand, without the script: quit Zen, copy the XPI to `<profile>/extensions/zen-space-scope@zippeurfou.github.io.xpi` (make the `extensions` folder if it is missing), and add the output of `uv run scripts/install.py --print-block` to `<profile>/user.js`.

## Update

Zen checks for a new version of the add-on once a day and installs it in place, from the GitHub release. The update file carries the sha256 of the release file, and the update URL is HTTPS. That hash protects against a corrupted or swapped download. It does not protect against a compromised release, because the same release workflow writes the hash. Updates trust this GitHub repository and its workflow.

A self-update does not touch your `user.js`. When a release adds a guarded pref, the release notes say so, and you re-run the installer to pick it up. Once a release exists, `uv run scripts/install.py --latest` updates by hand. Pull the checkout first (`git pull`), since the installer builds the `user.js` block from the checkout's own prefs list.

## Uninstall

Quit Zen, then:

```sh
uv run scripts/install.py --uninstall
```

This removes the add-on file and the block from `user.js`. Zen also copies the `user.js` values into `prefs.js`, so removing the block alone resets nothing. The script therefore deletes the lines for exactly the prefs the block set from `prefs.js` too, and prints each one. They all go back to Zen's defaults: unsigned add-ons off, experiments off, sideloaded add-ons prompting again, and history suggestions back to whatever Zen ships with. A custom value you had for one of those prefs before installing is not restored. Add `--dry-run` to see what it would do first.

The script is the simpler path. It also deletes `user.js` when the block was its only content. If you would rather do it by hand, the block sets these 12 prefs (`uv run scripts/install.py --print-block` prints them with their values, and is the source of truth):

```
xpinstall.signatures.required
extensions.experiments.enabled
extensions.autoDisableScopes
extensions.startupScanScopes
browser.urlbar.suggest.history
browser.urlbar.suggest.bookmark
browser.urlbar.suggest.openpage
browser.urlbar.suggest.remotetab
browser.urlbar.suggest.recentsearches
browser.urlbar.autoFill
browser.urlbar.maxHistoricalSearchSuggestions
browser.newtabpage.activity-stream.feeds.system.topsites
```

The order matters, because Zen re-applies `user.js` at every start and rewrites `prefs.js` when it quits:

1. Quit Zen.
2. Delete `<profile>/extensions/zen-space-scope@zippeurfou.github.io.xpi`.
3. Remove the block from `user.js`, from the `// zen-space-scope: begin` line to the `// zen-space-scope: end` line.
4. Still with Zen quit, delete the `user_pref(...)` line of each of the 12 prefs from `prefs.js`. Then start Zen.

If you prefer `about:config`, do steps 1 to 3, start Zen, click Reset on each of the 12 prefs, then quit and start Zen again so the change is saved. Skip step 4 in that case. Editing `prefs.js` while Zen runs doesn't work: Zen overwrites it when it quits.

## How failing closed works

The goal is that a broken add-on never shows you the thing it exists to hide.

The `user.js` block keeps Zen's history-based suggestions off at every startup: history, bookmarks, open tabs, remote tabs, recent searches, past searches (form history), autofill and top sites. The add-on turns them on only after its self-check passes, and turns them off again on any later failure, when you disable it, and when Zen shuts down. So while the add-on is missing, broken or still starting, the address bar shows no history.

The self-check covers the filter hook, Places' container column, the active space of every window that has spaces, a synthetic query that must be dropped, the address-bar view guard on every window, the space-switch guard, and the reading of Zen's bookmark spaces. When a check fails, a bar appears in your windows naming the failed checks, and suggestions stay off until you switch the add-on back on from its options page or restart Zen. The switch can't retry a failure from the add-on's own start-up (`start`, or `hook-installed` or `history-container-column` raised while loading). Those need a Zen restart. The bar and the options page say which of the two applies.

Things to know:

* When it turns suggestions on, it writes Zen's default "on" values. If you customized those prefs, the add-on overrides your values while it runs.
* Another add-on that wraps the address-bar view will make the `view-guard` check fail. That is safe, suggestions just stay off.
* Without the add-on, typing a full URL you visited still shows that page's shared title. No pref turns that off, so keep the add-on installed.

## Troubleshooting

Open `about:addons`, pick Zen Space Scope and open its options page. It shows the state (`active`, `fail-closed`, `disabled` or `starting`), the version, the failed checks, any spaces sharing a container, the on/off switch and the debug log.

The on/off switch lasts until Zen restarts. The add-on starts switched on every time, so to keep it off, disable it in `about:addons` instead. Either way, history suggestions stay off while it is off.

**No history suggestions at all.** Check the state. If it says `fail-closed`, look at the failed checks, fix the cause if you can, and flip the switch off and on to retry. If the failed check is `start`, restart Zen instead. The table below says which ones the switch can retry. If the add-on isn't listed at all, you probably started Zen on a different profile than the one the installer used (it prints the profile path), or Zen wasn't restarted after the install.

**Failed check names.**

| Check | Meaning |
|---|---|
| `start` | The add-on failed to start at all. The debug log has the error. Restart Zen: the switch can't retry it. |
| `hook-installed` | Zen's query code isn't what the add-on expects, or one of its modules didn't load. Usually a Zen update. Restart Zen if it appeared at start-up, otherwise the switch retries it. |
| `history-container-column` | Places has no per-visit container column. Zen is older than Firefox 160. Same retry rule as `hook-installed`. |
| `active-space-resolves` | A window's active space or its container couldn't be read, or Zen no longer says which windows have spaces. Usually a Zen update. |
| `synthetic-query-filtered` | A test row that must be dropped got through, or the typed address was dropped. |
| `view-guard` | A window's address-bar view couldn't be guarded. Another add-on touching it can cause this. |
| `space-switch-guard` | The add-on couldn't wrap Zen's space switch in a window. Usually a Zen update. |
| `bookmark-spaces` | Zen's bookmark spaces couldn't be read. Bookmarks stay hidden meanwhile. |
| `suggestion-prefs` | The add-on couldn't write the suggestion prefs. |
| `activation` | An unexpected error while the add-on was turning on. The debug log has it. The switch retries it. |

After a Zen update, a red check usually means Zen changed code the add-on relies on. Stay on fail-closed, open an issue with the check name, and attach the debug log.

**A warning about spaces sharing a container.** Give each space its own container. Until then, suggestions from one of those spaces can show in the other.

**A page shows its host instead of its title.** Zen stores one title per page for all your containers. So the add-on shows a page's title only when the active space's container is the only one that visited it. If another container visited it too, or none did, you see the host. For autofill of a site's address, every page of the site counts. An autofill can also show the title of one of the page's bookmarks, and that title only shows in spaces where the bookmark shows. It is on purpose.

**The installer says Zen is running.** Quit Zen with Cmd+Q and run the same command again. The script also refuses when it can't tell whether the profile is locked, and the message says why.

**Zen says it is already open while the installer runs.** The script keeps the profile locked until its last write, so a Zen you start in that window finds the profile in use. Wait for the script to finish, then start Zen.

**The installer lists several Zen installs or data directories.** Pass `--profile` with the path from `about:profiles`.

**The debug log.** Turn it on in the options page to log every address-bar decision. It contains the URLs you visit, and it is off by default, so be careful before pasting it in an issue. Turning it off empties the log.

## Known limitations

Not covered, because they don't go through the address bar's suggestions:

* the History sidebar and the Library window;
* Vimium-style search bars and other add-ons that search all your history;
* the Smartbar mentions panel, if you turn on `browser.smartwindow.enabled` (off by default in 2b).

Limits of the filter:

* Keyword bookmarks only work in the space without a container, because typing the keyword's terms changes the URL.
* If you bookmark the same page in two spaces under different names, either name can show in both spaces. The add-on judges a page by all of its bookmarks, and Firefox picks one of their names to display.
* If Zen starts with only private, unsynced or popup windows, suggestions stay off until you open a regular window. The add-on needs a window with your spaces to run its self-check, and its options page can't show a status before that.
* Lists can come out shorter than usual when other spaces hold most of the matches, and the empty-bar top sites aren't refilled. Zen keeps one top site per site, its most visited page. If this space never opened that page, the site gets no tile here, even when this space uses other pages of it.

Not supported:

* @ searches per space;
* spaces without containers, beyond the one allowed;
* regular Firefox;
* addons.mozilla.org. The add-on is unsigned, so it ships as a GitHub release file.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). How it works, and why, is in [docs/design.md](docs/design.md). The license is MPL-2.0.
