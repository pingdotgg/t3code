import * as NodeOS from "node:os";

import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type Project,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import * as Feedback from "./FeedbackService.ts";

const threadId = ThreadId.make("thread:feedback");
const instanceId = ProviderInstanceId.make("work-codex");

const harness = Effect.gen(function* () {
  const enabled = yield* Ref.make(true);
  const telemetry = yield* Ref.make(true);
  const runId = yield* Ref.make(RunId.make("run:1"));
  const events = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
  const layer = Feedback.layer(() => ["t3_thread_read"]).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Ref.get(enabled).pipe(
            Effect.map((on) => ({ ...DEFAULT_SERVER_SETTINGS, agentFeedback: { enabled: on } })),
          ),
        }),
        Layer.mock(Analytics.AnalyticsService)({
          record: (event, properties) =>
            Ref.get(telemetry).pipe(
              Effect.tap((on) =>
                on
                  ? Ref.update(events, (rows) => [...rows, [event, properties] as const])
                  : Effect.void,
              ),
            ),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () =>
            Ref.get(runId).pipe(
              Effect.map((activeRunId) => ({
                ...liveThreadShell(threadId, { activeRunId }),
                modelSelection: { instanceId, model: "gpt-5.5" },
                branch: "acme/secret-launch",
                worktreePath: "/srv/checkouts/acme-app-7",
              })),
            ),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              title: "Acme Payments",
              workspaceRoot: "/srv/acme-app",
              repositoryIdentity: {
                canonicalKey: "github.com/acme/payments",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/payments.git",
                },
              },
            } as unknown as Project),
        }),
        Layer.mock(Providers.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId,
              driver: "codex",
              models: [{ slug: "gpt-5.5", isCustom: false }],
            } as unknown as ServerProvider,
          ]),
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { enabled, telemetry, runId, events, layer };
});

const input = {
  kind: "bug" as const,
  subject: "t3_thread_read",
  expected: "Items for a completed thread.",
  actual: "No items.",
  workaround: "",
};
const fromThread = { source: "mcp" as const, threadId };

it.effect("stores nothing and fails when agent feedback is off", () =>
  Effect.gen(function* () {
    const { enabled, events, layer } = yield* harness;
    yield* Ref.set(enabled, false);
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const error = yield* Effect.flip(feedback.submit(input, fromThread));
      expect(error._tag).toBe("FeedbackOffError");
      expect(error.message).toContain("t3_environment_preferences_update");
      expect(yield* feedback.list).toEqual([]);
    }).pipe(Effect.provide(layer));
    expect(yield* Ref.get(events)).toEqual([]);
  }),
);

it.effect("scrubs the caller's private values and sends only the event contract", () =>
  Effect.gen(function* () {
    const { telemetry, events, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      yield* Ref.set(telemetry, false);
      const local = yield* feedback.submit(
        {
          kind: "confusing",
          subject: "acme payments roadmap",
          expected: `Reading /srv/checkouts/acme-app-7 on acme/secret-launch as ${NodeOS.userInfo().username}`,
          actual:
            "git@github.com:acme/payments.git in Acme Payments with sk-proj-abcdefghij1234567890",
          workaround: "x".repeat(400),
        },
        fromThread,
      );
      expect(local).toMatchObject({
        subject: "",
        expected: "Reading [redacted] on [redacted] as [redacted]",
        actual: "[redacted] in [redacted] with [redacted]",
        workaround: "x".repeat(300),
        threadId,
        source: "mcp",
        sent: false,
      });
      expect(yield* Ref.get(events)).toEqual([]);

      yield* Ref.set(telemetry, true);
      const sent = yield* feedback.submit({ ...input, subject: "t3 thread show" }, fromThread);
      expect(sent.sent).toBe(true);
      expect(yield* Ref.get(events)).toEqual([
        [
          "agent.feedback",
          {
            kind: "bug",
            subject: "t3 thread show",
            expected: input.expected,
            actual: input.actual,
            workaround: "",
            source: "mcp",
            provider: "codex",
            model: "gpt-5.5",
          },
        ],
      ]);
      yield* feedback.submit(input, { source: "cli" });
      expect((yield* Ref.get(events))[1]).toEqual(["agent.feedback", { ...input, source: "cli" }]);
      expect((yield* feedback.list).map(({ sent, threadId }) => ({ sent, threadId }))).toEqual([
        { sent: true, threadId: null },
        { sent: true, threadId },
        { sent: false, threadId },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("allows 3 reports per turn and 10 per thread", () =>
  Effect.gen(function* () {
    const { runId, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const limited = Effect.flip(feedback.submit(input, fromThread)).pipe(
        Effect.map((error) => error._tag),
      );
      yield* Effect.replicateEffect(feedback.submit(input, fromThread), 3, { discard: true });
      expect(yield* limited).toBe("FeedbackLimitError");
      for (const run of ["run:2", "run:3"]) {
        yield* Ref.set(runId, RunId.make(run));
        yield* Effect.replicateEffect(feedback.submit(input, fromThread), 3, { discard: true });
      }
      yield* Ref.set(runId, RunId.make("run:4"));
      yield* feedback.submit(input, fromThread);
      expect(yield* limited).toBe("FeedbackLimitError");
      // Reports from no thread, such as the CLI's, have no per-thread limit.
      yield* Effect.replicateEffect(feedback.submit(input, { source: "cli" }), 11, {
        discard: true,
      });
      expect(yield* feedback.list).toHaveLength(21);
    }).pipe(Effect.provide(layer));
  }),
);
