"""Tests for scripts/make_updates_json.py, the update manifest a release
publishes. Run with `uv run --with pytest --with pyyaml pytest tests/release`.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "make_updates_json.py"
ADDON_ID = "zen-space-scope@zippeurfou.github.io"
DOWNLOADS = "https://github.com/zippeurfou/zen-space-scope/releases/download"


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["uv", "run", "--no-project", str(SCRIPT), *args],
        check=False,
        capture_output=True,
        text=True,
        cwd=REPO,
        env=os.environ,
    )


def make_xpi(
    path: Path, version: str = "1.2.3", addon_id: str = ADDON_ID, min_version="160.0"
) -> Path:
    gecko = {"id": addon_id, "strict_min_version": min_version}
    manifest = {
        "manifest_version": 2,
        "name": "x",
        "version": version,
        "browser_specific_settings": {"gecko": gecko},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("manifest.json", json.dumps(manifest))
        z.writestr("src/background.js", "// " + version)
    return path


@pytest.fixture
def xpi(tmp_path: Path) -> Path:
    return make_xpi(tmp_path / "zen-space-scope-1.2.3.xpi")


def test_versioned_link_hash_and_min_version(tmp_path, xpi):
    out = tmp_path / "updates.json"
    r = run(str(xpi), "-o", str(out))
    assert r.returncode == 0, r.stderr
    digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
    assert json.loads(out.read_text()) == {
        "addons": {
            ADDON_ID: {
                "updates": [
                    {
                        "version": "1.2.3",
                        "update_link": f"{DOWNLOADS}/v1.2.3/zen-space-scope-1.2.3.xpi",
                        "update_hash": f"sha256:{digest}",
                        "applications": {"gecko": {"strict_min_version": "160.0"}},
                    }
                ]
            }
        }
    }
    assert "latest" not in out.read_text()


def test_default_output_is_next_to_the_xpi(xpi):
    r = run(str(xpi))
    assert r.returncode == 0, r.stderr
    out = xpi.parent / "updates.json"
    assert out.exists()
    assert r.stdout.strip() == str(out)


def test_tag_must_match_the_version(tmp_path, xpi):
    out = tmp_path / "updates.json"
    r = run(str(xpi), "-o", str(out), "--expect-tag", "v1.2.4")
    assert r.returncode != 0
    assert "v1.2.4" in r.stderr and "1.2.3" in r.stderr
    assert "Traceback" not in r.stderr
    assert not out.exists()
    r = run(str(xpi), "-o", str(out), "--expect-tag", "1.2.3")
    assert r.returncode != 0, "a tag without the v prefix must not pass"
    r = run(str(xpi), "-o", str(out), "--expect-tag", "v1.2.3")
    assert r.returncode == 0, r.stderr


def test_custom_base_url(tmp_path, xpi):
    out = tmp_path / "updates.json"
    r = run(str(xpi), "-o", str(out), "--base-url", "https://example.test/dl/")
    assert r.returncode == 0, r.stderr
    entry = json.loads(out.read_text())["addons"][ADDON_ID]["updates"][0]
    assert entry["update_link"] == "https://example.test/dl/zen-space-scope-1.2.3.xpi"


def test_http_base_url_needs_allow_http(tmp_path, xpi):
    out = tmp_path / "updates.json"
    r = run(str(xpi), "-o", str(out), "--base-url", "http://updates.test/dl")
    assert r.returncode != 0
    assert not out.exists()
    r = run(
        str(xpi), "-o", str(out), "--base-url", "http://updates.test/dl", "--allow-http"
    )
    assert r.returncode == 0, r.stderr


def test_wrong_addon_id_is_refused(tmp_path):
    bad = make_xpi(tmp_path / "zen-space-scope-1.2.3.xpi", addon_id="other@example.org")
    out = tmp_path / "updates.json"
    r = run(str(bad), "-o", str(out))
    assert r.returncode != 0
    assert "other@example.org" in r.stderr
    assert not out.exists()


def test_missing_min_version_is_refused(tmp_path):
    bad = make_xpi(tmp_path / "zen-space-scope-1.2.3.xpi", min_version=None)
    r = run(str(bad), "-o", str(tmp_path / "updates.json"))
    assert r.returncode != 0
    assert "strict_min_version" in r.stderr


def test_not_a_zip_is_refused(tmp_path):
    bad = tmp_path / "zen-space-scope-1.2.3.xpi"
    bad.write_text("not a zip")
    r = run(str(bad), "-o", str(tmp_path / "updates.json"))
    assert r.returncode != 0
    assert "Traceback" not in r.stderr


def test_real_build(tmp_path):
    """The XPI scripts/build.sh makes from this checkout."""
    built = subprocess.run(
        ["sh", str(REPO / "scripts" / "build.sh")],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO,
    ).stdout.strip()
    version = json.loads((REPO / "manifest.json").read_text())["version"]
    out = tmp_path / "updates.json"
    r = run(built, "-o", str(out), "--expect-tag", f"v{version}")
    assert r.returncode == 0, r.stderr
    entry = json.loads(out.read_text())["addons"][ADDON_ID]["updates"][0]
    assert entry["version"] == version
    assert entry["update_link"] == (
        f"{DOWNLOADS}/v{version}/zen-space-scope-{version}.xpi"
    )
    assert entry["applications"]["gecko"]["strict_min_version"] == "160.0"


ICONS = {
    "16": "icons/icon-16.svg",
    "32": "icons/icon.svg",
    "48": "icons/icon.svg",
    "96": "icons/icon.svg",
}


def test_real_build_packages_the_manifest_icons():
    """The logo in about:addons (ruling R47): every icon the manifest names is
    in the built add-on, byte for byte."""
    built = subprocess.run(
        ["sh", str(REPO / "scripts" / "build.sh")],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO,
    ).stdout.strip()
    with zipfile.ZipFile(built) as z:
        manifest = json.loads(z.read("manifest.json"))
        assert manifest["icons"] == ICONS
        for path in set(ICONS.values()):
            assert z.read(path) == (REPO / path).read_bytes()
