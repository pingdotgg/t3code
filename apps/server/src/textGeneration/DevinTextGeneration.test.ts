// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDevinTextGeneration } from "./DevinTextGeneration.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const DevinTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The shared ACP fixture advertises `default`, while the real Devin catalog
// supplies `adaptive`. Text-generation behavior does not depend on that name.
const modelSelection = createModelSelection(ProviderInstanceId.make("devin"), "default");

function makeThreadTitleInput() {
  return {
    cwd: process.cwd(),
    message: "Add Devin text generation coverage.",
    modelSelection,
  } satisfies TextGeneration.ThreadTitleGenerationInput;
}

function makeCommitMessageInput() {
  return {
    cwd: process.cwd(),
    branch: "feature/devin-text-generation",
    stagedSummary: "M apps/server/src/textGeneration/DevinTextGeneration.ts",
    stagedPatch: "diff --git a/apps/server/src/textGeneration/DevinTextGeneration.ts b/...",
    modelSelection,
  } satisfies TextGeneration.CommitMessageGenerationInput;
}

const makeMockDevinWrapper = Effect.fn("makeMockDevinWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const isWindows = yield* isHostWindows;
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-text-generation-mock-")),
  );

  if (isWindows) {
    const wrapperPath = NodePath.join(dir, "fake-devin.cmd");
    const envLines = Object.entries(extraEnv ?? {})
      .map(([key, value]) => `set ${key}=${value}`)
      .join("\r\n");
    const script = `@echo off\r\n${envLines}\r\n"${mockAgentCommand}" "${mockAgentPath}" %*\r\n`;
    yield* Effect.promise(() => NodeFSP.writeFile(wrapperPath, script, "utf8"));
    return wrapperPath;
  }

  const wrapperPath = NodePath.join(dir, "fake-devin.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${shellQuote(mockAgentCommand)} ${shellQuote(mockAgentPath)} "$@"
`;
  yield* Effect.promise(() => NodeFSP.writeFile(wrapperPath, script, "utf8"));
  yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));
  return wrapperPath;
});

function withFakeDevin<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
  options?: Parameters<typeof makeDevinTextGeneration>[2],
) {
  return Effect.gen(function* () {
    const wrapperPath = yield* makeMockDevinWrapper(env);
    const textGeneration = yield* makeDevinTextGeneration(
      decodeDevinSettings({ enabled: true, binaryPath: wrapperPath, customModels: [] }),
      undefined,
      options,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(DevinTextGenerationTestLayer, { excludeTestServices: true })(
  "DevinTextGeneration",
  (it) => {
    it.effect("decodes successful structured output", () =>
      withFakeDevin(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "Add Devin text generation coverage",
            body: "Cover the ACP text-generation boundary.",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage(makeCommitMessageInput());
            expect(generated.subject).toBe("Add Devin text generation coverage");
            expect(generated.body).toBe("Cover the ACP text-generation boundary.");
          }),
      ),
    );

    it.effect("accepts a large structured response without truncating it", () => {
      const body = "large response ".repeat(1_024).trimEnd();
      return withFakeDevin(
        {
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            title: "Handle a large Devin response",
            body,
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/devin-text-generation",
              commitSummary: "Add Devin text generation coverage",
              diffSummary: "M apps/server/src/textGeneration/DevinTextGeneration.ts",
              diffPatch: "diff --git a/apps/server/src/textGeneration/DevinTextGeneration.ts b/...",
              modelSelection,
            });
            expect(generated.body).toBe(body);
          }),
      );
    });

    it.effect("returns a typed error for malformed JSON", () =>
      withFakeDevin({ T3_ACP_PROMPT_RESPONSE_TEXT: "not structured JSON" }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle(makeThreadTitleInput()),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
      ),
    );

    it.effect("returns a typed error for empty output", () =>
      withFakeDevin({ T3_ACP_PROMPT_RESPONSE_TEXT: "  \n  " }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle(makeThreadTitleInput()),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
      ),
    );

    it.effect("maps process startup failures to TextGenerationError", () =>
      Effect.gen(function* () {
        const isWindows = yield* isHostWindows;
        const missingDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-text-generation-missing-")),
        );
        const missingBinary = NodePath.join(missingDir, `devin${isWindows ? ".exe" : ""}`);
        const textGeneration = yield* makeDevinTextGeneration(
          decodeDevinSettings({ enabled: true, binaryPath: missingBinary, customModels: [] }),
        );
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle(makeThreadTitleInput()),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.operation).toBe("generateThreadTitle");
      }).pipe(Effect.scoped),
    );

    it.effect("times out and terminates a stalled ACP process", () => {
      // The scoped text-generation effect must close the ACP child after its
      // timeout. If cleanup regresses, this test hangs on the stalled mock.
      return withFakeDevin(
        { T3_ACP_HANG_PROMPT_FOREVER: "1" },
        (textGeneration) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              textGeneration.generateThreadTitle(makeThreadTitleInput()),
            );
            expect(error._tag).toBe("TextGenerationError");
            expect(error.detail).toMatch(/timed out/i);
          }),
        { timeout: 50 },
      );
    });
  },
);
