import { test } from "node:test";
import assert from "node:assert/strict";
import { ContainerIndex, originKey } from "../../src/lib/index.mjs";

test("addVisit indexes the url and its origin, ignoring www", () => {
  const idx = new ContainerIndex();
  idx.addVisit("https://www.lemonde.fr/a", 6);
  assert.deepEqual([...idx.urlContainers("https://www.lemonde.fr/a")], [6]);
  assert.deepEqual([...idx.originContainers("https://lemonde.fr/b")], [6]);
  assert.equal(idx.urlCount, 1);
});

test("a second visit in another container gives the union", () => {
  const idx = new ContainerIndex();
  idx.addVisit("https://www.lemonde.fr/a", 6);
  idx.addVisit("https://www.lemonde.fr/a", 0);
  assert.deepEqual([...idx.urlContainers("https://www.lemonde.fr/a")].sort(), [0, 6]);
});

test("origin containers are the union over its urls", () => {
  const idx = new ContainerIndex();
  idx.addVisit("https://a.com/1", 1);
  idx.addVisit("https://a.com/2", 2);
  assert.deepEqual([...idx.originContainers("https://a.com/")].sort(), [1, 2]);
});

test("removeUrl drops the url and the origin once its last url is gone", () => {
  const idx = new ContainerIndex();
  idx.addVisit("https://a.com/1", 1);
  idx.addVisit("https://a.com/2", 2);
  idx.removeUrl("https://a.com/1");
  assert.equal(idx.urlContainers("https://a.com/1"), undefined);
  assert.deepEqual([...idx.originContainers("https://a.com/")], [2]);
  idx.removeUrl("https://a.com/2");
  assert.equal(idx.originContainers("https://a.com/"), undefined);
  assert.equal(idx.urlCount, 0);
});

test("clear empties everything", () => {
  const idx = new ContainerIndex();
  idx.addVisit("https://a.com/1", 1);
  idx.clear();
  assert.equal(idx.urlCount, 0);
  assert.equal(idx.urlContainers("https://a.com/1"), undefined);
  assert.equal(idx.originContainers("https://a.com/1"), undefined);
});

test("originKey handles non-http, ports, and invalid input", () => {
  assert.equal(originKey("about:config"), null);
  assert.equal(originKey("not a url"), null);
  assert.equal(originKey("http://localhost:8080/x"), "localhost:8080");
  assert.equal(originKey("https://WWW.Example.com:443/x"), "example.com");
});

test("urlPrefixContainers: union over the origin's urls that start with the prefix", () => {
  const idx = new ContainerIndex();
  idx.addVisit("http://wiki.test/foo/bar", 0);
  idx.addVisit("http://wiki.test/foo/baz", 6);
  idx.addVisit("http://wiki.test/other", 2);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/foo/")].sort(), [0, 6]);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/foo/bar")], [0]);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/")].sort(), [0, 2, 6]);
});

test("urlPrefixContainers: empty set when nothing starts with the prefix", () => {
  const idx = new ContainerIndex();
  idx.addVisit("http://wiki.test/foo/bar", 0);
  assert.equal(idx.urlPrefixContainers("http://wiki.test/fob/").size, 0);
  assert.equal(idx.urlPrefixContainers("http://other.test/").size, 0);
  assert.equal(idx.urlPrefixContainers("about:config").size, 0);
  assert.equal(idx.urlPrefixContainers("not a url").size, 0);
});

test("urlPrefixContainers compares full url strings, not just paths", () => {
  const idx = new ContainerIndex();
  idx.addVisit("https://www.wiki.test/foo/bar", 6);
  // Same origin key (www. ignored), but a different url string.
  assert.equal(idx.urlPrefixContainers("http://wiki.test/foo/").size, 0);
  assert.deepEqual([...idx.urlPrefixContainers("https://www.wiki.test/foo/")], [6]);
});

test("urlPrefixContainers forgets removed urls", () => {
  const idx = new ContainerIndex();
  idx.addVisit("http://wiki.test/foo/bar", 6);
  idx.removeUrl("http://wiki.test/foo/bar");
  assert.equal(idx.urlPrefixContainers("http://wiki.test/foo/").size, 0);
});

// R38: a prefix counts only when it is the whole url or ends in "/".
test("urlPrefixContainers: a prefix that stops inside a path segment matches nothing", () => {
  const idx = new ContainerIndex();
  idx.addVisit("http://wiki.test/docs/x", 0);
  idx.addVisit("http://wiki.test/doc", 6);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/doc")], [6]);
  assert.equal(idx.urlPrefixContainers("http://wiki.test/do").size, 0);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/docs/")], [0]);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/docs/x")], [0]);
});

test("urlPrefixContainers: a url ending in a slash also counts its own visits", () => {
  const idx = new ContainerIndex();
  idx.addVisit("http://wiki.test/docs/", 2);
  idx.addVisit("http://wiki.test/docs/x", 0);
  assert.deepEqual([...idx.urlPrefixContainers("http://wiki.test/docs/")].sort(), [0, 2]);
});
