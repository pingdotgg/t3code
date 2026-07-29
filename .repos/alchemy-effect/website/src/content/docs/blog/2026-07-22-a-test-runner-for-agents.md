---
title: A Test Runner for Agents
date: 2026-07-22T07:00:00Z
excerpt: Alchemy's test suite is 4,000+ live tests against real clouds, and some take minutes. Vitest forked processes and reloaded our generated SDK on every fork; bun test assumes tests are fast and runs them one file at a time. So we wrote our own runner — one bun process, everything concurrent, plain output tuned for agents and a live TUI for humans.
---

Alchemy's test suite is not a normal test suite. It's **4,000+
live tests** that deploy real resources to real clouds and tear
them down again. Some finish in milliseconds. Some take minutes —
provisioning an EKS cluster, waiting for an eventually consistent
API to converge, pushing a message through a queue and polling
until it comes out the other side.

That shape broke every runner we tried. So we built our own:
[`alchemy-test`](https://github.com/alchemy-run/alchemy/tree/main/packages/alchemy-test)
([#848](https://github.com/alchemy-run/alchemy/pull/848)), a
vitest-compatible runner built for our scale: the entire suite
runs in a single bun process, plain output is designed for the
agent reading it, and an interactive TUI gives humans a live view
of a run with thousands of tests in flight.

## Why not vitest

Vitest parallelizes across workers, and every worker builds its
own module graph — threads don't share modules any more than
forks do. Everything alchemy depends on includes
[distilled](https://github.com/alchemy-run/distilled), our
generated AWS/Cloudflare SDK, which spans hundreds of service
modules. Paying that import cost once is fine. Paying it per
worker, hundreds of times per run, is not.

There's no way out of that trade-off inside vitest. It can run
everything in one worker (`singleFork` with `isolate: false`) —
but [by vitest's own
docs](https://vitest.dev/config/#pooloptions-forks-singlefork)
that "will force tests to run one after another", and source code
processed by vite "will still be reevaluated for each test" even
then. Parallel files mean many workers; one worker means a
sequential suite. The quadrant we needed — many files in flight,
one module graph — doesn't exist.

For us it was worse than that. Our toolchain runs on bun, and
bun's `worker_threads` segfaults under vitest's tinypool at
worker spawn — so we were pinned to `pool: "forks"`, full
`child_process` forks, the most expensive flavor of an already
expensive design. And no, "just run tests on node" doesn't fix
it: the per-worker import cost is the same, and node can't
execute distilled's TypeScript natively, so a transform layer
comes back.

The module cost also made iteration slow in a way that hurt
agents most. To load distilled's TypeScript source in vitest we
needed a rolldown plugin; the alternative was compiling
distilled's `.ts` to `.js` before every run. Either way there was
a build step between "agent edits code" and "agent sees the test
result". Agents iterate on failing tests in tight loops — every
second of compile tax is paid dozens of times per task.

## Why not bun test

`bun test` solves both problems: it's bun-native, so `.ts` loads
directly with no plugin and no compile step. But it runs test
files one at a time, an assumption that only works when tests are
fast.

Alchemy tests are slow on purpose — they wait for real clouds. Run
them sequentially and a directory that should take two minutes
takes an hour. We needed dozens of files in flight at once, in one
process, on bun.

## One process, everything concurrent

`alchemy-test` imports every test file up front (imports are cheap
when they happen once) and then runs files and tests concurrently
on the Effect runtime — fibers, not forks. A `--concurrency` flag
bounds how many files run at once, and tests that mutate global
state can take a whole-process lock with `{ exclusive: true }`.

The CLI is vitest-compatible — positional paths, `-t` filters,
timeouts, retries — so the migration was a codemod.

```sh
bun run test test/Cloudflare/Workers -t "cron"
```

## Output an agent can act on

Performance forced our hand, but once we owned the runner we
could fix something that had bothered us just as long: the
output.

Vitest's default reporter prints stdout noisily: interleaved
across parallel tests, indented and reflowed on top of your raw
output. When a test fails, the error is somewhere in the scroll.
We watched agents run a suite, `tail` the output to save context,
and lose the one error they needed — even when prompted not to.
A custom reporter can quiet some of this, but it works by
intercepting `console` and guessing which test a log belongs to —
best-effort attribution you're consuming, not controlling.

Our tests are Effects, which means we control the runtime they
execute in. Each test runs under a buffering `Logger` and
`Console`, so every log line is captured and attributed to its
test by construction — nothing interleaves, nothing prints as it
happens. The console gets exactly one line per test:

```
✓ test/Cloudflare/Workers/Subdomain.test.ts > enable and disable the workers.dev subdomain (3.2s)
✓ test/Cloudflare/Workers/Rpc.test.ts > detects valid envelope (1ms)
✗ test/Cloudflare/Workers/Route.test.ts > replaces the route when the zone changes (12.4s)
  AssertionError: expected "alchemy-test-2.us/api/*" to be "alchemy-test-2.us/v2/*"
      at test/Cloudflare/Workers/Route.test.ts:87:22
  --- captured output ---
  Plan: 1 to replace
  [route] deleting
  [route] created
  --- end output ---
✓ test/Cloudflare/Workers/Workflow.test.ts > runs a workflow to completion (51.9s)
```

A failing test prints its error and its captured output inline,
immediately, while the run continues. Passing tests stay silent —
their output would be noise.

If nothing finishes for ten seconds, the runner prints what's
still running, so a hang is diagnosable from the console instead
of a mystery:

```
⧗ [16:38:12] no tests finished in the last 10s — 2 still running:
    test/Cloudflare/Workers/Workflow.test.ts > runs a workflow to completion (48.1s)
    test/Cloudflare/Workers/CronEventSource.test.ts > cron handler fires (32.7s)
```

And the run ends by telling the agent exactly how to go deeper:
the summary, the failures repeated in one place, and a per-run
log file — with its size, so the agent knows whether to read it
or search it:

```
Tests: 1 failed | 171 passed | 1 skipped (31 files, 89.3s)

Full log: .alchemy/log/test/2026-07-16T23-42-38-pid92186.log (1055 lines, 118 KB)
```

The log file has everything the console suppressed: every test's
captured output, passes included, written color-free as the run
progresses. Each run gets its own timestamped file, so concurrent
runs in different terminals never trample each other. The console
is the summary; the log is the record. The agent reads the one
line it needs and greps the file when it needs more.

## Humans get a TUI

For interactive use, `--tui` opens a k9s-style live view: a
collapsible file/test tree, type-to-filter, and retry/kill on
running tests:

```
 alchemy-test  ✓ 159  ✗ 0  ◐ 7  · 5  │ 53.4s
 ▸ ✓ test/Cloudflare/Workers/AccountSetting.test.ts  3/3 passed
 ▾ ◐ test/Cloudflare/Workers/DurableObjectNamespace.test.ts  2 running · 11/13 passed
     ✓ getByName round-trips state (1.9s)
     ◐ websocket hibernation survives eviction (12.3s…)
 ▸ ◐ test/Cloudflare/Workers/HttpApi.test.ts  5/5 passed  — afterAll running (18.6s)…
 ▸ · test/Cloudflare/Workers/WaitUntil.test.ts  0/2 passed  — waiting for a worker slot…
 ▸ ✓ test/Cloudflare/Workers/Worker.test.ts  17/17 passed
```

Pressing `enter` on a running test live-tails its captured
output — useful when a deploy is three minutes into `beforeAll`
and you want to know what it's doing.

The hotkeys are vim-flavored: `j`/`k` and `ctrl-d`/`ctrl-u` to
move, `/` for live type-to-filter, `p`/`f`/`n`/`s` to toggle
passing, failing, pending, and skipped tests in and out of view.
`r` retries the selected test or file, `R` retries everything
that failed, `x` kills a running test, and `y` copies a failure's
error and captured output to the clipboard — handy for pasting
straight into an agent chat.

## Owning the runner

The whole thing was easy to build — a test harness, a scheduler,
and two reporters over an event stream, in a codebase that
already runs everything on Effect. That's the part worth
underlining: it was cheap to make *because* we only target
Effect, and owning it means the feedback loop is ours to tune.
When we notice agents misreading output, we change the output.
No plugin API in between.

## Where to go next

- [alchemy-test on GitHub](https://github.com/alchemy-run/alchemy/tree/main/packages/alchemy-test)
- [The PR](https://github.com/alchemy-run/alchemy/pull/848)
- [Looping the Generation of IaC and SDKs](/blog/2026-07-02-cloudflare-resource-factory) — the agent fleet this runner feeds
