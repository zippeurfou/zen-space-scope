"""Dropping another space's rows must not leave the list shorter than Zen
would show without the add-on: the active space's own pages fill the gap."""

from urllib.parse import urlsplit

import pytest
from test_scoping import two_spaces, visit_closed

PAGES = 12


def pages(prefix):
    """One "doc" page per host: Firefox would not store 36 quick visits of a
    single host (history flooding prevention), and a person reading that
    many pages of one site does it over minutes, not seconds."""
    return [f"http://docs-{prefix}{i}.test/page" for i in range(1, PAGES + 1)]


@pytest.fixture
def doc_pages(site):
    every = pages("w") + pages("p")
    for url in every:
        title = f"{urlsplit(url).hostname} page"
        site.serve(url, f"<!doctype html><title>{title}</title>".encode(), "text/html")
    yield
    for url in every:
        site.unserve(url)


def visit_both_spaces(zen):
    """12 "doc" pages in Work, then 12 in Perso visited twice, so Perso's
    pages rank above Work's and fill Places' candidate list for "doc"."""
    work, perso = two_spaces(zen)
    for url in pages("w"):
        visit_closed(zen, url)
    zen.switch_space(perso)
    for _ in range(2):
        for url in pages("p"):
            visit_closed(zen, url)
    zen.switch_space(work)


def history_rows(rows):
    return [r for r in rows if r["source"] == "HISTORY" and r["type"] == "URL"]


def test_list_not_shorter(launch_zen, zen, doc_pages, addon):
    # Baseline: a profile without the add-on, Zen's defaults (ruling R5).
    plain = launch_zen()
    visit_both_spaces(plain)
    baseline = history_rows(plain.query("doc"))
    plain.close()
    assert len(baseline) >= 5, (
        f"setup: too few history rows without the add-on: {baseline}"
    )

    visit_both_spaces(zen)
    rows = zen.query("doc")
    work_pages, perso_pages = set(pages("w")), set(pages("p"))

    leaked = [r for r in rows if r.get("url") in perso_pages]
    assert not leaked, f"Perso's pages show in Work: {leaked}"
    history = history_rows(rows)
    foreign = [r["url"] for r in history if r["url"] not in work_pages]
    assert not foreign, f"history rows that are not Work's pages: {foreign}"
    assert len(history) == len(baseline), (
        f"Work shows {len(history)} history rows, Zen without the add-on shows "
        f"{len(baseline)}: {rows}"
    )
