# flaky-suite

A tiny, dependency-free sliding-window rate limiter that keeps its state in a JSON
file, so a limit survives a process restart.

```js
import { createLimiter } from "./src/limiter.js";

const limiter = createLimiter({ file: "/tmp/hits.json", windowMs: 1000, max: 5 });
await limiter.allow("user-42"); // true  -> counted
await limiter.allow("user-42"); // false -> over the limit
await limiter.peek("user-42");  // 1     -> hits still inside the window
```

## API

`createLimiter(options) -> { allow(key), peek(key), file, windowMs, max }`

| option     | default   | meaning                                              |
| ---------- | --------- | ---------------------------------------------------- |
| `file`     | –         | path of the JSON state file (required)               |
| `windowMs` | `1000`    | length of the sliding window, in milliseconds        |
| `max`      | `3`       | calls allowed per key per window                     |
| `now`      | `Date.now`| clock, injectable for tests                          |

## Contract

1. **At most `max` calls per key are allowed inside any rolling window of
   `windowMs`.** The limit holds for callers that arrive at the same time, not
   only for callers that wait for each other.
2. **A hit counts only while it is strictly inside the window.** At exactly
   `hit + windowMs` the hit no longer counts, i.e. a hit is live while
   `now() - hit < windowMs`.
3. `max = 0` denies every call. `windowMs = 0` allows every call (no hit is ever
   live).
4. **The state file survives a restart.** A new limiter pointed at the same file
   sees the hits recorded before it was created.
5. **Writes are atomic.** A reader that opens the state file while calls are in
   flight must never see a truncated or half-written file.
6. `now()` moving backwards is not supported; hits recorded "in the future"
   simply stay counted until the window passes them.

## Tests

```bash
npm test        # node --test, Node >= 20, no dependencies
```

The suite is currently **flaky on `main`**: measured on our machine, `a staggered
burst never exceeds the limit` fails 8 runs in 40, and the two other concurrency
/ boundary tests fail on every run. See the issue tracker for the report.
