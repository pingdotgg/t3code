import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentSessionImportSources, layer } from "./AgentSessionImportSources.ts";

it.layer(layer.pipe(Layer.provide(NodeSqliteClient.layerMemory())))(
  "AgentSessionImportSources",
  (it) => {
    it.effect("identifies the source and write operation when recording fails", () =>
      Effect.gen(function* () {
        const store = yield* AgentSessionImportSources;
        const threadId = ThreadId.make("thread:failed-import-record");
        const source = {
          provider: "codex" as const,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "session",
          filePath: "/session.jsonl",
          size: 100,
          mtimeMs: 1,
          device: 1,
          inode: 2,
          birthtimeMs: 1,
        };
        const failure = yield* store.record(threadId, source).pipe(Effect.flip);
        assert.equal(failure.operation, "record-import-source");
        assert.equal(failure.threadId, threadId);
        assert.equal(failure.filePath, source.filePath);
        assert.include(failure.message, "record-import-source");
      }),
    );
  },
);
