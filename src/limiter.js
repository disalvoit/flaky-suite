// limiter.js - a persisted sliding-window rate limiter.
//
// One JSON file holds the state so a limit survives a process restart. The
// contract is written down in README.md; the test suite is the referee.

import { readFile, writeFile, rename } from "node:fs/promises";

// A limiter may be used from several callers at once. The read-modify-write in
// `allow` is not atomic on its own, so every operation on a given state file is
// serialized through a per-file promise chain. Without this, concurrent callers
// read the same snapshot and each writes back an increment, losing hits.
const locks = new Map();

function withLock(file, fn) {
  const prev = locks.get(file) ?? Promise.resolve();
  const result = prev.then(() => fn());
  locks.set(file, result.then(() => {}, () => {}));
  return result;
}

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

let tmpCounter = 0;

export async function writeState(file, state) {
  // Write to a sibling temp file first, then rename over the target. rename is
  // atomic within a filesystem, so a reader never observes a partial file.
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
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

  return {
    file,
    windowMs,
    max,

    // Returns true when the call is allowed, false when it is over the limit.
    async allow(key = "default") {
      return withLock(file, async () => {
        const state = await readState(file);
        const t = now();
        // A hit is live while now() - hit < windowMs: at exactly hit + windowMs
        // it has left the window.
        const hits = (state.hits[key] ?? []).filter((h) => t - h < windowMs);
        if (hits.length >= max) return false;
        hits.push(t);
        state.hits[key] = hits;
        await writeState(file, state);
        return true;
      });
    },

    // Number of hits currently counted for `key` (pruned against `now()`).
    async peek(key = "default") {
      return withLock(file, async () => {
        const state = await readState(file);
        const t = now();
        return (state.hits[key] ?? []).filter((h) => t - h < windowMs).length;
      });
    },
  };
}
