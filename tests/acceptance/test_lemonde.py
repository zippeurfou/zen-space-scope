"""The original leak: a page visited in one space shows up in another
space's address bar."""

from zen import hosts, urls


def test_lemonde_both_directions(zen, site, addon):
    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")

    zen.switch_space(perso)
    zen.visit(site.url("lemonde.test", "a"))
    zen.switch_space(work)
    zen.visit(site.url("wiki.test", "a"))

    rows = zen.query("lemonde")
    assert "lemonde.test" not in hosts(rows), f"Perso's page leaks into Work: {rows}"

    zen.switch_space(perso)
    rows = zen.query("wiki")
    assert "wiki.test" not in hosts(rows), f"Work's page leaks into Perso: {rows}"

    rows = zen.query("lemonde")
    assert site.url("lemonde.test", "a") in [r["url"] for r in rows], (
        f"Perso lost its own page: {rows}"
    )


def test_lemonde_history_rows(zen, site, addon):
    """Same leak with every tab closed, so pages come back as history rows
    rather than switch-to-tab rows."""
    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")
    lemonde, wiki = site.url("lemonde.test", "a"), site.url("wiki.test", "a")

    zen.switch_space(perso)
    zen.visit(lemonde)
    zen.close_tab(lemonde)
    zen.switch_space(work)
    zen.visit(wiki)
    zen.close_tab(wiki)

    rows = zen.query("lemonde")
    assert "lemonde.test" not in hosts(rows), f"Perso's page leaks into Work: {rows}"
    rows = zen.query("wiki")
    assert wiki in urls(rows), f"Work lost its own page: {rows}"

    zen.switch_space(perso)
    rows = zen.query("wiki")
    assert "wiki.test" not in hosts(rows), f"Work's page leaks into Perso: {rows}"
    rows = zen.query("lemonde")
    assert lemonde in urls(rows), f"Perso lost its own page: {rows}"
