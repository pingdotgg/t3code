import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as SourceControlReadContext from "@t3tools/source-control-core/server/SourceControlReadContext";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const gateHarness = Effect.gen(function* () {
  const requests: string[] = [];
  const credentials = Layer.succeed(GitHubCredentials.GitHubCredentials, {
    get: (host) =>
      Effect.succeed({
        host,
        token: Redacted.make("gate-test"),
        source: "gh" as const,
        fingerprint: `${host}:gate-test`,
      }),
    invalidate: () => Effect.void,
  });
  const layer = GitHubRequestPolicy.layer.pipe(
    Layer.provide(credentials),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy.pipe(Effect.provide(layer));
  const prepare = Effect.fnUntraced(function* (name: string) {
    const started = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<GitHubRequestPolicy.GitHubAnswer<void>>();
    const ordinaryRead = policy.request(
      { host: "github.com", operation: name, resource: "graphql", allowReserve: false },
      () =>
        Effect.gen(function* () {
          requests.push(`/${name}`);
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(answer);
        }),
    );
    return {
      started,
      ordinaryRead,
      read: ordinaryRead.pipe(Effect.provideService(SourceControlReadContext.Background, true)),
      respond: (
        response: GitHubRequestPolicy.GitHubAnswer<void> = {
          _tag: "Ok",
          status: 200,
          headers: {},
          value: undefined,
        },
      ) => Deferred.succeed(answer, response),
    };
  });
  return { prepare, requests };
});

describe("GitHubRequestPolicy admission", () => {
  it.effect("cancellation during repeated admission handoffs leaves all eight slots usable", () =>
    Effect.gen(function* () {
      const h = yield* gateHarness;
      const held = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, n) => `held-${n}`),
        h.prepare,
      );
      const holding = yield* Effect.forEach(held, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(held, (entry) => Deferred.await(entry.started));
      const queued = yield* Effect.forEach(
        Array.from({ length: 32 }, (_, n) => `queued-${n}`),
        h.prepare,
      );
      const waiting = yield* Effect.forEach(queued, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach([...held, ...queued], (entry) => entry.respond());
      // Force scheduler handoffs inside permit acquisition and its bookkeeping, then race
      // interruption with admission. A lost admission ticket stalls the remaining readers.
      yield* Effect.forEach(
        waiting.filter((_, n) => n % 2 === 0),
        Fiber.interrupt,
      );
      yield* Effect.forEach(holding, Fiber.join);
      yield* Effect.forEach(
        waiting.filter((_, n) => n % 2 === 1),
        Fiber.join,
      );
      const replacements = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, n) => `replacement-${n}`),
        h.prepare,
      );
      const replacementsRunning = yield* Effect.forEach(replacements, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(replacements, (entry) => Deferred.await(entry.started));
      yield* Effect.forEach(replacements, (entry) => entry.respond());
      yield* Effect.forEach(replacementsRunning, Fiber.join);
      expect(h.requests.filter((path) => path.startsWith("/replacement-"))).toHaveLength(8);
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)),
  );
  it.effect("repeating ordinary reads allow queued background HTTP to make progress", () =>
    Effect.gen(function* () {
      // GLOBAL_SLOTS mirrors GitHubRequestPolicy's global gate width. Ordinary readers share that gate with
      // the single background caller admitted at a time, so a fair hand-off lets them run for at
      // most two rounds of slots between background reads. Changing the width is a deliberate
      // concurrency decision and should move these expectations with it.
      const GLOBAL_SLOTS = 8;
      const BACKGROUND_READS = 32;
      const ORDINARY_WORKERS = 8;
      const ORDINARY_READS_PER_WORKER = 10;
      const h = yield* gateHarness;
      const background = yield* Effect.forEach(
        Array.from({ length: BACKGROUND_READS }, (_, index) => `background-${index}`),
        h.prepare,
      );
      const backgroundFibers = yield* Effect.forEach(background, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(background.slice(0, GLOBAL_SLOTS), (entry) =>
        Deferred.await(entry.started),
      );
      yield* Effect.forEach(background.slice(GLOBAL_SLOTS), (entry) => entry.respond());
      const ordinary = yield* Effect.forEach(
        Array.from({ length: ORDINARY_WORKERS }, (_, worker) => worker),
        (worker) =>
          Effect.forEach(
            Array.from(
              { length: ORDINARY_READS_PER_WORKER },
              (_, index) => `ordinary-${worker}-${index}`,
            ),
            (name) => h.prepare(name).pipe(Effect.tap((entry) => entry.respond())),
          ),
      );
      const ordinaryFibers = yield* Effect.forEach(ordinary, (entries) =>
        Effect.forEach(entries, (entry) => entry.ordinaryRead).pipe(
          Effect.forkChild({ startImmediately: true }),
        ),
      );
      yield* Effect.forEach(background.slice(0, GLOBAL_SLOTS), (entry) => entry.respond());
      yield* Effect.forEach(backgroundFibers, Fiber.join);
      yield* Effect.forEach(ordinaryFibers, Fiber.join);
      let remaining = background.length;
      let ordinaryStreak = 0;
      let longestOrdinaryStreak = 0;
      for (const path of h.requests) {
        if (path.startsWith("/background-")) {
          remaining--;
          ordinaryStreak = 0;
        } else if (remaining > 0) {
          ordinaryStreak++;
          longestOrdinaryStreak = Math.max(longestOrdinaryStreak, ordinaryStreak);
        }
      }
      const expectedRequests = BACKGROUND_READS + ORDINARY_WORKERS * ORDINARY_READS_PER_WORKER;
      expect(h.requests).toHaveLength(expectedRequests);
      expect(new Set(h.requests).size).toBe(expectedRequests);
      expect(longestOrdinaryStreak).toBeLessThanOrEqual(GLOBAL_SLOTS * 2);
    }),
  );

  it.effect("parks all but one queued background read outside the gate queue", () =>
    Effect.gen(function* () {
      // Eight held reads occupy the gate. The background reads beyond the first park on the single
      // background admission slot instead of joining the gate queue, so an ordinary read that
      // arrives after them is admitted within a slot turn or two. If every background read camped
      // the gate instead, it would queue behind all eight.
      const GLOBAL_SLOTS = 8;
      const QUEUED_BACKGROUND = 8;
      const h = yield* gateHarness;
      const held = yield* Effect.forEach(
        Array.from({ length: GLOBAL_SLOTS }, (_, index) => `held-${index}`),
        h.prepare,
      );
      const holding = yield* Effect.forEach(held, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(held, (entry) => Deferred.await(entry.started));
      const background = yield* Effect.forEach(
        Array.from({ length: QUEUED_BACKGROUND }, (_, index) => `background-${index}`),
        h.prepare,
      );
      const backgroundFibers = yield* Effect.forEach(background, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      const ordinary = yield* h.prepare("ordinary");
      const ordinaryFiber = yield* ordinary.ordinaryRead.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      expect(h.requests).toHaveLength(GLOBAL_SLOTS);
      // Answer everything, then let the gate drain: admissions keep gate-queue order.
      yield* Effect.forEach([...held, ...background, ordinary], (entry) => entry.respond());
      yield* Effect.forEach([...holding, ...backgroundFibers, ordinaryFiber], Fiber.join);
      const ordinaryIndex = h.requests.indexOf("/ordinary");
      expect(ordinaryIndex).toBeGreaterThanOrEqual(0);
      expect(ordinaryIndex).toBeLessThanOrEqual(GLOBAL_SLOTS + 2);
      expect(h.requests).toHaveLength(GLOBAL_SLOTS + QUEUED_BACKGROUND + 1);
    }),
  );

  it.effect("background admission releases before HTTP and fills all eight global slots", () =>
    Effect.gen(function* () {
      const h = yield* gateHarness;
      const reads = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => `read-${index}`),
        h.prepare,
      );
      const fibers = yield* Effect.forEach(reads, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(reads, (entry) => Deferred.await(entry.started));
      expect(h.requests).toHaveLength(8);
      yield* Effect.forEach(reads, (entry) => entry.respond());
      yield* Effect.forEach(fibers, Fiber.join);
    }),
  );

  it.effect(
    "canceling background admission waiters leaves no request and permits later reads",
    () =>
      Effect.gen(function* () {
        const h = yield* gateHarness;
        const active = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => `active-${index}`),
          h.prepare,
        );
        const activeFibers = yield* Effect.forEach(active, (entry) =>
          entry.read.pipe(Effect.forkChild({ startImmediately: true })),
        );
        yield* Effect.forEach(active, (entry) => Deferred.await(entry.started));
        const globalWaiter = yield* h.prepare("canceled-global-waiter");
        const admissionWaiter = yield* h.prepare("canceled-admission-waiter");
        const globalFiber = yield* globalWaiter.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const admissionFiber = yield* admissionWaiter.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(admissionFiber);
        yield* Fiber.interrupt(globalFiber);
        const replacement = yield* h.prepare("replacement");
        const replacementFiber = yield* replacement.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.forEach(active, (entry) => entry.respond());
        yield* Deferred.await(replacement.started);
        yield* replacement.respond();
        yield* Effect.forEach(activeFibers, Fiber.join);
        yield* Fiber.join(replacementFiber);
        expect(h.requests).toEqual([
          ...Array.from({ length: 8 }, (_, index) => `/active-${index}`),
          "/replacement",
        ]);
      }),
  );

  it.effect(
    "interrupting active background HTTP returns the global permit and keeps admission usable",
    () =>
      Effect.gen(function* () {
        const h = yield* gateHarness;
        const interrupted = yield* h.prepare("interrupted");
        const interruptedFiber = yield* interrupted.read.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(interrupted.started);
        yield* Fiber.interrupt(interruptedFiber);
        const reads = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => `replacement-${index}`),
          h.prepare,
        );
        const fibers = yield* Effect.forEach(reads, (entry) =>
          entry.read.pipe(Effect.forkChild({ startImmediately: true })),
        );
        yield* Effect.forEach(reads, (entry) => Deferred.await(entry.started));
        expect(h.requests).toHaveLength(9);
        yield* Effect.forEach(reads, (entry) => entry.respond());
        yield* Effect.forEach(fibers, Fiber.join);
      }),
  );

  it.effect("a failed background response returns its permits before the next eight reads", () =>
    Effect.gen(function* () {
      const h = yield* gateHarness;
      const failed = yield* h.prepare("failed");
      const failureFiber = yield* Effect.flip(failed.read).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(failed.started);
      yield* failed.respond({ _tag: "Failed", status: 503, headers: {} });
      expect((yield* Fiber.join(failureFiber))._tag).toBe("GitHubApiResponseError");
      const reads = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => `after-failure-${index}`),
        h.prepare,
      );
      const fibers = yield* Effect.forEach(reads, (entry) =>
        entry.read.pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Effect.forEach(reads, (entry) => Deferred.await(entry.started));
      expect(h.requests).toHaveLength(9);
      yield* Effect.forEach(reads, (entry) => entry.respond());
      yield* Effect.forEach(fibers, Fiber.join);
    }),
  );
});
