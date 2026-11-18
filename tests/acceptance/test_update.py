"""An in-place update loads the new version's code without a Zen restart."""

import json
import re
import subprocess
from pathlib import Path

from zen import REPO_ROOT, hosts, urls

HOST_CHECK = """
const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(
  Ci.nsISubstitutingProtocolHandler);
return Object.fromEntries(args[0].map(h => [h, resProto.hasSubstitution(h)]));
"""


def host_for(version: str) -> str:
    return "zen-space-scope-" + re.sub(r"[^A-Za-z0-9]", "-", version)


def test_update_in_place(zen, site, addon):
    assert addon is not None, "the add-on is not built"
    old = json.loads((REPO_ROOT / "manifest.json").read_text())["version"]
    new = old + ".1"
    out = subprocess.run(
        ["sh", str(REPO_ROOT / "scripts" / "build.sh"), new],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    new_xpi = Path(out.stdout.strip().splitlines()[-1])
    assert new_xpi.name == f"zen-space-scope-{new}.xpi"

    work = zen.make_space("Work", None)
    perso = zen.make_space("Perso", "Perso")
    lemonde, wiki = site.url("lemonde.test", "a"), site.url("wiki.test", "a")
    zen.switch_space(perso)
    zen.visit(lemonde)
    zen.close_tab(lemonde)
    zen.switch_space(work)
    zen.visit(wiki)
    zen.close_tab(wiki)

    assert zen.addon_call(addon, "getStatus")["version"] == old
    assert zen.chrome(HOST_CHECK, [host_for(old), host_for(new)]) == {
        host_for(old): True,
        host_for(new): False,
    }

    assert zen.install_addon(str(new_xpi)) == addon
    status = zen.wait_addon_active(addon)
    assert status["version"] == new, f"still the old code: {status}"
    assert zen.chrome(HOST_CHECK, [host_for(old), host_for(new)]) == {
        host_for(old): False,
        host_for(new): True,
    }

    rows = zen.query("lemonde")
    assert "lemonde.test" not in hosts(rows), f"Perso's page leaks after update: {rows}"
    rows = zen.query("wiki")
    assert wiki in urls(rows), f"Work lost its own page after update: {rows}"
