import test from "node:test";
import assert from "node:assert/strict";
import { describe } from "../../src/glue/describe.sys.mjs";
import { classify, KIND } from "../../src/lib/rules.mjs";

// The RESULT_TYPE / RESULT_SOURCE tables of Zen 1.24.2b
// (browser/chrome/browser/content/browser/urlbar/UrlbarShared.mjs:218-262).
const UrlbarShared = {
  RESULT_TYPE: Object.freeze({
    TAB_SWITCH: 1, SEARCH: 2, URL: 3, KEYWORD: 4, OMNIBOX: 5, REMOTE_TAB: 6,
    TIP: 7, DYNAMIC: 8, RESTRICT: 9, AI_CHAT: 10,
  }),
  RESULT_SOURCE: Object.freeze({
    BOOKMARKS: 1, HISTORY: 2, SEARCH: 3, TABS: 4, OTHER_LOCAL: 5,
    OTHER_NETWORK: 6, ADDON: 7, ACTIONS: 8, ZEN_ACTIONS: 9, WORKSPACES: 10,
  }),
};
const { RESULT_TYPE: T, RESULT_SOURCE: S } = UrlbarShared;

// Shaped like a 2b UrlbarResult: getters for type, source, heuristic,
// autofill, payload and providerName (UrlbarResult.mjs:48-420).
class StubResult {
  #f;
  constructor(fields) {
    this.#f = { heuristic: false, autofill: undefined, providerName: undefined, ...fields };
  }
  get type() { return this.#f.type; }
  get source() { return this.#f.source; }
  get heuristic() { return this.#f.heuristic; }
  get autofill() { return this.#f.autofill; }
  get payload() { return this.#f.payload; }
  get providerName() { return this.#f.providerName; }
}
const provider = (name) => ({ name });

test("a Places history row", () => {
  const result = new StubResult({
    type: T.URL, source: S.HISTORY,
    payload: { url: "http://lemonde.test/a", title: "lemonde.test a" },
  });
  assert.deepEqual(describe(provider("UrlbarProviderPlaces"), result, UrlbarShared), {
    provider: "UrlbarProviderPlaces",
    type: "URL",
    source: "HISTORY",
    heuristic: false,
    autofillType: null,
    autofillFallback: false,
    url: "http://lemonde.test/a",
    tabContainer: null,
  });
});

test("an origin autofill carries autofill.type (UrlbarProviderAutofill.sys.mjs:984,1098-1109)", () => {
  const result = new StubResult({
    type: T.URL, source: S.HISTORY, heuristic: true,
    autofill: { type: "origin", value: "lemonde.test/", selectionStart: 3, selectionEnd: 13 },
    payload: { url: "http://lemonde.test/" },
  });
  const d = describe(provider("UrlbarProviderAutofill"), result, UrlbarShared);
  assert.equal(d.autofillType, "origin");
  assert.equal(d.heuristic, true);
  assert.equal(classify(d), KIND.AUTOFILL_ORIGIN);
});

test("a URL autofill", () => {
  const result = new StubResult({
    type: T.URL, source: S.HISTORY, heuristic: true,
    autofill: { type: "url", value: "lemonde.test/secret" },
    payload: { url: "http://lemonde.test/secret" },
  });
  const d = describe(provider("UrlbarProviderAutofill"), result, UrlbarShared);
  assert.equal(d.autofillType, "url");
  assert.equal(classify(d), KIND.AUTOFILL_URL);
});

test("a switch-to-tab row takes its container from payload.userContext.id (UrlbarUtils.sys.mjs:1308-1326)", () => {
  const result = new StubResult({
    type: T.TAB_SWITCH, source: S.TABS,
    payload: { url: "http://zillow.test/a", userContext: { id: 6, label: "Perso" } },
  });
  const d = describe(provider("UrlbarProviderOpenTabs"), result, UrlbarShared);
  assert.equal(d.type, "TAB_SWITCH");
  assert.equal(d.source, "TABS");
  assert.equal(d.tabContainer, 6);
  assert.equal(classify(d), KIND.SWITCH_TAB);
});

test("container 0 is a container, not a missing one", () => {
  const result = new StubResult({
    type: T.TAB_SWITCH, source: S.TABS,
    payload: { url: "http://zillow.test/a", userContext: { id: 0 } },
  });
  assert.equal(describe(provider("UrlbarProviderOpenTabs"), result, UrlbarShared).tabContainer, 0);
});

test("a tab row without a container gives a null tabContainer", () => {
  const result = new StubResult({
    type: T.TAB_SWITCH, source: S.TABS, payload: { url: "http://zillow.test/a" },
  });
  assert.equal(describe(provider("UrlbarProviderOpenTabs"), result, UrlbarShared).tabContainer, null);
});

test("a row without a url, such as the calculator", () => {
  const result = new StubResult({
    type: T.DYNAMIC, source: S.OTHER_LOCAL, payload: { input: "2+2" },
  });
  const d = describe(provider("UrlbarProviderCalculator"), result, UrlbarShared);
  assert.equal(d.type, "DYNAMIC");
  assert.equal(d.source, "OTHER_LOCAL");
  assert.equal(d.url, null);
  assert.equal(classify(d), KIND.CALCULATOR);
});

test("Zen's own sources resolve to their names", () => {
  const result = new StubResult({
    type: T.DYNAMIC, source: S.WORKSPACES, payload: {},
  });
  const d = describe(provider("ZenUrlbarProviderGlobalActions"), result, UrlbarShared);
  assert.equal(d.source, "WORKSPACES");
  assert.equal(classify(d), KIND.ZEN_ACTION);
});

test("a type or source the table does not know gives null, and classifies UNKNOWN", () => {
  const result = new StubResult({ type: 99, source: 42, payload: { url: "http://a.test/" } });
  const d = describe(provider("UrlbarProviderPlaces"), result, UrlbarShared);
  assert.equal(d.type, null);
  assert.equal(d.source, null);
  assert.equal(classify(d), KIND.UNKNOWN);
});

test("the provider argument's name wins over result.providerName", () => {
  const result = new StubResult({
    type: T.URL, source: S.HISTORY, providerName: "Other", payload: { url: "http://a.test/" },
  });
  assert.equal(describe(provider("UrlbarProviderPlaces"), result, UrlbarShared).provider,
    "UrlbarProviderPlaces");
  assert.equal(describe(null, result, UrlbarShared).provider, "Other");
  assert.equal(describe(null, new StubResult({ type: T.URL, source: S.HISTORY, payload: {} }),
    UrlbarShared).provider, "");
});

test("a non-string payload url is ignored", () => {
  const result = new StubResult({ type: T.URL, source: S.HISTORY, payload: { url: 42 } });
  assert.equal(describe(provider("UrlbarProviderPlaces"), result, UrlbarShared).url, null);
});

test("the origin row that accompanies adaptive autofill is flagged (UrlbarProviderAutofill.sys.mjs:1280-1293)", () => {
  const result = new StubResult({
    type: T.URL, source: S.HISTORY,
    payload: { url: "http://wiki.test/", title: "wiki", isAutofillFallback: true },
  });
  const d = describe(provider("UrlbarProviderAutofill"), result, UrlbarShared);
  assert.equal(d.autofillFallback, true);
  assert.equal(d.heuristic, false);
  assert.equal(classify(d), KIND.AUTOFILL_URL);
});
