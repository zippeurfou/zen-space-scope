import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GUARDED_PREFS, setSuggestions } from "../../src/glue/prefs.sys.mjs";

const json = JSON.parse(readFileSync(new URL("../../src/guarded-prefs.json", import.meta.url)));

// A stub of Services.prefs (nsIPrefBranch): typed setters and getters over a
// map, and `locked` names whose writes are ignored, as Firefox does for a
// locked pref's user value.
function stubServices({ locked = [], failing = [] } = {}) {
  const values = new Map();
  const writes = [];
  const set = type => (name, value) => {
    if (failing.includes(name)) {
      throw new Error(`cannot write ${name}`);
    }
    writes.push([type, name, value]);
    if (!locked.includes(name)) {
      values.set(name, value);
    }
  };
  const get = name => {
    if (!values.has(name)) {
      throw new Error(`no value for ${name}`);
    }
    return values.get(name);
  };
  return {
    values,
    writes,
    prefs: {
      setBoolPref: set("bool"),
      setIntPref: set("int"),
      setStringPref: set("string"),
      getBoolPref: get,
      getIntPref: get,
      getStringPref: get,
    },
  };
}

test("GUARDED_PREFS is guarded-prefs.json", () => {
  assert.deepEqual(GUARDED_PREFS, json);
  assert.ok(Object.isFrozen(GUARDED_PREFS));
  for (const p of GUARDED_PREFS) {
    assert.ok(Object.isFrozen(p));
  }
});

test("GUARDED_PREFS covers every history-based suggestion and top sites", () => {
  const names = GUARDED_PREFS.map(p => p.name);
  for (const name of [
    "browser.urlbar.suggest.history",
    "browser.urlbar.suggest.bookmark",
    "browser.urlbar.suggest.openpage",
    "browser.urlbar.suggest.remotetab",
    "browser.urlbar.suggest.recentsearches",
    "browser.urlbar.autoFill",
    // Past searches (form history): 0 means never show them
    // (UrlbarProviderSearchSuggestions.sys.mjs:475-484, ruling R40).
    "browser.urlbar.maxHistoricalSearchSuggestions",
    // browser.urlbar.suggest.topsites is locked in Zen (firefox.js:1662);
    // UrlbarProviderTopSites also needs this one (:35-38, :104-109).
    "browser.newtabpage.activity-stream.feeds.system.topsites",
  ]) {
    assert.ok(names.includes(name), `${name} is not guarded`);
  }
  assert.ok(!names.includes("browser.urlbar.suggest.topsites"), "a locked pref is guarded");
  assert.equal(new Set(names).size, names.length, "a pref is listed twice");
  for (const { name, off, on } of GUARDED_PREFS) {
    assert.equal(typeof off, typeof on, `${name}: off and on differ in type`);
    assert.notEqual(off, on, `${name}: off and on are the same`);
  }
});

test("setSuggestions writes exactly the on values, and nothing else", () => {
  const s = stubServices();
  setSuggestions(true, s, GUARDED_PREFS);
  assert.deepEqual(
    s.writes.map(([, name, value]) => [name, value]),
    GUARDED_PREFS.map(p => [p.name, p.on])
  );
});

test("setSuggestions writes exactly the off values, and nothing else", () => {
  const s = stubServices();
  setSuggestions(false, s, GUARDED_PREFS);
  assert.deepEqual(
    s.writes.map(([, name, value]) => [name, value]),
    GUARDED_PREFS.map(p => [p.name, p.off])
  );
});

test("setSuggestions uses the setter for each value's type", () => {
  const prefs = [
    { name: "a", off: false, on: true },
    { name: "b", off: 0, on: 2 },
    { name: "c", off: "", on: "x" },
  ];
  const s = stubServices();
  setSuggestions(true, s, prefs);
  assert.deepEqual(s.writes, [
    ["bool", "a", true],
    ["int", "b", 2],
    ["string", "c", "x"],
  ]);
});

test("setSuggestions defaults to GUARDED_PREFS", () => {
  const s = stubServices();
  setSuggestions(false, s);
  assert.equal(s.writes.length, GUARDED_PREFS.length);
});

test("setSuggestions throws when a pref does not take its value, after trying them all", () => {
  const prefs = [
    { name: "a", off: false, on: true },
    { name: "locked", off: false, on: true },
    { name: "c", off: false, on: true },
  ];
  const s = stubServices({ locked: ["locked"] });
  assert.throws(() => setSuggestions(false, s, prefs), /locked/);
  assert.deepEqual(
    s.writes.map(([, name]) => name),
    ["a", "locked", "c"]
  );
});

test("setSuggestions keeps turning prefs off when one write throws", () => {
  const prefs = [
    { name: "a", off: false, on: true },
    { name: "broken", off: false, on: true },
    { name: "c", off: false, on: true },
  ];
  const s = stubServices({ failing: ["broken"] });
  assert.throws(() => setSuggestions(false, s, prefs), /broken/);
  assert.equal(s.values.get("a"), false);
  assert.equal(s.values.get("c"), false);
});

test("past searches are guarded with Zen's own default as the on value", () => {
  const pref = GUARDED_PREFS.find(p => p.name === "browser.urlbar.maxHistoricalSearchSuggestions");
  // Zen 1.24.2b: browser/defaults/preferences/firefox.js:140.
  assert.deepEqual({ off: pref?.off, on: pref?.on }, { off: 0, on: 2 });
});

// The block the installer writes into user.js (ruling R4/R29): the two
// add-on prefs, then every guarded pref's off value, between markers.
test("user.js.example is the block built from guarded-prefs.json", () => {
  const text = readFileSync(new URL("../../src/user.js.example", import.meta.url), "utf8");
  const line = (name, value) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;
  const expected = [
    "// zen-space-scope: begin",
    line("xpinstall.signatures.required", false),
    line("extensions.experiments.enabled", true),
    line("extensions.autoDisableScopes", 14),
    line("extensions.startupScanScopes", 1),
    ...json.map(p => line(p.name, p.off)),
    "// zen-space-scope: end",
    "",
  ].join("\n");
  assert.equal(text, expected);
});
