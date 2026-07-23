// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { PiSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const MOCK_PATH = NodePath.join(__dirname, "../../scripts/pi-mock-rpc.ts");

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("pi"),
  "anthropic/claude-sonnet-4-6",
);

const PiTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// shell wrapper that execs the JSONL mock via node; `PI_MOCK_*` env drives behavior
async function makePiWrapper(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-textgen-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi.sh");
  const script = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_PATH)} "$@"\n`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const withFakePi = <A, E>(
  mockEnv: Record<string, string>,
  use: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makePiWrapper());
    const settings = decodePiSettings({ binaryPath: wrapperPath });
    const environment: NodeJS.ProcessEnv = { ...process.env, ...mockEnv };
    const textGeneration = yield* makePiTextGeneration(settings, environment);
    return yield* use(textGeneration);
  });

it.effect("generateThreadTitle parses the JSON returned via get_last_assistant_text", () =>
  withFakePi(
    { PI_MOCK_ASSISTANT_TEXT: '{"title":"Investigate reconnect regressions"}' },
    (textGeneration) =>
      Effect.gen(function* () {
        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "look into reconnect bugs",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.title).toBe("Investigate reconnect regressions");
      }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("generateCommitMessage sanitizes subject and trims body", () =>
  withFakePi(
    { PI_MOCK_ASSISTANT_TEXT: '{"subject":"Add reconnect handling.","body":"- detail\\n"}' },
    (textGeneration) =>
      Effect.gen(function* () {
        const result = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/pi",
          stagedSummary: "M file.ts",
          stagedPatch: "@@ -1 +1 @@\n-old\n+new\n",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.subject).toBe("Add reconnect handling");
        expect(result.body).toBe("- detail");
        expect(result).not.toHaveProperty("branch");
      }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("generateBranchName sanitizes the branch fragment", () =>
  withFakePi({ PI_MOCK_ASSISTANT_TEXT: '{"branch":"  Feat/Session  "}' }, (textGeneration) =>
    Effect.gen(function* () {
      const result = yield* textGeneration.generateBranchName({
        cwd: process.cwd(),
        message: "please update session handling",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      expect(result.branch).toBe("feat/session");
    }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("generatePrContent sanitizes title and body", () =>
  withFakePi(
    {
      PI_MOCK_ASSISTANT_TEXT: '{"title":"Improve reconnect flow","body":"## Summary\\n- x\\n\\n"}',
    },
    (textGeneration) =>
      Effect.gen(function* () {
        const result = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/pi",
          commitSummary: "one commit",
          diffSummary: "file.ts | 2 +-",
          diffPatch: "@@ -1 +1 @@\n-old\n+new\n",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.title).toBe("Improve reconnect flow");
        expect(result.body).toBe("## Summary\n- x");
      }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("tolerates JSON wrapped in a markdown code fence", () =>
  withFakePi({ PI_MOCK_ASSISTANT_TEXT: '```json {"title":"Fenced title"} ```' }, (textGeneration) =>
    Effect.gen(function* () {
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "anything",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      expect(result.title).toBe("Fenced title");
    }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("fails with a TextGenerationError when Pi returns non-JSON prose", () =>
  withFakePi({ PI_MOCK_EMIT_INVALID_JSON: "1" }, (textGeneration) =>
    Effect.gen(function* () {
      const result = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(TextGenerationError);
        expect(result.failure.message).toContain("invalid structured output");
      }
    }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("fails with a TextGenerationError when the assistant text is unavailable", () =>
  withFakePi({ PI_MOCK_LAST_TEXT_FAILS: "1" }, (textGeneration) =>
    Effect.gen(function* () {
      const result = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(TextGenerationError);
      }
    }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);

it.effect("fails quickly when Pi exits before agent_end", () =>
  withFakePi({ PI_MOCK_EXIT_ON_PROMPT: "1" }, (textGeneration) =>
    Effect.gen(function* () {
      const completed = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.result, Effect.timeoutOption(3_000));

      expect(Option.isSome(completed)).toBe(true);
      if (Option.isSome(completed)) {
        expect(Result.isFailure(completed.value)).toBe(true);
        if (Result.isFailure(completed.value)) {
          expect(completed.value.failure).toBeInstanceOf(TextGenerationError);
          expect(completed.value.failure.message).toMatch(/process exited/i);
        }
      }
    }),
  ).pipe(Effect.provide(PiTextGenerationTestLayer)),
);
