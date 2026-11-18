"""Self-tests for the harness: a cancelled address-bar query must never read
as a finished one, or a "no leak" assertion could pass on a truncated list."""

import time

import pytest
from zen import QueryCancelledError, ZenScriptError

# Cancels queries for `args[0]` as soon as their first results reach the view,
# at most `args[1]` times. Counts the cancels in win.__zssCancels.
CANCEL_HOOK = """
const [text, times] = args;
win.__zssCancels = 0;
win.gURLBar.controller.addListener({
  onQueryResults(ctx) {
    if (ctx.searchString == text && win.__zssCancels < times) {
      win.__zssCancels++;
      win.gURLBar.controller.cancelQuery();
    }
  },
});
"""


def test_query_raises_when_cancelled_twice(zen, site):
    zen.visit(site.url("lemonde.test", "a"))
    zen.chrome(CANCEL_HOOK, "lemonde", 2)
    with pytest.raises(QueryCancelledError):
        zen.query("lemonde")
    assert zen.chrome("return win.__zssCancels") == 2


def test_query_retries_once_after_a_cancel(zen, site):
    zen.visit(site.url("lemonde.test", "a"))
    zen.chrome(CANCEL_HOOK, "lemonde", 1)
    rows = zen.query("lemonde")
    assert zen.chrome("return win.__zssCancels") == 1
    assert site.url("lemonde.test", "a") in [r["url"] for r in rows]


def test_zen_starts_with_a_user_input_on_record(zen):
    """Like a real user's Zen, so history flooding prevention is live."""
    assert zen.chrome("return win.windowUtils.millisSinceLastUserInput;") >= 0


def test_visit_explains_a_restricted_visit(zen, site):
    """The 4th quick visit of one host, over 3 s after the latest user input,
    is not stored. visit() says so instead of timing out or reporting an odd
    container."""
    zen.user_input()
    time.sleep(3.5)
    pages = [site.url("shop.test", f"p{i}") for i in range(4)]
    for page in pages[:3]:
        zen.visit(page)
    with pytest.raises(ZenScriptError, match="Firefox restricted the visit"):
        zen.visit(pages[3])
