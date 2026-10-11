// limiter.js - a persisted sliding-window rate limiter.
//
// One JSON file holds the state so a limit survives a process restart. The
// contract is written down in README.md; the test suite is the referee.

import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";

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

// Write to a private temp file and rename it into place, so a reader can only
// ever observe the previous complete state or the new complete state, never a
// truncated file.
export async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Serialises the read-modify-write cycle per state file, so concurrent
// callers cannot read the same state, both decide they are under the limit,
// and then clobber each other's write. Limiter instances that point at the
// same file share one queue, which is what makes `allow` linearizable:
// callers are granted in queue order and exactly `max` of them win per window.
const queues = new Map();

function withFileLock(file, task) {
  const previous = queues.get(file) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(file, tail);
  tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return run;
}

export function createLimiter({ file, windowMs = 1000, max = 3, now = Date.now }) {
  if (!file) throw new TypeError("createLimiter: `file` is required");
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError("createLimiter: `max` must be a non-negative integer");
  }
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError("createLimiter: `windowMs` must be >= 0");
  }

  // A hit is live while `now() - hit < windowMs`, so at exactly
  // `hit + windowMs` it has expired (and with `windowMs = 0` nothing is ever
  // live, so every call is allowed).
  const live = (hits, t) => hits.filter((h) => t - h < windowMs);

  return {
    file,
    windowMs,
    max,

    // Returns true when the call is allowed, false when it is over the limit.
    async allow(key = "default") {
      return withFileLock(file, async () => {
        const state = await readState(file);
        const t = now();
        const hits = live(state.hits[key] ?? [], t);
        if (hits.length >= max) return false;
        hits.push(t);
        state.hits[key] = hits;
        await writeState(file, state);
        return true;
      });
    },

    // Number of hits currently counted for `key` (pruned against `now()`).
    async peek(key = "default") {
      return withFileLock(file, async () => {
        const state = await readState(file);
        return live(state.hits[key] ?? [], now()).length;
      });
    },
  };
}
