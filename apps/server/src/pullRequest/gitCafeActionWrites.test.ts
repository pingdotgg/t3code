import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import { makeGitCafeActionWrites } from "./gitCafeActionWrites.ts";

const target = { cwd: "/work", host: "git.cafe", repository: "owner/repo", number: 7 } as const;
const head = "1".repeat(40);
const base = "2".repeat(40);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Call = Parameters<GitCafeCli.GitCafeCli["Service"]["api"]>[0];
const pull = (changes: Record<string, unknown> = {}) => ({
  number: 7,
  state: "open",
  draft: false,
  version: 4,
  targetBranch: "main",
  headOid: head,
  observedBaseOid: base,
  mergeRoute: "native",
  ...changes,
});
const stack = (changes: Record<string, unknown> = {}) => ({
  stack: {
    number: 3,
    revision: 4,
    members: [{ state: "open" }],
    ...changes,
  },
});
type ActionInput = Parameters<PullRequestProviderApi["runAction"]>[0];
const input = (changes: Partial<ActionInput>): ActionInput => ({
  ...target,
  action: "merge",
  ...changes,
});
const api = (respond: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const service = {
    api: (call: Call) =>
      Effect.sync(() => {
        calls.push(call);
        return json(respond(call));
      }),
  } as unknown as GitCafeCli.GitCafeCli["Service"];
  return { calls, writes: makeGitCafeActionWrites(service) };
};

describe("GitCafe action writes", () => {
  it.effect("uses a fresh lifecycle version and rejects closing an active stack", () =>
    Effect.gen(function* () {
      const ready = api((call) =>
        call.endpoint.endsWith("/ready") ? pull({ version: 5 }) : pull(),
      );
      yield* ready.writes.runAction(input({ action: "ready" }));
      expect(ready.calls[1]).toMatchObject({ method: "POST", body: { expectedVersion: 4 } });

      const close = api((call) => (call.endpoint.endsWith("/stack") ? stack() : pull()));
      const result = yield* Effect.result(close.writes.runAction(input({ action: "close" })));
      expect(result._tag).toBe("Failure");
      expect(close.calls.some((call) => call.method === "POST")).toBe(false);
    }),
  );

  it.effect("submits exact native/provider merges and distinguishes accepted from completed", () =>
    Effect.gen(function* () {
      for (const [route, state, expectedBase] of [
        ["native", "accepted", "3".repeat(40)],
        ["provider", "completed", base],
      ] as const) {
        const fixture = api((call) =>
          call.method === "POST"
            ? {
                id: `${route}-operation`,
                state,
                ...(state === "completed" ? { resultOid: head } : {}),
              }
            : call.endpoint.includes("/commit?")
              ? { oid: expectedBase }
              : pull({ mergeRoute: route }),
        );
        const outcome = yield* fixture.writes.runAction(
          input({ requestId: "stable-request", mergeMethod: "squash" }),
        );
        expect(outcome?.state).toBe(state === "accepted" ? "pending" : "completed");
        const write = fixture.calls.find((call) => call.method === "POST");
        expect(write?.body).toEqual({
          requestId: "stable-request",
          expectedVersion: 4,
          headOid: head,
          baseOid: expectedBase,
          strategy: "squash",
        });
        if (route === "native")
          expect(fixture.calls[1]?.endpoint).toContain("/commit?ref=refs%2Fheads%2Fmain");
      }
    }),
  );

  it.effect("inspects merge operations without reposting", () =>
    Effect.gen(function* () {
      const merge = api(() => ({ id: "prmop_failed", state: "failed", reason: "native-conflict" }));
      const failed = yield* merge.writes.runAction(
        input({ operation: { kind: "merge", id: "prmop_failed" } }),
      );
      expect(failed?.state).toBe("failed");
      expect(failed?.detail).toContain("native-conflict");
      expect(merge.calls).toHaveLength(1);
      expect(merge.calls[0]?.method).toBeUndefined();

      const mismatched = api(() => ({ id: "other", state: "completed" }));
      const mismatch = yield* Effect.result(
        mismatched.writes.runAction(input({ operation: { kind: "merge", id: "prmop_expected" } })),
      );
      expect(mismatch._tag).toBe("Failure");

      const wrongAction = api(() => pull());
      yield* Effect.result(
        wrongAction.writes.runAction(
          input({
            action: "update-branch",
            operation: { kind: "stack-land", id: "prslop_operation" },
          }),
        ),
      );
      expect(wrongAction.calls).toHaveLength(0);
    }),
  );

  it.effect("lands through and restacks with the native stack contracts and no head reads", () =>
    Effect.gen(function* () {
      const land = api(() => ({
        id: "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa",
        state: "completed",
        landedCount: 2,
        stepCount: 2,
        stopReason: null,
        error: null,
        steps: [
          { mergeOperationId: "prmop_done", mergeState: "completed" },
          { mergeOperationId: null, mergeState: null },
        ],
      }));
      const landed = yield* land.writes.runAction(
        input({
          stackNumber: 3,
          expectedStackRevision: 4,
          requestId: "land-request",
          mergeMethod: "squash",
          expectedStackHeads: [{ number: 7, headSha: head }],
        } as Partial<ActionInput>),
      );
      expect(landed).toMatchObject({ state: "completed", operation: { kind: "stack-land" } });
      expect(land.calls).toHaveLength(1);
      expect(land.calls[0]).toMatchObject({
        method: "POST",
        endpoint: "/repos/owner/repo/pulls/stacks/3/land-through",
        body: {
          expectedRevision: 4,
          requestId: "land-request",
          throughPullRequestNumber: 7,
          strategy: "squash",
        },
      });

      const restack = api(() => ({
        id: "prsrop_01aaaaaaaaaaaaaaaaaaaaaaaa",
        state: "completed",
        stepCount: 2,
        completedStepCount: 2,
        pauseReason: null,
      }));
      const restacked = yield* restack.writes.runAction(
        input({
          action: "update-branch",
          stackNumber: 3,
          expectedStackRevision: 5,
          requestId: "restack-request",
        } as Partial<ActionInput>),
      );
      expect(restacked?.state).toBe("completed");
      expect(restack.calls).toHaveLength(1);
      expect(restack.calls[0]?.body).toEqual({
        expectedRevision: 5,
        requestId: "restack-request",
        fromPullRequestNumber: 7,
      });
    }),
  );

  it.effect("inspects exact and latest stack operations using GET only", () =>
    Effect.gen(function* () {
      const land = api(() => ({
        id: "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa",
        state: "failed",
        landedCount: 0,
        stepCount: 2,
        stopReason: null,
        error: { code: "CONFLICT", message: "The base moved" },
        steps: [{ mergeOperationId: null, mergeState: null }],
      }));
      const failed = yield* land.writes.runAction(
        input({
          stackNumber: 3,
          operation: { kind: "stack-land", id: "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
      );
      expect(failed?.state).toBe("failed");
      expect(failed?.detail).toContain("The base moved");
      expect(land.calls[0]?.method).toBeUndefined();

      const latest = api(() => ({
        id: "prsrop_01bbbbbbbbbbbbbbbbbbbbbbbb",
        state: "paused_conflict",
        stepCount: 2,
        completedStepCount: 1,
        pauseReason: { code: "CONFLICT", message: "Resolve conflicts" },
      }));
      const pending = yield* latest.writes.runAction(
        input({
          action: "update-branch",
          stackNumber: 3,
          operation: { kind: "stack-restack", id: "latest" },
        }),
      );
      expect(pending).toMatchObject({
        state: "pending",
        operation: { kind: "stack-restack", id: "prsrop_01bbbbbbbbbbbbbbbbbbbbbbbb" },
      });
      expect(latest.calls[0]?.endpoint.endsWith("/pulls/stacks/3/restacks/latest")).toBe(true);
      expect(latest.calls[0]?.method).toBeUndefined();
    }),
  );

  it.effect("rejects stack writes before dispatch when durable inputs are absent", () =>
    Effect.gen(function* () {
      for (const changes of [
        { stackNumber: 3, expectedStackRevision: 4 },
        { stackNumber: 3, requestId: "stable" },
      ]) {
        const fixture = api(() => {
          throw new Error("preflight must not call GitCafe");
        });
        const error = yield* Effect.flip(
          fixture.writes.runAction(input(changes as Partial<ActionInput>)),
        );
        expect(error.notDispatched).toBe(true);
        expect(fixture.calls).toHaveLength(0);
      }
    }),
  );

  it.effect("continues a native landing through credential handoff with a fresh revision", () =>
    Effect.gen(function* () {
      const id = "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa";
      const operation = (state: "running" | "awaiting_credential" | "completed") => ({
        id,
        state,
        landedCount: state === "running" ? 0 : state === "completed" ? 2 : 1,
        stepCount: 2,
        stopReason: null,
        error: null,
        steps: [
          { mergeOperationId: "prmop_done", mergeState: "completed" },
          { mergeOperationId: null, mergeState: null },
        ],
      });
      let inspections = 0;
      const fixture = api((call) => {
        if (call.endpoint === "/repos/owner/repo/pulls/stacks/3")
          return { number: 3, revision: 9, members: [{ state: "open" }] };
        if (call.method === "POST" && call.endpoint.endsWith("/resume"))
          return operation("completed");
        if (call.method === "POST") return operation("running");
        inspections += 1;
        return operation("awaiting_credential");
      });
      const fiber = yield* fixture.writes
        .runAction(
          input({
            stackNumber: 3,
            expectedStackRevision: 4,
            requestId: "land-stack",
          }),
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      const resumed = yield* Fiber.join(fiber);
      expect(resumed).toMatchObject({ operation: { id }, state: "completed" });
      expect(inspections).toBe(1);
      const resume = fixture.calls.find((call) => call.endpoint.endsWith("/resume"));
      expect(resume).toMatchObject({
        method: "POST",
        body: { expectedRevision: 9 },
      });
      expect(resume?.body).not.toHaveProperty("requestId");
    }),
  );

  it.effect("does not resume active children or repeat a stalled resume mutation", () =>
    Effect.gen(function* () {
      const id = "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa";
      const outcome = (changes: Record<string, unknown> = {}) => ({
        id,
        state: "awaiting_credential",
        landedCount: 1,
        stepCount: 2,
        stopReason: null,
        error: null,
        steps: [
          { mergeOperationId: "prmop_done", mergeState: "completed" },
          { mergeOperationId: null, mergeState: null },
        ],
        ...changes,
      });

      let activeReads = 0;
      const active = api((call) => {
        if (call.method === "POST")
          return outcome({
            steps: [
              { mergeOperationId: "prmop_done", mergeState: "completed" },
              { mergeOperationId: "prmop_active", mergeState: "preparing" },
            ],
          });
        activeReads += 1;
        return outcome({ state: "completed", landedCount: 2 });
      });
      const activeFiber = yield* active.writes
        .runAction(input({ stackNumber: 3, expectedStackRevision: 4, requestId: "active-child" }))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(activeFiber);
      expect(activeReads).toBe(1);
      expect(active.calls.some((call) => call.endpoint.endsWith("/resume"))).toBe(false);

      let resumed = 0;
      let inspections = 0;
      const stalled = api((call) => {
        if (call.endpoint === "/repos/owner/repo/pulls/stacks/3")
          return { number: 3, revision: 9, members: [{ state: "open" }] };
        if (call.endpoint.endsWith("/resume")) {
          resumed += 1;
          return outcome();
        }
        if (call.method === "POST") return outcome();
        inspections += 1;
        return outcome({ state: "completed", landedCount: 2 });
      });
      const stalledFiber = yield* stalled.writes
        .runAction(input({ stackNumber: 3, expectedStackRevision: 4, requestId: "stalled" }))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(stalledFiber);
      expect(resumed).toBe(1);
      expect(inspections).toBe(1);
    }),
  );

  it.effect("does not retry a rejected continuation mutation", () =>
    Effect.gen(function* () {
      const id = "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa";
      let resumeCalls = 0;
      const fixture = api((call) => {
        if (call.endpoint === "/repos/owner/repo/pulls/stacks/3")
          return { number: 3, revision: 9, members: [{ state: "open" }] };
        if (call.endpoint.endsWith("/resume")) {
          resumeCalls += 1;
          return { rejected: true };
        }
        return {
          id,
          state: "awaiting_credential",
          landedCount: 1,
          stepCount: 2,
          stopReason: null,
          error: null,
          steps: [
            { mergeOperationId: "prmop_done", mergeState: "completed" },
            { mergeOperationId: null, mergeState: null },
          ],
        };
      });
      const result = yield* fixture.writes.runAction(
        input({ stackNumber: 3, expectedStackRevision: 4, requestId: "rejected" }),
      );
      expect(result).toMatchObject({ state: "pending", operation: { id } });
      expect(result?.detail).toContain("could not be confirmed");
      expect(resumeCalls).toBe(1);
    }),
  );

  it.effect("preserves the admitted operation when continuation makes no progress", () =>
    Effect.gen(function* () {
      const id = "prslop_01aaaaaaaaaaaaaaaaaaaaaaaa";
      let resumeCalls = 0;
      const pending = {
        id,
        state: "awaiting_credential",
        landedCount: 1,
        stepCount: 2,
        stopReason: null,
        error: null,
        steps: [
          { mergeOperationId: "prmop_done", mergeState: "completed" },
          { mergeOperationId: null, mergeState: null },
        ],
      } as const;
      const fixture = api((call) => {
        if (call.endpoint === "/repos/owner/repo/pulls/stacks/3")
          return { number: 3, revision: 9, members: [{ state: "open" }] };
        if (call.endpoint.endsWith("/resume")) resumeCalls += 1;
        return pending;
      });
      const fiber = yield* fixture.writes
        .runAction(input({ stackNumber: 3, expectedStackRevision: 4, requestId: "no-progress" }))
        .pipe(Effect.forkChild);
      for (let poll = 0; poll < 40; poll += 1) yield* TestClock.adjust("500 millis");
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ state: "pending", operation: { id } });
      expect(resumeCalls).toBe(1);
    }),
  );

  it.effect("bounds a stalled status request, not just the time between polls", () =>
    Effect.gen(function* () {
      const id = "prslop_slow_status";
      const writes = makeGitCafeActionWrites({
        api: (call: Call) =>
          call.method === "POST"
            ? Effect.succeed(
                json({
                  id,
                  state: "running",
                  landedCount: 0,
                  stepCount: 1,
                  stopReason: null,
                  error: null,
                  steps: [{ mergeOperationId: "prmop_active", mergeState: "preparing" }],
                }),
              )
            : Effect.never,
      } as unknown as GitCafeCli.GitCafeCli["Service"]);
      const fiber = yield* writes
        .runAction(input({ stackNumber: 3, expectedStackRevision: 4, requestId: "slow-status" }))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ state: "pending", operation: { id } });
    }),
  );

  it.effect("requires a bounded request ID for an exact single-pull-request merge", () =>
    Effect.gen(function* () {
      const missingId = api(() => pull({ mergeRoute: "provider" }));
      const missingIdError = yield* Effect.flip(missingId.writes.runAction(input({})));
      expect(missingIdError.notDispatched).toBe(true);
      expect(missingId.calls).toHaveLength(1);
      expect(missingId.calls[0]?.method).toBeUndefined();

      const unsupported = api(() => pull({ mergeRoute: "unsupported" }));
      const unsupportedError = yield* Effect.flip(
        unsupported.writes.runAction(input({ requestId: "stable-request" })),
      );
      expect(unsupportedError.notDispatched).toBe(true);

      const unreadableRead = api(() => ({ unexpected: true }));
      const readError = yield* Effect.flip(
        unreadableRead.writes.runAction(input({ requestId: "stable-request" })),
      );
      expect(readError.notDispatched).toBe(true);

      const unreadableWrite = api((call) =>
        call.method === "POST" ? { unexpected: true } : pull({ mergeRoute: "provider" }),
      );
      const writeError = yield* Effect.flip(
        unreadableWrite.writes.runAction(input({ requestId: "stable-request" })),
      );
      expect(writeError.notDispatched).toBeUndefined();
    }),
  );
});
