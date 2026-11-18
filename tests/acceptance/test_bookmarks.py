"""Bookmark suggestions follow Zen's own bookmark-to-space assignment (the
"Spaces" field of the bookmark dialog). A bookmark in no space follows ruling
R20: it shows where its page was visited, and a never-visited one only in the
space without a container. Rows are matched by their BOOKMARKS source, so a
history row for the same URL can't stand in for a bookmark row.

Every "hidden" check comes with a positive control on the same setup."""

import time

from zen import urls

# A word that matches the bookmark titles only, so the address bar neither
# autofills nor treats it as an address.
WORD = "zebrafish"


def two_spaces(zen):
    """Work (no container) and Perso (container "Perso"); Work is active."""
    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")
    zen.switch_space(work)
    return work, perso


def visit_closed(zen, url):
    """Visit `url` in the active space, then close its tab."""
    zen.visit(url)
    zen.close_tab(url)


def bookmark_rows(rows, url):
    return [r for r in rows if r["url"] == url and r["source"] == "BOOKMARKS"]


def wait_addon_caught_up(zen, addon, timeout=10.0):
    """Wait until the add-on has read the latest bookmark spaces. Zen notifies
    synchronously at the end of a change, so the add-on is already reading
    when the change returns."""
    if addon is None:
        return
    deadline = time.monotonic() + timeout
    while True:
        status = zen.addon_call(addon, "getStatus")
        if status.get("bookmarks") != "loading":
            return
        if time.monotonic() > deadline:
            raise TimeoutError(f"the add-on is still reading bookmark spaces: {status}")
        time.sleep(0.1)


def test_bookmark_assigned_to_perso_hidden_in_work(zen, site, addon):
    work, perso = two_spaces(zen)
    secret = site.url("docs.test", "secret")
    guid = zen.add_bookmark(secret, f"{WORD} secret")
    zen.assign_bookmark(guid, [perso])
    wait_addon_caught_up(zen, addon)

    rows = zen.query(WORD)
    assert secret not in urls(rows), f"Perso's bookmark shows in Work: {rows}"

    zen.switch_space(perso)
    rows = zen.query(WORD)
    assert bookmark_rows(rows, secret), f"Perso lost its own bookmark: {rows}"


def test_unassigned_unvisited_bookmark_only_in_space_without_container(
    zen, site, addon
):
    """R20 (c): a bookmark in no space, never visited, shows only in the space
    without a container, like container-0 history."""
    work, perso = two_spaces(zen)
    page = site.url("docs.test", "imported")
    zen.add_bookmark(page, f"{WORD} imported")
    wait_addon_caught_up(zen, addon)

    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), f"Work lost the unassigned bookmark: {rows}"

    zen.switch_space(perso)
    rows = zen.query(WORD)
    assert page not in urls(rows), (
        f"an unvisited unassigned bookmark shows in Perso: {rows}"
    )


def test_unassigned_bookmark_follows_its_visits(zen, site, addon):
    """R20 (b): a bookmark in no space shows where its page was visited."""
    work, perso = two_spaces(zen)
    page = site.url("docs.test", "visited")
    zen.switch_space(perso)
    visit_closed(zen, page)
    zen.add_bookmark(page, f"{WORD} visited")
    wait_addon_caught_up(zen, addon)

    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), f"Perso lost the bookmark of its own page: {rows}"

    zen.switch_space(work)
    rows = zen.query(WORD)
    assert page not in urls(rows), f"a bookmark of Perso's page shows in Work: {rows}"


def test_url_bookmarked_twice_is_judged_over_all_its_bookmarks(zen, site, addon):
    """R21: one bookmark in Perso and one in no space, never visited. Perso
    shows it for its own bookmark, Work for the unassigned one (R20 (c))."""
    work, perso = two_spaces(zen)
    page = site.url("docs.test", "twice")
    guid = zen.add_bookmark(page, f"{WORD} twice")
    zen.assign_bookmark(guid, [perso])
    zen.add_bookmark(page, f"{WORD} twice again")
    wait_addon_caught_up(zen, addon)

    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), f"Work lost the unassigned copy: {rows}"

    zen.switch_space(perso)
    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), f"Perso lost its own bookmark: {rows}"


def test_reassigned_bookmark_follows_its_space(zen, site, addon):
    """The add-on picks up a change of spaces made while it runs."""
    work, perso = two_spaces(zen)
    page = site.url("docs.test", "moving")
    guid = zen.add_bookmark(page, f"{WORD} moving")
    zen.assign_bookmark(guid, [perso])
    wait_addon_caught_up(zen, addon)
    rows = zen.query(WORD)
    assert page not in urls(rows), f"Perso's bookmark shows in Work: {rows}"
    zen.switch_space(perso)
    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), f"Perso lost its own bookmark: {rows}"

    zen.assign_bookmark(guid, [work])
    wait_addon_caught_up(zen, addon)
    rows = zen.query(WORD)
    assert page not in urls(rows), (
        f"the bookmark moved to Work still shows in Perso: {rows}"
    )
    zen.switch_space(work)
    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), f"Work lost the bookmark moved to it: {rows}"

    # Out of every space and never visited: Perso hides it and Work, the space
    # without a container, shows it (R20).
    zen.assign_bookmark(guid, [])
    wait_addon_caught_up(zen, addon)
    rows = zen.query(WORD)
    assert bookmark_rows(rows, page), (
        f"Work lost the bookmark taken out of every space: {rows}"
    )
    zen.switch_space(perso)
    rows = zen.query(WORD)
    assert page not in urls(rows), (
        f"the unassigned bookmark still shows in Perso: {rows}"
    )


def test_bookmark_in_folder_assigned_to_perso(zen, site, addon):
    """A folder's spaces cover its bookmarks, as in Zen's bookmark toolbar."""
    work, perso = two_spaces(zen)
    folder = zen.add_bookmark_folder("Perso folder")
    inside = site.url("docs.test", "inside")
    zen.add_bookmark(inside, f"{WORD} inside", parent=folder)
    zen.assign_bookmark(folder, [perso])
    wait_addon_caught_up(zen, addon)

    rows = zen.query(WORD)
    assert inside not in urls(rows), (
        f"a bookmark of Perso's folder shows in Work: {rows}"
    )

    zen.switch_space(perso)
    rows = zen.query(WORD)
    assert bookmark_rows(rows, inside), f"Perso lost its folder's bookmark: {rows}"
