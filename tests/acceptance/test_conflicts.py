"""Two spaces that share a container cannot be told apart by the add-on: it
warns about them. The options page shows the status, the conflicts, and the
switches. Every "nothing" check has its positive control."""

import time

from test_cmd_t import CMD_T
from test_fail_closed import (
    OFF,
    ON,
    history_based,
    notice,
    prefs_now,
    visit_closed,
    wait_status,
)
from zen import urls

CONFLICT_NOTICE = "zen-space-scope-container-conflict"


def conflict_notice(zen) -> str | None:
    """The label of the add-on's container-conflict notification in the
    selected window, or None."""
    return zen.chrome(
        """
        const box = win.gNotificationBox;
        await waitFor(() => !box._animating, "the notification box", 5000).catch(() => {});
        const item = box.getNotificationWithValue(args[0]);
        return item ? (item.label ?? item.messageText?.textContent ?? "") : null;
        """,
        CONFLICT_NOTICE,
    )


def wait_conflict_notice(zen, present: bool) -> str | None:
    end = time.monotonic() + 15
    while True:
        label = conflict_notice(zen)
        if (label is not None) == present:
            return label
        if time.monotonic() > end:
            raise AssertionError(f"the conflict notice never became {present}: {label}")
        time.sleep(0.2)


def test_one_space_per_container_has_no_warning(zen, addon):
    """The positive control of the tests below: the normal setup."""
    zen.make_space("Work", None)
    zen.make_space("Perso", "Perso")
    status = zen.addon_call(addon, "getStatus")
    assert status["state"] == "active", status
    assert status["conflicts"] == [], status
    assert conflict_notice(zen) is None


def test_two_spaces_without_container_warn(zen, addon):
    zen.make_space("Work", None)
    zen.make_space("Perso", "Perso")
    assert zen.addon_call(addon, "getStatus")["conflicts"] == []
    assert conflict_notice(zen) is None

    # A second space without a container, on purpose (the harness reuses
    # Zen's default space for the first).
    zen.make_space("Other", None)
    status = zen.addon_call(addon, "getStatus")
    assert len(status["conflicts"]) == 1, status
    conflict = status["conflicts"][0]
    assert conflict["ucid"] == 0, status
    assert sorted(conflict["spaces"]) == ["Other", "Work"], status
    # A warning, not a failure: suggestions stay on.
    assert status["state"] == "active", status
    assert status["failedChecks"] == [], status
    assert prefs_now(zen) == ON

    label = wait_conflict_notice(zen, True)
    assert "Work" in label and "Other" in label, label
    assert notice(zen) is None, "a conflict is not a failed check"


def test_conflict_is_noticed_at_start(launch_zen, addon_xpi):
    """Spaces that already conflict when the add-on starts get the warning
    without anyone asking for the status."""
    from zen import user_js_block_prefs

    zen = launch_zen(user_js_block_prefs())
    zen.make_space("Work", None)
    zen.make_space("Other", None)
    addon = zen.install_addon(str(addon_xpi))
    zen.wait_addon_active(addon)
    assert wait_conflict_notice(zen, True)


def test_conflict_goes_away_with_the_second_space(zen, addon):
    zen.make_space("Work", None)
    other = zen.make_space("Other", None)
    assert zen.addon_call(addon, "getStatus")["conflicts"], "setup: no conflict"
    assert wait_conflict_notice(zen, True)

    zen.chrome(
        """
        const zw = win.gZenWorkspaces;
        await zw.removeWorkspace(args[0]);
        """,
        other,
    )
    assert zen.addon_call(addon, "getStatus")["conflicts"] == []
    assert wait_conflict_notice(zen, False) is None


def test_options_page_shows_status_and_conflicts(zen, addon):
    zen.make_space("Work", None)
    with zen.options_page(addon) as page:
        page.wait("return document.querySelector('#state')?.textContent", "the status")
        assert page.text("#state") == "active"
        assert page.text("#version")
        assert page.eval("return document.querySelector('#conflicts li') === null;")
        assert page.text("#no-conflicts") is not None
        assert page.eval("return document.querySelector('#conflict-list').hidden;")

    zen.make_space("Other", None)
    with zen.options_page(addon) as page:
        page.wait("return document.querySelector('#conflicts li')", "the conflict list")
        text = page.eval("return document.querySelector('#conflicts').textContent;")
        assert "Work" in text and "Other" in text, text
        assert not page.eval("return document.querySelector('#conflict-list').hidden;")


def test_options_toggle_off_turns_suggestions_off(zen, site, addon):
    wiki = site.url("wiki.test", "a")
    visit_closed(zen, wiki)
    assert prefs_now(zen) == ON
    assert wiki in urls(zen.query("wiki")), "positive control: no history row"

    with zen.options_page(addon) as page:
        page.wait(
            "return document.querySelector('#state')?.textContent === 'active'",
            "active",
        )
        assert page.eval("return document.querySelector('#enabled').checked;")

        page.click("#enabled")
        page.wait(
            "return document.querySelector('#state').textContent === 'disabled'",
            "disabled",
        )
        assert not page.eval("return document.querySelector('#enabled').checked;")
    # The page's own switch did it: the add-on and the prefs agree.
    assert zen.addon_call(addon, "getStatus")["state"] == "disabled"
    assert prefs_now(zen) == OFF
    assert not history_based(zen.query("wiki"))

    with zen.options_page(addon) as page:
        page.wait(
            "return document.querySelector('#state')?.textContent === 'disabled'",
            "disabled",
        )
        assert not page.eval("return document.querySelector('#enabled').checked;")
        page.click("#enabled")
        page.wait(
            "return document.querySelector('#state').textContent === 'active'", "active"
        )
    # The self-check ran again before suggestions came back.
    assert zen.addon_call(addon, "getStatus")["failedChecks"] == []
    assert prefs_now(zen) == ON
    assert wiki in urls(zen.query("wiki"))


def test_options_page_shows_failed_checks(zen, site, addon):
    """A fail-closed add-on says which checks failed, and the switch retries."""
    wait_status(zen, addon, lambda s: s["bookmarks"] == "ready", "the bookmark spaces")
    zen.chrome(
        """
        const storage = win.ZenWorkspaceBookmarksStorage;
        win.savedRead = storage.getBookmarkGuidsByWorkspace;
        storage.getBookmarkGuidsByWorkspace = async () => {
          throw new Error("bookmark spaces broken for the test");
        };
        """
    )
    zen.add_bookmark(site.url("docs.test", "c"), "docs c")
    wait_status(zen, addon, lambda s: s["state"] == "fail-closed", "fail-closed")
    with zen.options_page(addon) as page:
        page.wait(
            "return document.querySelector('#state')?.textContent === 'fail-closed'",
            "fail-closed",
        )
        assert "bookmark-spaces" in page.text("#failed")
        assert not page.eval("return document.querySelector('#enabled').checked;")
        # This failure came after start-up, so the switch retries it, and the
        # page and the notice both say so.
        advice = page.text("#failed-box")
        assert "Switch the add-on on again" in advice and "Restart" not in advice, (
            advice
        )
    assert zen.addon_call(addon, "getStatus")["canRetry"] is True
    label = notice(zen)
    assert label and "off and on again" in label and "restart Zen" not in label, label
    assert prefs_now(zen) == OFF

    zen.chrome(
        "win.ZenWorkspaceBookmarksStorage.getBookmarkGuidsByWorkspace = win.savedRead;"
    )
    with zen.options_page(addon) as page:
        page.wait(
            "return document.querySelector('#state')?.textContent === 'fail-closed'",
            "fail-closed",
        )
        page.click("#enabled")
        page.wait(
            "return document.querySelector('#state').textContent === 'active'", "active"
        )
    assert prefs_now(zen) == ON


def test_options_page_debug_log(zen, site, addon):
    wiki = site.url("wiki.test", "a")
    visit_closed(zen, wiki)
    with zen.options_page(addon) as page:
        page.wait("return document.querySelector('#state')?.textContent", "the status")
        assert page.text("#log") == "", "positive control: the log starts empty"
        page.click("#debug")
        page.wait("return document.querySelector('#debug').checked", "debug on")
    zen.query("wiki")
    with zen.options_page(addon) as page:
        page.wait("return document.querySelector('#debug')?.checked", "debug still on")
        page.click("#refresh-log")
        page.wait(
            "return document.querySelector('#log').textContent.includes('wiki.test')",
            "log lines",
        )
        assert 'query "wiki"' in page.text("#log")


def test_rows_dropped_by_the_view_are_logged(zen, site, addon):
    """The Cmd+T replay of another space's rows never reaches the hook; the
    view's drops are in the debug log too."""
    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")
    zen.switch_space(work)
    wiki = site.url("wiki.test", "a")
    zen.visit(wiki)
    zen.close_tab(wiki)
    zen.visit(wiki)
    zen.visit(site.url("wiki.test", "b"))
    zen.switch_space(perso)
    zen.visit(site.url("zillow.test", "a"))
    assert wiki in zen.refresh_top_sites(), "setup: wiki.test/a is not a top site"
    zen.switch_space(work)
    seen = zen.chrome(CMD_T)
    assert any(r["url"] == wiki for rows in seen for r in rows), (
        f"setup: Work's Cmd+T does not show its own tab: {seen}"
    )

    # Work's cached empty-bar context, as the view would replay it.
    assert zen.chrome(
        """
        win.savedContext = win.gURLBar.view.queryContextCache.topSitesContext;
        return win.savedContext?.results.map(r => r.payload.url) ?? [];
        """
    ), "setup: the view cached no empty-bar context"

    zen.addon_call(addon, "setDebug", True)
    assert not [
        line for line in zen.addon_call(addon, "getLog") if line.startswith("view ")
    ], "positive control: the log has view lines before anything ran"
    zen.switch_space(perso)
    # A replay the add-on's other defenses missed: Work's rows reach Perso's
    # view. The view guard has to drop them, and the log says so.
    shown = zen.chrome(
        """
        const view = win.gURLBar.view;
        view.onQueryResults(win.savedContext);
        return win.savedContext.results.map(r => r.payload.url);
        """
    )
    assert wiki not in shown, f"the view kept Work's tab: {shown}"
    log = zen.addon_call(addon, "getLog")
    # The row lines that follow a "view ..." line, up to the next head.
    dropped = []
    in_view = False
    for line in log:
        if not line.startswith("  "):
            in_view = line.startswith("view ")
        elif in_view and line.startswith("  drop "):
            dropped.append(line)
    assert any(wiki in line for line in dropped), (
        f"the view's dropped row is not in the log: {log}"
    )
