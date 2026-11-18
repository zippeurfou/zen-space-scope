"use strict";

const $ = id => document.getElementById(id);
const LOG_REFRESH_MS = 2000;

let busy = false;

function render(status) {
  const state = $("state");
  state.textContent = status.state;
  state.dataset.state = status.state;
  $("version").textContent = status.version;
  $("url-count").textContent = String(status.urlCount);
  $("bookmarks").textContent = status.bookmarks;

  $("failed").textContent = status.failedChecks.join(", ");
  $("failed-box").hidden = status.failedChecks.length === 0;
  // A failure while the add-on was loading is only retried by a restart.
  $("retry").textContent = status.canRetry
    ? "Switch the add-on on again to retry."
    : "This happened while the add-on was starting. Restart Zen to retry.";

  const list = $("conflicts");
  list.replaceChildren(
    ...status.conflicts.map(conflict => {
      const item = document.createElement("li");
      const where = conflict.ucid === 0 ? "no container" : `container ${conflict.ucid}`;
      item.textContent = `${conflict.spaces.join(", ")} (${where})`;
      return item;
    })
  );
  $("conflict-list").hidden = status.conflicts.length === 0;
  $("no-conflicts").hidden = status.conflicts.length !== 0;

  // Switching on from "fail-closed" retries the self-check, when it can.
  $("enabled").checked = status.state === "active";
  $("enabled").disabled =
    busy || status.state === "starting" || (status.state === "fail-closed" && !status.canRetry);
  $("debug").checked = status.debug;
  $("debug").disabled = false;
}

async function refreshStatus() {
  render(await browser.spaceScope.getStatus());
}

async function refreshLog() {
  const lines = await browser.spaceScope.getLog();
  const log = $("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = lines.join("\n");
  if (atBottom) {
    log.scrollTop = log.scrollHeight;
  }
}

async function run(action) {
  busy = true;
  $("enabled").disabled = true;
  try {
    await action();
  } catch (e) {
    $("state").textContent = `error: ${e}`;
  } finally {
    busy = false;
    await refreshStatus().catch(() => {});
  }
}

$("enabled").addEventListener("change", event => {
  const on = event.target.checked;
  run(() => browser.spaceScope.setEnabled(on));
});

$("debug").addEventListener("change", event => {
  const on = event.target.checked;
  run(async () => {
    await browser.spaceScope.setDebug(on);
    await refreshLog();
  });
});

$("refresh-log").addEventListener("click", () => refreshLog().catch(() => {}));

refreshStatus().catch(e => {
  $("state").textContent = `error: ${e}`;
});
refreshLog().catch(() => {});
setInterval(() => {
  if (!busy) {
    refreshStatus().catch(() => {});
    if ($("debug").checked) {
      refreshLog().catch(() => {});
    }
  }
}, LOG_REFRESH_MS);
