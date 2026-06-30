import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { ProviderTurnPort, type DispatchRequest } from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader, type TurnState } from "../Services/TurnStateReader.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowIntakeService } from "../Services/WorkflowIntake.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { parseIntakeProposals, WorkflowIntakeLive } from "./WorkflowIntake.ts";

describe("parseIntakeProposals", () => {
  it("keeps valid proposals, drops junk, and caps the list", () => {
    const proposals = parseIntakeProposals({
      tickets: [
        { title: "Fix login", description: "Users get logged out" },
        { title: "   " },
        "not an object",
        { title: "No description" },
        ...Array.from({ length: 30 }, (_, index) => ({ title: `extra ${index}` })),
      ],
    });

    assert.equal(proposals.length, 20);
    assert.deepEqual(proposals[0], { title: "Fix login", description: "Users get logged out" });
    assert.deepEqual(proposals[1], { title: "No description" });
  });

  it("truncates overlong fields instead of failing", () => {
    const proposals = parseIntakeProposals({
      tickets: [{ title: "t".repeat(500), description: "d".repeat(9000) }],
    });
    assert.equal(proposals[0]?.title.length, 200);
    assert.equal(proposals[0]?.description?.length, 4000);
  });

  it("keeps backward dependency indices and drops self/forward/junk", () => {
    const proposals = parseIntakeProposals({
      tickets: [
        { title: "API" },
        { title: "UI", dependsOn: [0] },
        { title: "Docs", dependsOn: [0, 1, 2, 7, -1, "0", 1] },
        { title: "Free", dependsOn: "nope" },
      ],
    });

    assert.equal(proposals[0]?.dependsOn, undefined);
    assert.deepEqual(proposals[1]?.dependsOn, [0]);
    assert.deepEqual(proposals[2]?.dependsOn, [0, 1]);
    assert.equal(proposals[3]?.dependsOn, undefined);
  });

  it("returns nothing for unusable shapes", () => {
    assert.deepEqual(parseIntakeProposals(null), []);
    assert.deepEqual(parseIntakeProposals({ tickets: "nope" }), []);
    assert.deepEqual(parseIntakeProposals([]), []);
  });
});

const baseInput = {
  boardId: "board-intake" as never,
  braindump: "Fix the login flow and add rate limiting",
  agent: { instance: "codex" as never, model: "gpt-5.5" as never },
};

// A full ProviderServiceShape stub. Only getCapabilities/interruptTurn/stopSession
// are exercised by intake; the rest fail loudly so any unexpected use is caught.
const providerServiceStub = (capabilities: {
  readonly maxInputChars?: number;
}): ProviderServiceShape =>
  ({
    getCapabilities: () =>
      Effect.succeed({
        sessionModelSwitch: "in-session" as const,
        ...(capabilities.maxInputChars === undefined
          ? {}
          : { maxInputChars: capabilities.maxInputChars }),
      }),
    interruptTurn: () => Effect.void,
    stopSession: () => Effect.void,
  }) as never;

const makeLayer = (options: {
  readonly turnState: TurnState;
  readonly capturedOutput?: unknown;
  readonly onStart?: (req: DispatchRequest) => void;
  readonly failIfTurnStarts?: boolean;
  readonly provider?: { readonly maxInputChars?: number };
}) => {
  const base = WorkflowIntakeLive.pipe(
    Layer.provide(
      Layer.succeed(WorkflowReadModel, {
        getBoard: () =>
          Effect.succeed({
            boardId: "board-intake",
            projectId: "project-intake",
            name: "Intake board",
            workflowFilePath: ".t3/boards/intake.json",
            workflowVersionHash: "hash",
            maxConcurrentTickets: 1,
          }),
      } as never),
    ),
    Layer.provide(
      Layer.succeed(ProjectWorkspaceResolver, {
        resolve: () => Effect.succeed("/tmp/project-intake"),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProviderTurnPort, {
        ensureTurnStarted: (req) =>
          Effect.sync(() => {
            if (options.failIfTurnStarts === true) {
              throw new Error("ensureTurnStarted must not be called for an over-budget braindump");
            }
            options.onStart?.(req);
            return { turnId: "turn-intake" as never };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(TurnStateReader, { read: () => Effect.succeed(options.turnState) }),
    ),
    Layer.provide(
      Layer.succeed(CapturedStepOutputReader, {
        read: () => Effect.succeed(options.capturedOutput),
      }),
    ),
    Layer.provide(
      Layer.succeed(WorkflowIds, {
        eventId: () => Effect.succeed("evt-intake-1" as never),
        ticketId: () => Effect.succeed("ticket-x" as never),
        pipelineRunId: () => Effect.succeed("pipeline-x" as never),
        stepRunId: () => Effect.succeed("step-x" as never),
        laneEntryToken: () => Effect.succeed("token-x" as never),
      } as never),
    ),
  );
  return options.provider === undefined
    ? base
    : base.pipe(
        Layer.provide(Layer.succeed(ProviderService, providerServiceStub(options.provider))),
      );
};

describe("WorkflowIntakeService", () => {
  it.effect("dispatches a one-shot turn and returns parsed proposals", () => {
    const starts: DispatchRequest[] = [];
    return Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const proposals = yield* intake.proposeTickets(baseInput);

      assert.deepEqual(proposals, [
        { title: "Fix login", description: "Restore session persistence" },
      ]);
      assert.equal(starts.length, 1);
      const request = starts[0];
      assert.equal(request?.worktreePath, "/tmp/project-intake");
      assert.include(request?.instruction, "Fix the login flow and add rate limiting");
      assert.include(request?.instruction, '"tickets"');
      assert.match(String(request?.ticketId), /^intake-/);
    }).pipe(
      Effect.provide(
        makeLayer({
          turnState: { _tag: "completed" },
          capturedOutput: {
            tickets: [{ title: "Fix login", description: "Restore session persistence" }],
          },
          onStart: (req) => starts.push(req),
        }),
      ),
    );
  });

  it.effect("fails when the agent asks a question", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake.proposeTickets(baseInput).pipe(Effect.flip);
      assert.include(result.message, "asked a question");
    }).pipe(
      Effect.provide(
        makeLayer({
          turnState: {
            _tag: "awaiting_user",
            waitingReason: "Which auth provider?",
            providerThreadId: "thread-1" as never,
            providerRequestId: "request-1" as never,
            providerResponseKind: "user-input",
          },
        }),
      ),
    ),
  );

  it.effect("fails when the turn fails", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake.proposeTickets(baseInput).pipe(Effect.flip);
      assert.include(result.message, "boom");
    }).pipe(Effect.provide(makeLayer({ turnState: { _tag: "failed", error: "boom" } }))),
  );

  it.effect("fails when no usable proposals come back", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake.proposeTickets(baseInput).pipe(Effect.flip);
      assert.include(result.message, "usable ticket proposals");
    }).pipe(
      Effect.provide(
        makeLayer({ turnState: { _tag: "completed" }, capturedOutput: { tickets: [] } }),
      ),
    ),
  );

  it.effect("rejects an over-budget braindump before starting the turn", () =>
    Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const result = yield* intake
        .proposeTickets({ ...baseInput, braindump: "x".repeat(2000) })
        .pipe(Effect.flip);
      assert.include(result.message, "too long");
      assert.include(result.message, "gpt-5.5");
      // The assembled prompt (wrapper + 2000-char braindump) and the 900 budget
      // both appear in the actionable message.
      assert.include(result.message, "900");
    }).pipe(
      Effect.provide(
        makeLayer({
          // ensureTurnStarted must never run for an over-budget braindump.
          turnState: { _tag: "completed" },
          failIfTurnStarts: true,
          provider: { maxInputChars: 900 },
        }),
      ),
    ),
  );

  it.effect("proceeds when the braindump fits the provider budget", () => {
    const starts: DispatchRequest[] = [];
    return Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const proposals = yield* intake.proposeTickets(baseInput);
      assert.deepEqual(proposals, [
        { title: "Fix login", description: "Restore session persistence" },
      ]);
      assert.equal(starts.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          turnState: { _tag: "completed" },
          capturedOutput: {
            tickets: [{ title: "Fix login", description: "Restore session persistence" }],
          },
          onStart: (req) => starts.push(req),
          // Comfortably above the ~790-char wrapper plus the short braindump.
          provider: { maxInputChars: 5000 },
        }),
      ),
    );
  });

  it.effect("falls back to the 120k budget when the provider declares no limit", () => {
    const starts: DispatchRequest[] = [];
    return Effect.gen(function* () {
      const intake = yield* WorkflowIntakeService;
      const proposals = yield* intake.proposeTickets(baseInput);
      assert.deepEqual(proposals, [
        { title: "Fix login", description: "Restore session persistence" },
      ]);
      assert.equal(starts.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          turnState: { _tag: "completed" },
          capturedOutput: {
            tickets: [{ title: "Fix login", description: "Restore session persistence" }],
          },
          onStart: (req) => starts.push(req),
          // No maxInputChars → providerInputBudget falls back to 120k.
          provider: {},
        }),
      ),
    );
  });
});
