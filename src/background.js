"use strict";

browser.spaceScope.start().then(
  status => {
    if (status.state !== "active") {
      console.error("[zen-space-scope] not active:", JSON.stringify(status));
    }
  },
  error => console.error("[zen-space-scope] start failed:", error)
);
