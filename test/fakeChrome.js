/**
 * Minimal in-memory stand-in for `chrome.storage.sync` with the same callback
 * contract, so the storage layer can be exercised without a browser.
 */

export function createFakeAdapter({ quotaBytes = Infinity, maxItems = Infinity } = {}) {
  let data = {};
  const listeners = new Set();

  const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value) ?? "").length;

  function bytesInUse(keys, source = data) {
    const target = keys === null || keys === undefined ? Object.keys(source) : keys;
    return target.reduce((total, key) => (key in source ? total + bytesOf(source[key]) : total), 0);
  }

  function emit(changes) {
    if (Object.keys(changes).length === 0) return;
    for (const listener of listeners) {
      listener(changes, "sync");
    }
  }

  return {
    areaName: "sync",
    get data() {
      return data;
    },
    setData(next) {
      data = next;
    },

    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (key in data) out[key] = data[key];
      }
      return out;
    },

    async set(items) {
      const next = { ...data, ...items };
      if (Object.keys(next).length > maxItems) {
        throw new Error("MAX_ITEMS quota exceeded");
      }
      if (bytesInUse(Object.keys(next), next) > quotaBytes) {
        throw new Error("QUOTA_BYTES quota exceeded");
      }

      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: value };
      }
      data = next;
      emit(changes);
    },

    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (!(key in data)) continue;
        changes[key] = { oldValue: data[key], newValue: undefined };
        delete data[key];
      }
      emit(changes);
    },

    async clear() {
      const old = data;
      data = {};
      emit(Object.fromEntries(Object.entries(old).map(([key, value]) => [key, { oldValue: value, newValue: undefined }])));
    },

    async getBytesInUse(keys) {
      return bytesInUse(keys);
    },

    /** Test hook: simulate a change pushed by another device. */
    pushExternal(changes) {
      const applied = {};
      for (const [key, value] of Object.entries(changes)) {
        applied[key] = { oldValue: data[key], newValue: value };
        if (value === undefined) delete data[key];
        else data[key] = value;
      }
      emit(applied);
    },

    onChanged: {
      addListener(fn) {
        listeners.add(fn);
      },
      removeListener(fn) {
        listeners.delete(fn);
      },
    },
  };
}

/** Install a global `chrome` whose storage.sync is the supplied fake. */
export function installChromeStub(adapter) {
  const session = new Map();
  globalThis.chrome = {
    storage: {
      sync: adapter,
      session: {
        async get(key) {
          return session.has(key) ? { [key]: session.get(key) } : {};
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
        },
        async remove(key) {
          session.delete(key);
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
      onChanged: adapter.onChanged,
    },
    runtime: { lastError: undefined },
  };
  return globalThis.chrome;
}
