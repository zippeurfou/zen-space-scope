"""Static checks on the GitHub workflows and the update channel (R35).

GitHub only runs the workflows once the repository is published, so these
checks are the local guard on what they do. Run with
`uv run --with pytest --with pyyaml pytest tests/release`.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"
UPDATE_URL = "https://github.com/zippeurfou/zen-space-scope/releases/latest/download/updates.json"
PINNED = re.compile(r"^[\w.-]+/[\w.-]+(/[\w./-]+)?@[0-9a-f]{40}$")


def load(name: str) -> dict:
    data = yaml.safe_load((WORKFLOWS / name).read_text())
    # YAML 1.1 reads the key `on` as True.
    if True in data:
        data["on"] = data.pop(True)
    return data


def steps(job: dict) -> list[dict]:
    return job.get("steps", [])


def runs(wf: dict) -> str:
    return "\n".join(
        s.get("run", "") for job in wf["jobs"].values() for s in steps(job)
    )


@pytest.fixture(params=["ci.yml", "release.yml"])
def workflow(request) -> tuple[str, dict]:
    return request.param, load(request.param)


def test_manifest_update_url_is_the_latest_release():
    manifest = json.loads((REPO / "manifest.json").read_text())
    gecko = manifest["browser_specific_settings"]["gecko"]
    assert gecko["update_url"] == UPDATE_URL
    assert gecko["strict_min_version"] == "160.0"


def test_actions_are_pinned_to_a_commit(workflow):
    name, wf = workflow
    for job_name, job in wf["jobs"].items():
        assert "uses" not in job, f"{name}:{job_name} calls a reusable workflow"
        for step in steps(job):
            if "uses" in step:
                assert PINNED.match(step["uses"]), f"{name}: not pinned: {step['uses']}"


def test_no_secret_beyond_github_token(workflow):
    name, _ = workflow
    text = (WORKFLOWS / name).read_text()
    assert set(re.findall(r"secrets\.(\w+)", text)) <= {"GITHUB_TOKEN"}
    assert "pull_request_target" not in text


def test_checkout_keeps_no_credentials(workflow):
    name, wf = workflow
    for job in wf["jobs"].values():
        for step in steps(job):
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step.get("with", {}).get("persist-credentials") is False, name


def test_no_internal_package_index(workflow):
    name, wf = workflow
    text = (WORKFLOWS / name).read_text().lower()
    for word in ("index-url", "extra-index", "uv_index"):
        assert word not in text, f"{name} mentions {word}"
    # No URL of any other host either, so no private registry by its address.
    hosts = set(re.findall(r"https?://([a-z0-9.-]+)", text))
    assert hosts <= {"github.com"}, f"{name} names other hosts: {hosts}"
    # uv ignores any machine-level uv.toml, so only PyPI is used (R13).
    assert wf["env"]["UV_NO_CONFIG"] == "1"


def test_uv_lock_files_stay_untracked():
    tracked = subprocess.run(
        ["git", "ls-files"], cwd=REPO, check=True, capture_output=True, text=True
    ).stdout.split()
    assert not [f for f in tracked if f.endswith(("uv.lock", ".py.lock"))]


def test_ci_is_read_only_and_runs_on_push_and_daily():
    wf = load("ci.yml")
    assert wf["permissions"] == {"contents": "read"}
    for job_name, job in wf["jobs"].items():
        assert job.get("permissions", {"contents": "read"}) == {"contents": "read"}, (
            job_name
        )
    assert "push" in wf["on"]
    assert wf["on"]["schedule"], "no daily run"


def test_ci_runs_the_same_commands_as_the_local_checks():
    wf = load("ci.yml")
    text = runs(wf)
    assert "node --test tests/unit/*.test.mjs" in text
    assert "pytest tests/install tests/release" in text
    assert "uv run --project tests/acceptance pytest tests/acceptance" in text


def test_ci_acceptance_runs_headless_against_the_latest_zen():
    job = load("ci.yml")["jobs"]["acceptance"]
    assert "ubuntu" in job["runs-on"]
    env = job["env"]
    assert env["HEADLESS"] == "1"
    assert env["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] == "1"
    text = "\n".join(s.get("run", "") for s in steps(job))
    # The tag of the latest release is resolved once, printed, and the
    # tarball comes from that tag, so a red daily run names its Zen.
    assert "https://github.com/zen-browser/desktop/releases/latest" in text
    assert (
        "https://github.com/zen-browser/desktop/releases/download/$tag/"
        "zen.linux-x86_64.tar.xz" in text
    )
    assert 'echo "Zen release tag: $tag"' in text
    assert "ZEN_BINARY=" in text


def test_release_runs_on_version_tags_only():
    wf = load("release.yml")
    assert wf["on"] == {"push": {"tags": ["v*"]}}


def test_release_permissions_are_least_privilege():
    wf = load("release.yml")
    assert wf["permissions"] == {}
    assert set(wf["jobs"]) == {"test", "release"}
    assert wf["jobs"]["test"]["permissions"] == {"contents": "read"}
    assert wf["jobs"]["release"]["permissions"] == {"contents": "write"}


def test_release_job_needs_the_test_job():
    job = load("release.yml")["jobs"]["release"]
    assert job["needs"] in ("test", ["test"])


def test_release_job_runs_no_package_code():
    """The job that builds, hashes and publishes installs nothing from PyPI
    or npm, so no third-party package code can touch what it publishes."""
    job = load("release.yml")["jobs"]["release"]
    uses = [s["uses"].split("@")[0] for s in steps(job) if "uses" in s]
    assert uses == ["actions/checkout", "astral-sh/setup-uv"]
    setup_uv = next(s for s in steps(job) if "setup-uv" in s.get("uses", ""))
    assert setup_uv["with"]["enable-cache"] is False
    # uv may not reach any index, nor download a Python.
    assert job["env"]["UV_OFFLINE"] == "1"
    assert job["env"]["UV_PYTHON_DOWNLOADS"] == "never"
    text = "\n".join(s.get("run", "") for s in steps(job))
    for word in ("--with", "pip", "pytest", "npm", "npx", "uvx", "node "):
        assert word not in text, f"the release job runs {word!r}"
    for line in text.splitlines():
        if "make_updates_json.py" in line:
            assert line.strip().startswith(
                "uv run --no-project scripts/make_updates_json.py"
            )


def test_release_test_job_runs_the_tests():
    job = load("release.yml")["jobs"]["test"]
    text = "\n".join(s.get("run", "") for s in steps(job))
    assert "node --test tests/unit/*.test.mjs" in text
    assert "pytest tests/install tests/release" in text


def test_release_passes_the_tag_only_through_env():
    for job in load("release.yml")["jobs"].values():
        for step in steps(job):
            assert "${{" not in step.get("run", ""), step["run"]


def test_release_checks_the_published_xpi_against_update_hash():
    job = load("release.yml")["jobs"]["release"]
    text = "\n".join(s.get("run", "") for s in steps(job))
    after = text[text.index("gh release create") :]
    assert "gh release download" in after
    assert "sha256sum" in after
    assert ".update_hash" in after


def test_release_checks_the_tag_and_attaches_one_xpi_and_updates_json():
    wf = load("release.yml")
    text = runs(wf)
    assert '--expect-tag "$GITHUB_REF_NAME"' in text
    assert "scripts/make_updates_json.py" in text
    create = [line for line in text.splitlines() if "gh release create" in line]
    assert len(create) == 1
    assert '"$XPI" dist/updates.json' in create[0]
    assert "--verify-tag" in create[0] and "--latest" in create[0]
    # Fails before publishing unless the build left exactly one XPI.
    assert "expected exactly one .xpi" in text
