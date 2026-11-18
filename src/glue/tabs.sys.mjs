// The label of an open tab, found the way a "Switch to Tab" row finds its tab
// (Zen 1.24.2b, browser/modules/URILoadingHelper.sys.mjs:1033-1046: every
// browser of gZenWorkspaces.allUsedBrowsers, matched on its current URL and
// its "usercontextid" attribute; allUsedBrowsers is
// browser/modules/zen/ZenSpaceManager.mjs:3524). Top sites match a tab with
// or without the URL's fragment (UrlbarProviderTopSites.sys.mjs:223-227), so
// fragments are ignored here too.

const withoutFragment = url => url.replace(/#.*$/, "");

// wins: browser windows, the most relevant first. Returns the first non-empty
// label of a tab on `url` in container `ucid`, or null.
export function openTabLabel(wins, url, ucid) {
  const wanted = withoutFragment(url);
  for (const win of wins) {
    const browsers = win?.gZenWorkspaces?.allUsedBrowsers ?? win?.gBrowser?.browsers ?? [];
    for (const browser of browsers) {
      const spec = browser?.currentURI?.spec;
      if (typeof spec !== "string" || withoutFragment(spec) !== wanted) {
        continue;
      }
      if (Number(browser.getAttribute("usercontextid") || 0) !== ucid) {
        continue;
      }
      const label = win.gBrowser?.getTabForBrowser(browser)?.label;
      if (typeof label === "string" && label) {
        return label;
      }
    }
  }
  return null;
}
