import {
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { findModelOffers, turnOutcome } from "./thread.ts";

const SENT_AT = "2026-09-24T12:00:00.000Z";
const EARLIER = "2026-09-24T11:00:00.000Z";

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeTurn = (
  requestedAt: string,
  state: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"],
) => ({
  turnId: TurnId.make(`turn-${requestedAt}`),
  state,
  requestedAt,
  startedAt: requestedAt,
  completedAt: state === "running" ? null : requestedAt,
  assistantMessageId: null,
});

const makeSession = (
  status: NonNullable<OrchestrationThreadShell["session"]>["status"],
  updatedAt: string,
) => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "codex",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: status === "error" ? "provider crashed" : null,
  updatedAt,
});

describe("turnOutcome", () => {
  const LATER = "2026-09-24T12:00:05.000Z";

  it("keeps waiting before the server picks up the message", () => {
    const thread = makeThread({
      latestTurn: makeTurn(EARLIER, "completed"),
      session: makeSession("ready", EARLIER),
    });
    assert.equal(turnOutcome(thread, SENT_AT), undefined);
  });

  it("keeps waiting while the turn starts or runs", () => {
    assert.equal(
      turnOutcome(makeThread({ session: makeSession("starting", SENT_AT) }), SENT_AT),
      undefined,
    );
    assert.equal(
      turnOutcome(
        makeThread({
          latestTurn: makeTurn(SENT_AT, "running"),
          session: makeSession("running", SENT_AT),
        }),
        SENT_AT,
      ),
      undefined,
    );
  });

  it("reports how the requested turn ended", () => {
    const session = makeSession("ready", LATER);
    assert.equal(
      turnOutcome(makeThread({ latestTurn: makeTurn(SENT_AT, "completed"), session }), SENT_AT),
      "completed",
    );
    assert.equal(
      turnOutcome(makeThread({ latestTurn: makeTurn(SENT_AT, "interrupted"), session }), SENT_AT),
      "interrupted",
    );
  });

  it("reports a turn that failed to start", () => {
    const thread = makeThread({
      latestTurn: makeTurn(EARLIER, "completed"),
      session: makeSession("error", LATER),
    });
    assert.equal(turnOutcome(thread, SENT_AT), "error");
  });

  it("ignores a session error from before the message was sent", () => {
    const thread = makeThread({ session: makeSession("error", EARLIER) });
    assert.equal(turnOutcome(thread, SENT_AT), undefined);
  });

  it("ends when the message was handled without a turn of its own", () => {
    // A provider command, or a steer into a turn another client started.
    const thread = makeThread({
      latestTurn: makeTurn(EARLIER, "completed"),
      session: makeSession("ready", LATER),
    });
    assert.equal(turnOutcome(thread, SENT_AT), "completed");
  });

  it("ends when a later turn has replaced the requested one", () => {
    const thread = makeThread({
      latestTurn: makeTurn(LATER, "completed"),
      session: makeSession("ready", LATER),
    });
    assert.equal(turnOutcome(thread, SENT_AT), "completed");
  });

  it("stops when the turn needs an approval or an answer", () => {
    const running = makeTurn(SENT_AT, "running");
    const session = makeSession("running", SENT_AT);
    assert.equal(
      turnOutcome(makeThread({ latestTurn: running, session, hasPendingApprovals: true }), SENT_AT),
      "needs-input",
    );
    assert.equal(
      turnOutcome(makeThread({ latestTurn: running, session, hasPendingUserInput: true }), SENT_AT),
      "needs-input",
    );
  });
});

describe("findModelOffers", () => {
  const codex = ProviderInstanceId.make("codex");
  const codexWork = ProviderInstanceId.make("codex_work");
  const claude = ProviderInstanceId.make("claudeAgent");
  const providers = [
    {
      instanceId: codex,
      models: [{ slug: "gpt-5" }, { slug: "gpt-5-codex", isDefault: true }],
    },
    { instanceId: codexWork, models: [{ slug: "gpt-5-codex" }] },
    {
      instanceId: claude,
      models: [{ slug: "claude-sonnet-5", aliases: ["sonnet"] }, { slug: "claude-opus-5-5" }],
    },
  ];

  it("matches a model by slug or alias", () => {
    assert.deepEqual(findModelOffers(providers, "sonnet", undefined), [
      { instanceId: claude, model: "claude-sonnet-5" },
    ]);
  });

  it("returns every provider that offers the model", () => {
    assert.deepEqual(findModelOffers(providers, "gpt-5-codex", undefined), [
      { instanceId: codex, model: "gpt-5-codex" },
      { instanceId: codexWork, model: "gpt-5-codex" },
    ]);
    assert.deepEqual(findModelOffers(providers, "gpt-5-codex", "codex_work"), [
      { instanceId: codexWork, model: "gpt-5-codex" },
    ]);
  });

  it("uses the provider's default model when only the provider is set", () => {
    assert.deepEqual(findModelOffers(providers, undefined, "codex"), [
      { instanceId: codex, model: "gpt-5-codex" },
    ]);
    assert.deepEqual(findModelOffers(providers, undefined, "claudeAgent"), [
      { instanceId: claude, model: "claude-sonnet-5" },
    ]);
  });
});
