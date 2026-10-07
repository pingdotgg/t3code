import { assert, describe, it, vi } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as KnownIssueSearch from "./KnownIssueSearch.ts";
import * as ProviderFailureExplanation from "./ProviderFailureExplanationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:explain");
const projectId = ProjectId.make("project:explain");
const runId = RunId.make("run:explain");
const rootNodeId = NodeId.make("node:root");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" } as const;

const failure = (
  message: string,
  code: string | null = "E_BOOM",
): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message,
  code,
  retryable: false,
});

const item = (id: string, ordinal: number, fields: Record<string, unknown>) =>
  ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: rootNodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: `2026-10-07T00:00:0${ordinal}.000Z`,
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

const rootError = (id: string, ordinal: number, message: string, fields = {}) =>
  item(id, ordinal, { type: "error", status: "failed", failure: failure(message), ...fields });

interface RecordsCall {
  readonly fields: ReadonlyArray<string>;
  readonly filter: Record<string, unknown> | undefined;
}

function makeHarness(options: {
  readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly lastError: string | null;
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null;
  readonly latestRunId?: RunId | null;
  readonly generate?: TextGeneration.TextGeneration["Service"]["explainProviderFailure"];
  /** What the issue search finds. A failed search is an empty list. */
  readonly candidates?: ReadonlyArray<KnownIssueSearch.KnownIssueCandidate>;
}) {
  const explainProviderFailure = vi.fn(
    options.generate ??
      (() =>
        Effect.succeed({
          summary: "The binary is missing.",
          likelyFix: "Install it.",
          matchingIssueNumber: null,
        })),
  );
  const search = vi.fn(() => Effect.succeed(options.candidates ?? []));
  const recordCalls: Array<RecordsCall> = [];
  const latestRunId = options.latestRunId === undefined ? runId : options.latestRunId;
  const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        id: threadId,
        projectId,
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        latestRunId,
        lastError: options.lastError,
        lastErrorClass: options.lastErrorClass ?? null,
      } as never),
    getThreadRecords: ((
      _threadId: ThreadId,
      fields: ReadonlyArray<string>,
      filter?: {
        turnItemTypes?: ReadonlyArray<string>;
        turnItemRunId?: RunId;
        runIds?: ReadonlyArray<RunId>;
      },
    ) => {
      recordCalls.push({ fields, filter });
      return Effect.succeed({
        turnItems: (options.turnItems ?? []).filter(
          (candidate) =>
            (filter?.turnItemTypes === undefined ||
              filter.turnItemTypes.includes(candidate.type)) &&
            (filter?.turnItemRunId === undefined || candidate.runId === filter.turnItemRunId),
        ),
        runs: [
          {
            id: runId,
            status: "failed",
            rootNodeId,
            providerInstanceId: instanceId,
            modelSelection,
          },
        ].filter((run) => filter?.runIds === undefined || filter.runIds.includes(run.id)),
        providerSessions: [{ providerInstanceId: instanceId, driver: "codex" }],
      });
    }) as never,
  });
  const layer = ProviderFailureExplanation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
        Layer.mock(TextGeneration.TextGeneration)({ explainProviderFailure }),
        Layer.mock(KnownIssueSearch.KnownIssueSearch)({ search }),
        ServerSettings.layerTest({
          textGenerationModelSelection: { instanceId: "claudeAgent", model: "claude-haiku" },
        }),
      ),
    ),
    Layer.orDie,
  );
  return { layer, explainProviderFailure, search, recordCalls };
}

const explain = (input: { runId?: RunId; revision?: string } = {}) =>
  Effect.gen(function* () {
    const service = yield* ProviderFailureExplanation.ProviderFailureExplanationService;
    return yield* service.explain({ threadId, ...input });
  });

describe("formatProviderFailureContext", () => {
  const base = {
    providerInstanceId: "codex",
    driver: "codex",
    model: "gpt-5.1-codex",
    runtimeMode: "full-access",
    failure: failure("spawn codex ENOENT"),
    userMessage: { text: "Fix the flaky test", imageCount: 0 },
    items: [],
  } as const;

  it("lists the provider, failure, and last user message", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext(base);
    assert.include(context, "Provider instance: codex (driver codex)");
    assert.include(context, "Model: gpt-5.1-codex");
    assert.include(context, "Runtime mode: full-access");
    assert.include(context, "Class: provider_error");
    assert.include(context, "Code: E_BOOM");
    assert.include(context, "Provider marked retryable: no");
    assert.include(context, "Message: spawn codex ENOENT");
    assert.include(context, "Last user message of this run:\nFix the flaky test");
    assert.notInclude(context, "Recent activity");
    assert.notInclude(context, "attachment");
  });

  it("counts image attachments without naming them", () => {
    const one = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      userMessage: { text: "See this", imageCount: 1 },
    });
    assert.include(one, "User message had 1 image attachment");
    assert.notInclude(one, "attachments");
    const two = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      userMessage: { text: "", imageCount: 2 },
    });
    assert.include(two, "User message had 2 image attachments");
    assert.notInclude(two, "Last user message");
  });

  it("explains a session-only failure from the message alone", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      failure: { class: "unknown", message: "Session died", code: null, retryable: null },
      userMessage: null,
    });
    assert.include(context, "Class: unknown");
    assert.include(context, "Code: none");
    assert.include(context, "Provider marked retryable: unknown");
    assert.include(context, "Message: Session died");
    assert.notInclude(context, "Last user message");
  });

  it("reports provider retries", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      retry: { attempt: 2, maxAttempts: 3, retryDelayMs: null },
    });
    assert.include(context, "Retried by the provider: attempt 2 of 3");
  });

  it("describes commands by status and exit code only, never their text or output", () => {
    const secrets = [
      'API_KEY="hunter2 and more" npm test',
      "curl -H 'Authorization: Bearer abc123' https://example.test",
      "psql postgres://user:pw0rd@db/app",
    ];
    const commands = secrets.map((input, index) =>
      item(`item:cmd-${index}`, index, {
        type: "command_execution",
        input,
        output: "SECRET OUTPUT",
        exitCode: 1,
      }),
    );
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      items: [
        item("item:msg", 10, {
          type: "assistant_message",
          text: "ASSISTANT TEXT",
          streaming: false,
        }),
        item("item:think", 11, { type: "reasoning", text: "REASONING TEXT", streaming: false }),
        ...commands,
        item("item:tool", 99, {
          type: "dynamic_tool",
          toolName: "web.fetch",
          input: { secret: 1 },
        }),
      ],
    });
    const lines = context.split("Recent activity in this run, oldest first:\n")[1]!.split("\n");
    assert.deepEqual(lines, [
      "- command_execution completed exit 1",
      "- command_execution completed exit 1",
      "- command_execution completed exit 1",
      "- dynamic_tool completed web.fetch",
    ]);
    for (const leaked of [
      "API_KEY",
      "hunter2",
      "more",
      "npm",
      "Bearer",
      "abc123",
      "pw0rd",
      "psql",
      "SECRET OUTPUT",
      "ASSISTANT TEXT",
      "REASONING TEXT",
    ]) {
      assert.notInclude(context, leaked);
    }
  });

  it("keeps the last ten items", () => {
    const items = Array.from({ length: 12 }, (_, index) =>
      item(`item:${index}`, index, { type: "command_execution", input: "x", exitCode: index }),
    );
    const context = ProviderFailureExplanation.formatProviderFailureContext({ ...base, items });
    const lines = context.split("Recent activity in this run, oldest first:\n")[1]!.split("\n");
    assert.equal(lines.length, 10);
    assert.equal(lines[0], "- command_execution completed exit 2");
    assert.equal(lines.at(-1), "- command_execution completed exit 11");
  });

  it("truncates the user message and bounds the whole context", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      userMessage: { text: "u".repeat(10_000), imageCount: 0 },
      failure: failure("m".repeat(4_096)),
    });
    assert.isBelow(context.length, 12_001);
    assert.include(context, "[truncated]");
    assert.isBelow(context.indexOf("u".repeat(2_001)), 0);
  });

  it("truncates an oversized session error", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      failure: { class: "unknown", message: "s".repeat(50_000), code: null, retryable: null },
    });
    assert.isBelow(context.length, 12_001);
    assert.isBelow(context.indexOf("s".repeat(4_097)), 0);
  });
});

describe("ProviderFailureExplanationService", () => {
  it.effect("refuses when the thread reports no error", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        lastError: null,
        turnItems: [rootError("item:error", 1, "stale failure")],
      });
      const error = yield* explain().pipe(Effect.provide(harness.layer), Effect.flip);
      assert.equal(error._tag, "ProviderFailureExplanationError");
      assert.equal(error.reason, "no_failure");
      assert.equal(error.message, "This thread has no provider failure to explain.");
      assert.equal(harness.explainProviderFailure.mock.calls.length, 0);
    }),
  );

  it.effect("explains the failure the shell reports, not just the last error item", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        lastError: "root failure",
        turnItems: [
          item("item:user", 1, { type: "user_message", text: "Run the build", attachments: [] }),
          item("item:cmd", 2, { type: "command_execution", input: "pnpm build", exitCode: 2 }),
          rootError("item:root-error", 3, "root failure"),
          // A subagent's error sits later in the run but does not own the thread's failure.
          rootError("item:child-error", 4, "child failure", { nodeId: NodeId.make("node:child") }),
        ],
      });
      const result = yield* explain({ runId, revision: "root failure" }).pipe(
        Effect.provide(harness.layer),
      );

      assert.equal(result.failureMessage, "root failure");
      assert.equal(result.summary, "The binary is missing.");
      assert.equal(result.likelyFix, "Install it.");
      assert.isNull(result.knownIssue);
      const call = harness.explainProviderFailure.mock.calls[0]?.[0];
      assert.include(call?.context, "Message: root failure");
      assert.include(call?.context, "Code: E_BOOM");
      assert.notInclude(call?.context, "child failure");
      assert.include(call?.context, "Last user message of this run:\nRun the build");
      assert.include(call?.context, "- command_execution completed exit 2");
      assert.include(call?.context, "(driver codex)");
      assert.equal(call?.modelSelection.instanceId, "claudeAgent");
      assert.equal(call?.modelSelection.model, "claude-haiku");
      // The model runs with no project directory.
      assert.notProperty(call, "cwd");
    }),
  );

  it.effect("explains a session error that supersedes the run's failure", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        lastError: "Provider session crashed",
        lastErrorClass: null,
        turnItems: [
          rootError("item:root-error", 1, "turn failed", {
            retry: { attempt: 2, maxAttempts: 3 },
          }),
        ],
      });
      const result = yield* explain({ revision: "Provider session crashed" }).pipe(
        Effect.provide(harness.layer),
      );

      assert.equal(result.failureMessage, "Provider session crashed");
      const context = harness.explainProviderFailure.mock.calls[0]?.[0].context;
      assert.include(context, "Class: unknown");
      assert.include(context, "Message: Provider session crashed");
      assert.notInclude(context, "turn failed");
      assert.notInclude(context, "E_BOOM");
      assert.notInclude(context, "Retried by the provider");
    }),
  );

  it.effect("explains a session error on a thread with no run", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ lastError: "Could not start", latestRunId: null });
      yield* explain().pipe(Effect.provide(harness.layer));

      assert.deepEqual(harness.recordCalls, [{ fields: ["providerSessions"], filter: undefined }]);
      assert.include(
        harness.explainProviderFailure.mock.calls[0]?.[0].context,
        "Message: Could not start",
      );
    }),
  );

  it.effect("reads only the failing run and only the item types it describes", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        lastError: "root failure",
        turnItems: [
          rootError("item:root-error", 1, "root failure"),
          item("item:file", 2, {
            type: "file_change",
            fileName: "a.ts",
            diffStr: "x".repeat(1_000),
          }),
        ],
      });
      yield* explain().pipe(Effect.provide(harness.layer));

      const call = harness.recordCalls[0];
      assert.deepEqual(call?.fields, ["runs", "turnItems", "providerSessions"]);
      assert.equal(call?.filter?.["turnItemRunId"], runId);
      assert.deepEqual(call?.filter?.["runIds"], [runId]);
      assert.sameMembers(call?.filter?.["turnItemTypes"] as Array<string>, [
        "user_message",
        "error",
        "command_execution",
        "dynamic_tool",
      ]);
      assert.notInclude(harness.explainProviderFailure.mock.calls[0]?.[0].context, "file_change");
    }),
  );

  it.effect("refuses when the thread moved to another run or error", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ lastError: "new failure" });
      const otherRun = yield* explain({ runId: RunId.make("run:older") }).pipe(
        Effect.provide(harness.layer),
        Effect.flip,
      );
      assert.equal(otherRun.reason, "changed");
      assert.equal(otherRun.message, "The error changed before it could be explained.");
      const otherError = yield* explain({ revision: "old failure" }).pipe(
        Effect.provide(harness.layer),
        Effect.flip,
      );
      assert.equal(otherError.reason, "changed");
      assert.equal(harness.explainProviderFailure.mock.calls.length, 0);
    }),
  );

  it.effect("hides model failure details from the public message", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        lastError: "boom",
        generate: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "explainProviderFailure",
              detail: "Codex CLI command failed: token=sk-secret-stderr",
            }),
          ),
      });
      const error = yield* explain().pipe(Effect.provide(harness.layer), Effect.flip);

      assert.equal(error.reason, "generation_failed");
      assert.equal(
        error.message,
        "The text generation model could not explain this error. Check the server logs for details.",
      );
      assert.notInclude(JSON.stringify(error), "sk-secret-stderr");
    }),
  );

  describe("known issues", () => {
    const candidates = [
      {
        number: 12,
        title: "Codex binary not found",
        state: "open",
        url: "https://github.com/pingdotgg/t3code/issues/12",
      },
      {
        number: 40,
        title: "Session hangs",
        state: "closed",
        url: "https://github.com/pingdotgg/t3code/issues/40",
      },
    ];
    const naming = (matchingIssueNumber: number | null) => () =>
      Effect.succeed({
        summary: "The binary is missing.",
        likelyFix: "Install it.",
        matchingIssueNumber,
      });

    it.effect("searches with the failure and driver, and links the issue the model names", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          lastError: "spawn codex ENOENT",
          turnItems: [rootError("item:root-error", 1, "spawn codex ENOENT")],
          candidates,
          generate: naming(40),
        });
        const result = yield* explain().pipe(Effect.provide(harness.layer));

        assert.deepEqual(harness.search.mock.calls[0], [
          { message: "spawn codex ENOENT", driver: "codex" },
        ]);
        assert.deepEqual(harness.explainProviderFailure.mock.calls[0]?.[0].knownIssues, candidates);
        assert.deepEqual(result.knownIssue, {
          number: 40,
          title: "Session hangs",
          url: "https://github.com/pingdotgg/t3code/issues/40",
        });
        // The pre-filled report stays available beside a match.
        assert.isString(result.reportUrl);
      }),
    );

    it.effect("offers a pre-filled report when the model names no issue", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          lastError: "spawn codex ENOENT",
          turnItems: [rootError("item:root-error", 1, "spawn codex ENOENT")],
          candidates,
          generate: naming(null),
        });
        const result = yield* explain().pipe(
          Effect.provide(harness.layer),
          Effect.provideService(HostProcessPlatform, "freebsd"),
          Effect.provideService(HostProcessArchitecture, "x64"),
        );

        assert.isNull(result.knownIssue);
        const url = new URL(result.reportUrl!);
        assert.equal(url.origin + url.pathname, "https://github.com/pingdotgg/t3code/issues/new");
        assert.equal(url.searchParams.get("template"), "bug_report.yml");
        assert.equal(url.searchParams.get("title"), "[Bug]: Provider failure");
        // The error and the explanation reach GitHub only if the user pastes them.
        assert.include(url.searchParams.get("actual"), "Paste the error and explanation");
        assert.notInclude(result.reportUrl!, "ENOENT");
        assert.notInclude(result.reportUrl!, "binary");
        assert.include(url.searchParams.get("environment"), "Provider: codex, Runtime mode:");
        // A model name can be custom, so it stays out of the link.
        assert.notInclude(result.reportUrl!, "gpt-5.1-codex");
        assert.include(url.searchParams.get("environment"), "Runtime mode: full-access");
        assert.include(url.searchParams.get("environment"), "OS: freebsd x64");
        assert.isTrue(url.searchParams.has("version"));
      }),
    );

    it.effect("ignores a number that is not one of the issues it was shown", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          lastError: "boom",
          candidates,
          generate: naming(99),
        });
        const result = yield* explain().pipe(Effect.provide(harness.layer));

        assert.isNull(result.knownIssue);
        assert.isString(result.reportUrl);
      }),
    );

    it.effect("still explains when the search finds nothing or fails", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ lastError: "boom", candidates: [], generate: naming(12) });
        const result = yield* explain().pipe(Effect.provide(harness.layer));

        assert.deepEqual(harness.explainProviderFailure.mock.calls[0]?.[0].knownIssues, []);
        assert.equal(result.summary, "The binary is missing.");
        assert.isNull(result.knownIssue);
        assert.isString(result.reportUrl);
      }),
    );

    it.effect("still explains, with no link, when a failure message cuts mid-emoji", () =>
      Effect.gen(function* () {
        for (const message of [`${"word ".repeat(15)}x😀 tail`, `Failed ${"😀".repeat(1_000)}`]) {
          const harness = makeHarness({ lastError: message, candidates, generate: naming(null) });
          const result = yield* explain().pipe(Effect.provide(harness.layer));

          assert.equal(result.summary, "The binary is missing.");
          assert.equal(result.failureMessage, message);
          assert.isString(result.reportUrl);
          assert.isTrue(decodeURIComponent(result.reportUrl!).isWellFormed());
        }
      }),
    );
  });
});
