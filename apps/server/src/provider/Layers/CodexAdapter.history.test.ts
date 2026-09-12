// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { CodexSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

it.effect(
  "reuses one initialize-only Codex transport across concurrent and repeated history reads",
  () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-history-client-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const log = NodePath.join(dir, "methods.txt");
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "codex-history",
        env: { HISTORY_TEST_LOG: log },
        source: `
      import { appendFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        appendFileSync(process.env.HISTORY_TEST_LOG, request.method + "\\n");
        if (request.id === undefined) return;
        const result = request.method === "initialize" ? { userAgent: "codex/1.0", codexHome: process.cwd(), platformFamily: "unix", platformOs: "linux" }
          : { thread: { id: request.params.threadId, cliVersion: "test", createdAt: 0, updatedAt: 0,
              cwd: process.cwd(), ephemeral: false, modelProvider: "openai", preview: "", sessionId: "session",
              status: { type: "idle" }, source: { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } },
              turns: [{ id: "turn", status: "completed", error: null, items: [{ id: "message", type: "agentMessage", text: "Saved answer" }] }] } };
        process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
      });
    `,
      });
      const adapter = yield* makeCodexAdapter(yield* decodeCodexSettings({ binaryPath }));
      const input = {
        threadId: ThreadId.make("stopped"),
        agentId: "child",
        cwd: dir,
        offset: 0,
        resumeCursor: { threadId: "parent" },
      };
      const results = yield* Effect.all(
        [adapter.getAgentHistory!(input), adapter.getAgentHistory!(input)],
        { concurrency: "unbounded" },
      );
      expect(results.every((result) => result.entries[0]?.detail === "Saved answer")).toBe(true);
      yield* adapter.getAgentHistory!(input);
      const methods = NodeFS.readFileSync(log, "utf8").trim().split("\n");
      expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
      expect(methods.filter((method) => method === "thread/read")).toHaveLength(6);
      expect(
        methods.every((method) => ["initialize", "initialized", "thread/read"].includes(method)),
      ).toBe(true);
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
