// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { PrimeAgentSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { makePrimeAgentTextGeneration } from "./PrimeAgentTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const decodePrimeAgentSettings = Schema.decodeSync(PrimeAgentSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makePrimeAgentWrapper(dir: string, env: Record<string, string>): string {
  const binaryPath = NodePath.join(dir, "prime-agent");
  const logArgsScript =
    'require("node:fs").appendFileSync(process.env.T3_PRIME_AGENT_LAUNCH_LOG_PATH, JSON.stringify(process.argv.slice(1)) + "\\n")';
  NodeFS.writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      `node -e ${shellSingleQuote(logArgsScript)} -- "$@"`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function withFakePrimeAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (input: {
    readonly textGeneration: TextGeneration.TextGeneration["Service"];
    readonly launchLogPath: string;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-prime-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const launchLogPath = NodePath.join(tempDir, "launch.ndjson");
    const binaryPath = makePrimeAgentWrapper(tempDir, {
      ...env,
      T3_PRIME_AGENT_LAUNCH_LOG_PATH: launchLogPath,
    });
    const settings = decodePrimeAgentSettings({ binaryPath });
    const textGeneration = yield* makePrimeAgentTextGeneration(settings);
    return yield* effectFn({ textGeneration, launchLogPath });
  }).pipe(Effect.scoped);
}

function readLaunches(path: string): ReadonlyArray<ReadonlyArray<string>> {
  return NodeFS.readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReadonlyArray<string>);
}

function argumentValue(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

it.layer(NodeServices.layer)("PrimeAgentTextGeneration", (it) => {
  it.effect("passes model and thinking at launch and sanitizes structured commit output", () =>
    withFakePrimeAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "  Add Prime Agent text generation.\nIgnore this line",
          body: "  Generate commit metadata through ACP.  ",
          branch: "Prime Agent/Text Generation!!",
        }),
      },
      ({ textGeneration, launchLogPath }) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/prime-agent",
            stagedSummary: "M apps/server/src/textGeneration/PrimeAgentTextGeneration.ts",
            stagedPatch: "diff --git a/PrimeAgentTextGeneration.ts b/PrimeAgentTextGeneration.ts",
            includeBranch: true,
            modelSelection: createModelSelection(
              ProviderInstanceId.make("primeAgent"),
              "openai/gpt-5",
              [{ id: "thinking", value: "high" }],
            ),
          });

          expect(generated).toEqual({
            subject: "Add Prime Agent text generation",
            body: "Generate commit metadata through ACP.",
            branch: "feature/prime-agent/text-generation",
          });

          const launches = readLaunches(launchLogPath);
          expect(launches).toHaveLength(1);
          expect(launches[0]).toEqual([
            "--mode",
            "acp",
            "--offline",
            "--cwd",
            process.cwd(),
            "--session-dir",
            expect.any(String),
            "--model",
            "openai/gpt-5",
            "--thinking",
            "high",
          ]);
          const sessionDir = argumentValue(launches[0]!, "--session-dir");
          expect(sessionDir).toBeDefined();
          expect(NodeFS.existsSync(sessionDir!)).toBe(false);
        }),
    ),
  );

  it.effect("uses a fresh isolated session directory and omits the default model", () =>
    withFakePrimeAgent(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          'Here is the result:\n```json\n{"title":"\\"Investigate   Prime Agent histories.\\""}\n```',
      },
      ({ textGeneration, launchLogPath }) =>
        Effect.gen(function* () {
          const modelSelection = createModelSelection(
            ProviderInstanceId.make("primeAgent"),
            "default",
          );
          const first = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Check one text generation session.",
            modelSelection,
          });
          const second = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Check another text generation session.",
            modelSelection,
          });

          expect(first.title).toBe("Investigate Prime Agent histories.");
          expect(second.title).toBe("Investigate Prime Agent histories.");

          const launches = readLaunches(launchLogPath);
          expect(launches).toHaveLength(2);
          const sessionDirs = launches.map((args) => argumentValue(args, "--session-dir"));
          expect(sessionDirs[0]).toBeDefined();
          expect(sessionDirs[1]).toBeDefined();
          expect(sessionDirs[0]).not.toBe(sessionDirs[1]);
          for (const [index, launch] of launches.entries()) {
            expect(launch).not.toContain("--continue");
            expect(launch).not.toContain("--model");
            expect(NodeFS.existsSync(sessionDirs[index]!)).toBe(false);
          }
        }),
    ),
  );

  it.effect("fails with a typed error when Prime Agent returns empty output", () =>
    withFakePrimeAgent({ T3_ACP_PROMPT_RESPONSE_TEXT: "  \n " }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Add Prime Agent text generation.",
            modelSelection: createModelSelection(ProviderInstanceId.make("primeAgent"), "default"),
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toMatch(/empty/i);
      }),
    ),
  );

  it.effect("fails with a typed error when structured output is invalid", () =>
    withFakePrimeAgent(
      { T3_ACP_PROMPT_RESPONSE_TEXT: "not valid structured output" },
      ({ textGeneration }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Add Prime Agent text generation.",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("primeAgent"),
                "default",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );

  it.effect("wraps ACP request failures in a typed text generation error", () =>
    withFakePrimeAgent({ T3_ACP_FAIL_PROMPT: "1" }, ({ textGeneration }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Add Prime Agent text generation.",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("primeAgent"),
              "openai/gpt-5",
            ),
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toMatch(/ACP request failed/i);
      }),
    ),
  );
});
