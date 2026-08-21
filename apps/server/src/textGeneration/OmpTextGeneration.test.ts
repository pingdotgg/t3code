// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ChatAttachment, ProviderInstanceId, OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const decodeChatAttachment = Schema.decodeSync(ChatAttachment);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const OmpTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeAcpAgentWrapper(dir: string, environment: Record<string, string>): string {
  const wrapperPath = NodePath.join(dir, "omp");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      ...Object.entries(environment).map(
        ([key, value]) => `export ${key}=${shellSingleQuote(value)}`,
      ),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      'if [ -n "${T3_OMP_ARGV_PATH:-}" ]; then',
      '  printf "%s\\n" "$@" > "$T3_OMP_ARGV_PATH"',
      "fi",
      `exec node ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

it.layer(OmpTextGenerationTestLayer)("OmpTextGeneration", (it) => {
  it.effect("starts ACP with an isolated command", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const argvPath = NodePath.join(tempDir, "argv.txt");
      const binaryPath = makeAcpAgentWrapper(tempDir, {
        T3_OMP_ARGV_PATH: argvPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Safe generated title"}',
      });
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({
          binaryPath,
          launchArgs:
            "--tools bash --yolo -e /tmp/unsafe.ts --extension /tmp/unsafe-two.ts --hook /tmp/unsafe-three.ts",
        }),
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Write a short title.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });

      expect(generated.title).toBe("Safe generated title");
      const argv = NodeFS.readFileSync(argvPath, "utf8").trim().split("\n");
      expect(argv.slice(0, 2)).toEqual(["acp", "--session-dir"]);
      const sessionDir = argv[2];
      expect(sessionDir).toBeDefined();
      expect(argv.slice(3)).toEqual([
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--approval-mode",
        "always-ask",
      ]);
      expect(NodeFS.existsSync(sessionDir!)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("denies ACP tool permission requests", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const binaryPath = makeAcpAgentWrapper(tempDir, {
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });
      const textGeneration = yield* makeOmpTextGeneration(decodeOmpSettings({ binaryPath }));

      yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Write a short title.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "default",
          },
        })
        .pipe(Effect.exit);

      const messages = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages).toContainEqual(
        expect.objectContaining({
          result: {
            outcome: { outcome: "cancelled" },
          },
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("sends image attachments as ACP image blocks", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const binaryPath = makeAcpAgentWrapper(tempDir, {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Image title"}',
      });
      const serverConfig = yield* ServerConfig.ServerConfig;
      const attachment = decodeChatAttachment({
        type: "image",
        id: "omp-image-123e4567-e89b-12d3-a456-426614174000",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
      });
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      expect(attachmentPath).not.toBeNull();
      if (!attachmentPath) return;
      NodeFS.mkdirSync(serverConfig.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Buffer.from([1, 2, 3, 4]));

      const textGeneration = yield* makeOmpTextGeneration(decodeOmpSettings({ binaryPath }));
      yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Name this screenshot.",
        attachments: [attachment],
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });

      const messages = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(messages).toContainEqual(
        expect.objectContaining({
          method: "session/prompt",
          params: expect.objectContaining({
            prompt: expect.arrayContaining([
              {
                type: "image",
                data: "AQIDBA==",
                mimeType: "image/png",
              },
            ]),
          }),
        }),
      );
    }).pipe(Effect.scoped),
  );
});
