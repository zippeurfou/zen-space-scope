// The prefs that turn history-based address-bar suggestions on and off, from
// src/guarded-prefs.json, the one list the add-on, src/user.js.example and
// the installer share (rulings R4, R29). The user.js block keeps them at their
// `off` values at every startup; the add-on writes `on` only once its
// self-check passes, and `off` again on any failure, disable or shutdown. It
// never writes any other pref.
//
// Zen 1.24.2b locks browser.urlbar.suggest.topsites to true
// (browser/defaults/preferences/firefox.js:1662), so top sites go off through
// browser.newtabpage.activity-stream.feeds.system.topsites, which
// UrlbarProviderTopSites also requires before it returns anything
// (UrlbarProviderTopSites.sys.mjs:35-38, :104-109).

import GUARDED from "../guarded-prefs.json" with { type: "json" };

export const GUARDED_PREFS = Object.freeze(GUARDED.map(p => Object.freeze({ ...p })));

const SETTERS = { boolean: "setBoolPref", number: "setIntPref", string: "setStringPref" };
const GETTERS = { boolean: "getBoolPref", number: "getIntPref", string: "getStringPref" };

// Writes every pref's `on` or `off` value as a user value, then reads it back.
// Every pref is tried even when one fails, so turning suggestions off goes
// as far as it can; then it throws, naming the prefs that did not take their
// value (a locked pref keeps its locked value).
export function setSuggestions(on, Services, prefs = GUARDED_PREFS) {
  const failed = [];
  for (const p of prefs) {
    const value = on ? p.on : p.off;
    const type = typeof value;
    try {
      if (!SETTERS[type]) {
        throw new Error(`unsupported value ${JSON.stringify(value)}`);
      }
      Services.prefs[SETTERS[type]](p.name, value);
      const now = Services.prefs[GETTERS[type]](p.name);
      if (now !== value) {
        throw new Error(`is ${JSON.stringify(now)}, not ${JSON.stringify(value)}`);
      }
    } catch (e) {
      failed.push(`${p.name}: ${e?.message ?? e}`);
    }
  }
  if (failed.length) {
    throw new Error(`could not turn suggestions ${on ? "on" : "off"}: ${failed.join("; ")}`);
  }
}
