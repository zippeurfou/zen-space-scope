export function originKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return parsed.port ? `${host}:${parsed.port}` : host;
}

export class ContainerIndex {
  #urls = new Map();
  #origins = new Map();

  addVisit(url, ucid) {
    let containers = this.#urls.get(url);
    if (!containers) {
      containers = new Set();
      this.#urls.set(url, containers);
    }
    containers.add(ucid);

    const origin = originKey(url);
    if (origin === null) {
      return;
    }
    let urls = this.#origins.get(origin);
    if (!urls) {
      urls = new Set();
      this.#origins.set(origin, urls);
    }
    urls.add(url);
  }

  removeUrl(url) {
    this.#urls.delete(url);
    const origin = originKey(url);
    if (origin === null) {
      return;
    }
    const urls = this.#origins.get(origin);
    if (!urls) {
      return;
    }
    urls.delete(url);
    if (urls.size === 0) {
      this.#origins.delete(origin);
    }
  }

  clear() {
    this.#urls.clear();
    this.#origins.clear();
  }

  urlContainers(url) {
    return this.#urls.get(url);
  }

  originContainers(url) {
    const origin = originKey(url);
    const urls = origin === null ? undefined : this.#origins.get(origin);
    if (!urls) {
      return undefined;
    }
    const union = new Set();
    for (const u of urls) {
      for (const ucid of this.#urls.get(u) ?? []) {
        union.add(ucid);
      }
    }
    return union;
  }

  // Containers that visited `prefix` itself or, when it ends in "/", a URL
  // of its origin whose full string starts with it (ruling R38). A prefix
  // that stops inside a path segment (".../doc" for ".../docs/x") matches
  // only its own visits.
  urlPrefixContainers(prefix) {
    const union = new Set(this.#urls.get(prefix) ?? []);
    if (typeof prefix !== "string" || !prefix.endsWith("/")) {
      return union;
    }
    const origin = originKey(prefix);
    for (const u of (origin === null ? undefined : this.#origins.get(origin)) ?? []) {
      if (u.startsWith(prefix)) {
        for (const ucid of this.#urls.get(u) ?? []) {
          union.add(ucid);
        }
      }
    }
    return union;
  }

  get urlCount() {
    return this.#urls.size;
  }
}
