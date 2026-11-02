import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { processProbeSource } from "../testUtils/processProbe.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import { makeLazyTextGeneration } from "./lazyTextGeneration.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerClaudeTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string, lifecyclePort?: number) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const binDir = path.join(dir, "bin");
    const fixturePath = yield* path.fromFileUrl(
      new URL("./testing/ClaudeTextGeneration.fixture.mjs", import.meta.url),
    );
    const source = yield* fs.readFileString(fixturePath);
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source:
        lifecyclePort === undefined
          ? source
          : `process.on("SIGTERM", () => {}); ${processProbeSource(lifecyclePort)}`,
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    rejectsNoSessionPersistence?: boolean;
    lifecyclePort?: number;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir, input.lifecyclePort);
    const pathDelimiter = (yield* HostProcess.isWindows) ? ";" : ":";
    const hostEnv = yield* HostProcess.Environment;
    const fakeClaudeEnv: Record<string, string | undefined> = {
      T3_FAKE_CLAUDE_OUTPUT: input.output,
      T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE: input.rejectsNoSessionPersistence
        ? "1"
        : undefined,
      T3_FAKE_CLAUDE_EXIT_CODE: input.exitCode === undefined ? undefined : String(input.exitCode),
      T3_FAKE_CLAUDE_STDERR: input.stderr,
      T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN: input.argsMustContain,
      T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN: input.argsMustNotContain,
      T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN: input.stdinMustContain,
      T3_FAKE_CLAUDE_CWD_MUST_NOT_BE: input.cwdMustNotBe,
      T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE: input.configDirMustBe,
    };
    const environment: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(hostEnv).filter(([name]) => !name.startsWith("T3_FAKE_CLAUDE_")),
      ),
      ...Object.fromEntries(
        Object.entries(fakeClaudeEnv).filter(([, value]) => value !== undefined),
      ),
      PATH: `${binDir}${pathDelimiter}${hostEnv.PATH ?? ""}`,
    };

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      environment,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerClaudeTextGenerationTest)("ClaudeTextGeneration", (it) => {
  it.effect("shares lazy construction across concurrent requests and cancellation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      let constructions = 0;
      const textGeneration = yield* makeLazyTextGeneration(
        Effect.gen(function* () {
          constructions++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(ready);
          return {
            generateCommitMessage: () => Effect.succeed({ subject: "commit", body: "" }),
            generatePrContent: () => Effect.succeed({ title: "pr", body: "" }),
            generateBranchName: () => Effect.succeed({ branch: "feature" }),
            generateThreadTitle: () => Effect.succeed({ title: "thread" }),
            generateReviewGuide: () => Effect.die("unused"),
          };
        }),
      );
      expect(constructions).toBe(0);
      const input = {
        cwd: process.cwd(),
        message: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
        ),
      };
      const first = yield* textGeneration.generateThreadTitle(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* textGeneration.generateThreadTitle(input).pipe(Effect.forkChild);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(ready, undefined);
      expect(yield* Fiber.join(second)).toEqual({ title: "thread" });
      expect(yield* textGeneration.generateBranchName(input)).toEqual({ branch: "feature" });
      expect(constructions).toBe(1);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("sends thread title instructions to the provider prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        stdinMustContain: "Additional instructions:\nUse two to four words.",
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures",
          instructions: "Use two to four words.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
          },
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("retries without --no-session-persistence when the Claude CLI rejects it", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        rejectsNoSessionPersistence: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate reconnect failures",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Reconnect failures");
        }),
    ),
  );

  it.effect.each([
    { verbose: false, label: "normal" },
    { verbose: true, label: "verbose" },
  ])("unwraps a JSON title in $label Claude output", ({ verbose }) => {
    const result = {
      type: "result",
      structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
    };
    return withFakeClaudeEnv(
      { output: JSON.stringify(verbose ? [result] : result) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
        }),
    );
  });

  it.effect.each([
    { previousTitle: undefined, label: "generating" },
    { previousTitle: "Old thread title", label: "regenerating" },
  ])("reads the result from verbose Claude output when $label a title", ({ previousTitle }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
          { type: "user", message: { content: [] } },
          { type: "rate_limit_event" },
          {
            type: "result",
            subtype: "success",
            result: '{"title":"Refresh ev-stg APP ASG Instances"}',
            structured_output: { title: "Refresh ev-stg APP ASG Instances" },
          },
        ]),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            previousTitle,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
        }),
    ),
  );

  it.effect.each([
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const)("rejects verbose Claude output with %s", ([, output]) =>
    withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error._tag).toBe("TextGenerationError");
      }),
    ),
  );

  const apiError = "API Error: 400 Model blocked by guardrail: 4 endpoints excluded";
  const wrapperNotice = "Using the OpenRouter credential from the global credential file.";
  const structuredOutputError = "Failed to provide valid structured output after 5 attempts";
  const structuredOutputFailure = {
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    errors: [structuredOutputError],
  };
  it.effect.each([
    [
      "the errors list of a result with no result text",
      JSON.stringify(structuredOutputFailure),
      structuredOutputError,
    ],
    [
      "the errors list from verbose output",
      JSON.stringify([{ type: "system", subtype: "init" }, structuredOutputFailure]),
      structuredOutputError,
    ],
    [
      "the errors list without CLI telemetry",
      JSON.stringify({
        ...structuredOutputFailure,
        subtype: "error_during_execution",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a", apiError],
      }),
      apiError,
    ],
    [
      "the stdout error over a stderr notice",
      JSON.stringify({ is_error: true, api_error_status: 400, result: apiError }),
      apiError,
    ],
    [
      "the verbose stdout error over a stderr notice",
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: true, result: apiError },
        { type: "result", is_error: true, result: " " },
      ]),
      apiError,
    ],
    ["stderr when stdout has no error", "not json", wrapperNotice],
    [
      "a stdout error naming --no-session-persistence without retrying",
      JSON.stringify({
        is_error: true,
        result: "error: unknown option '--no-session-persistence'",
      }),
      "error: unknown option '--no-session-persistence'",
    ],
  ] as const)("reports %s when the Claude CLI fails", ([, output, expected]) =>
    withFakeClaudeEnv({ output, stderr: wrapperNotice, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error.detail).toBe(`Claude CLI command failed: ${expected}`);
      }),
    ),
  );

  it.effect("does not report the raw result JSON when a failed run writes nothing to stderr", () =>
    withFakeClaudeEnv(
      { output: JSON.stringify(structuredOutputFailure), exitCode: 1 },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error.detail).toBe(`Claude CLI command failed: ${structuredOutputError}`);
        }),
    ),
  );
});
