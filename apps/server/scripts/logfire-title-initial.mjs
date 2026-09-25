import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NetService from "@t3tools/shared/Net";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { loadRepoEnv } from "../../../scripts/lib/public-config.ts";
import { resolveCliAuthConfig } from "../src/cli/config.ts";
import * as ServerConfig from "../src/config.ts";
import { ObservabilityLive } from "../src/observability/Layers/Observability.ts";
import { makeCodexTextGeneration } from "../src/textGeneration/CodexTextGeneration.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

// Call the same first-message builder and Codex adapter used by new T3 threads.
// No coding-agent turn, prior title, conversation compression, or mocked output.
const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const [caseId, suppliedRequestId] = process.argv.slice(2);
const corpus = JSON.parse(
  await NodeFSP.readFile(`${root}demos/logfire-titles/corpus.json`, "utf8"),
);
const item = corpus.find((item) => item.id === caseId);
if (!item || item.messages.length !== 1 || item.messages[0].role !== "user")
  throw new Error("Initial title cases require exactly one user message.");
const requestId = suppliedRequestId ?? NodeCrypto.randomUUID();
const threadId = `logfire-title-${caseId}`;
const env = loadRepoEnv();
Object.assign(process.env, env);
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(`${root}.t3`) },
        Option.some("Error"),
      );
      return yield* Effect.gen(function* () {
        const generator = yield* makeCodexTextGeneration(decodeCodexSettings({}), env);
        return yield* generator.generateThreadTitle({
          cwd: root,
          threadId,
          requestId,
          message: item.messages[0].text,
          modelSelection: {
            instanceId: "codex",
            model: "gpt-6-luna",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        });
      }).pipe(
        Effect.provide(ObservabilityLive.pipe(Layer.provideMerge(ServerConfig.layer(config)))),
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
    ),
  ),
);
console.log(
  JSON.stringify({
    case_id: caseId,
    thread_id: threadId,
    request_id: requestId,
    title: result.title,
  }),
);
