import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLimiter } from "../src/limiter.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "flaky-suite-"));
  return { file: join(dir, "state.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("allows calls up to the limit inside the window", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  const lim = createLimiter({ file, windowMs: 1000, max: 3 });

  assert.equal(await lim.allow("k"), true);
  assert.equal(await lim.allow("k"), true);
  assert.equal(await lim.allow("k"), true);
  assert.equal(await lim.allow("k"), false);
  assert.equal(await lim.peek("k"), 3);
});

test("a hit at the exact window boundary no longer counts", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  let clock = 1_000_000;
  const lim = createLimiter({ file, windowMs: 25, max: 1, now: () => clock });

  assert.equal(await lim.allow("k"), true);
  assert.equal(await lim.allow("k"), false);

  clock += 24;
  assert.equal(await lim.allow("k"), false, "a hit 24ms old is still inside a 25ms window");

  clock += 1;
  assert.equal(await lim.allow("k"), true, "a hit 25ms old is outside the window");
});

test("state survives a new limiter instance", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  const first = createLimiter({ file, windowMs: 5000, max: 2 });
  assert.equal(await first.allow("k"), true);
  assert.equal(await first.allow("k"), true);

  const second = createLimiter({ file, windowMs: 5000, max: 2 });
  assert.equal(await second.allow("k"), false);
  assert.equal(await second.peek("k"), 2);
});

test("a staggered burst never exceeds the limit", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  const lim = createLimiter({ file, windowMs: 5000, max: 3 });

  // five callers arrive a couple of milliseconds apart, all inside the window
  const verdicts = await Promise.all(
    [0, 2, 4, 6, 8].map(async (ms) => {
      await sleep(ms);
      return lim.allow("k");
    }),
  );
  const allowed = verdicts.filter(Boolean).length;
  assert.equal(allowed, 3, `expected 3 of 5 calls to be allowed, got ${allowed}`);
  assert.equal(await lim.peek("k"), 3);
});

test("concurrent callers on different keys stay independent", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  const lim = createLimiter({ file, windowMs: 5000, max: 1 });

  const plan = [
    ["a", 0],
    ["b", 0],
    ["a", 2],
    ["b", 2],
    ["a", 4],
    ["b", 4],
  ];
  const verdicts = await Promise.all(
    plan.map(async ([key, ms]) => {
      await sleep(ms);
      return lim.allow(key);
    }),
  );
  assert.equal(verdicts.filter(Boolean).length, 2, "each key allows exactly one call");
  assert.equal(await lim.peek("a"), 1);
  assert.equal(await lim.peek("b"), 1);
});

test("peek reports the count pruned against the window", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  let clock = 500_000;
  const lim = createLimiter({ file, windowMs: 30, max: 5, now: () => clock });

  await lim.allow("k");
  await lim.allow("k");
  assert.equal(await lim.peek("k"), 2);

  clock += 60;
  assert.equal(await lim.peek("k"), 0);
});

test("max = 0 denies everything", async (t) => {
  const { file, cleanup } = await scratch();
  t.after(cleanup);
  const lim = createLimiter({ file, windowMs: 1000, max: 0 });
  assert.equal(await lim.allow("k"), false);
  assert.equal(await lim.peek("k"), 0);
});

test("rejects invalid options", () => {
  assert.throws(() => createLimiter({ file: "/tmp/x.json", max: -1 }), RangeError);
  assert.throws(() => createLimiter({ file: "/tmp/x.json", windowMs: -5 }), RangeError);
  assert.throws(() => createLimiter({}), TypeError);
});
