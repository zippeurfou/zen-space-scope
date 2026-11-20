"""The add-on's logo shows in about:addons: Zen's add-on manager resolves the
manifest's icons, `icons/icon-16.svg` at 16px and `icons/icon.svg` at the
larger sizes (ruling R47)."""


def test_addon_manager_resolves_the_logo(zen, addon):
    icons = zen.chrome(
        """
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs");
        const a = await AddonManager.getAddonByID(args[0]);
        return { icons: a.icons, iconURL: a.iconURL };
        """,
        addon,
    )
    assert sorted(icons["icons"]) == ["16", "32", "48", "96"]
    assert icons["icons"]["16"].endswith("/icons/icon-16.svg")
    assert all(
        icons["icons"][s].endswith("/icons/icon.svg") for s in ("32", "48", "96")
    )
    assert icons["iconURL"].endswith("/icons/icon.svg")
