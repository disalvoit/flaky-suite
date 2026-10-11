// limiter.js - a persisted sliding-window rate limiter.
//
 // One JSON file holds the state so a limit survives a process restart. The
 // contract is written down in README.md; the test suite is the referee.

import { readFile, writeFile, rename } from "node:fs/promises";

export function emptyState() {
  return { hits: {} };
}

export async function readState(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
  const parsed = JSON.parse(raw);
  return { hits: parsed.hits ?? {} };
}

export async function writeState(file, state) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, file);
}

export function createLimiter({ file, windowMs = 1000, max = 3, now = Date.now }) {
  if (!file) throw new TypeError("createLimiter: `file` is required");
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError("createLimiter: `max` must be a non-negative integer");
  }
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError("createLimiter: `windowMs` must be >= 0");
  }

  let mutex = Promise.resolve();

  const runExclusive = (fn) => {
    mutex = mutex.then(fn, fn);
    return mutex;
  };

  const prune = (hits, t) => hits.filter((h) => t - h < windowMs);

  return {
    file,
    windowMs,
    max,

    // Returns true when the call is allowed, false when it is over the limit.
    async allow(key = "default") {
      return runExclusive(async () => {
        const state = await readState(file);
        const t = now();
        const hits = prune(state.hits[key] ?? [], t);
        if (hits.length >= max) return false;
        hits.push(t);
        state.hits[key] = hits;
        await writeState(file, state);
        return true;
      });
    },

    // Number of hits currently counted for `key` (pruned against `now()`).
    async peek(key = "default") {
      const state = await readState(file);
      const t = now();
      return prune(state.hits[key] ?? [], t).length;
    },
  };
}
