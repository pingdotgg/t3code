// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequestLogEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optionalKey(Schema.String),
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const OmpTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeOmpWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const ompPath = NodePath.join(binDir, "omp");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    ompPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec bun ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(ompPath, 0o755);
  return ompPath;
}

it.layer(OmpTextGenerationTestLayer)("OmpTextGeneration", (it) => {
  it.effect("uses the exact OMP provider/model selector for structured generation", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-acp-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }),
      );

      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const model = "openai-codex/gpt-5.4";
      const ompPath = makeOmpWrapper(tempDir, {
        T3_ACP_EXTRA_MODEL_ID: model,
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: encodeUnknownJson({
          subject: "Add OMP structured generation",
          body: "- select the exact provider model",
        }),
      });
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({ binaryPath: ompPath }),
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/omp-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/OmpTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/textGeneration/OmpTextGeneration.ts b/apps/server/src/textGeneration/OmpTextGeneration.ts",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model,
        },
      });

      expect(generated).toEqual({
        subject: "Add OMP structured generation",
        body: "- select the exact provider model",
      });

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeRequestLogEntry(line));
      expect(requests.find((request) => request.method === "authenticate")?.params).toMatchObject({
        methodId: "agent",
      });
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "model" &&
            request.params?.value === model,
        ),
      ).toBe(true);
      expect(
        requests.find((request) => request.method === "session/prompt")?.params?.prompt,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Staged patch:"),
          }),
        ]),
      );
    }).pipe(Effect.scoped),
  );
});
