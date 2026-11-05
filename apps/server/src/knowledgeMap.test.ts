// @ts-nocheck -- vitest types are not included in the server package typecheck config.
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as Service from "./knowledgeMap.ts";

const run = (
  body: (
    service: Service.KnowledgeMap["Service"],
    fs: FileSystem.FileSystem["Service"],
    target: string,
  ) => Effect.Effect<unknown>,
  file?: string,
) => {
  const dir = "/tmp/knowledge-map-test";
  const target = `${dir}/knowledge.json`;
  const config = ServerConfig.ServerConfig.of({ stateDir: dir } as never);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.remove(target).pipe(Effect.ignore);
    if (file !== undefined) yield* fs.writeFileString(target, file);
    const service = yield* Service.KnowledgeMap;
    return yield* body(service, fs, target);
  }).pipe(
    Effect.provide(Service.layer),
    Effect.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
    Effect.provide(NodeServices.layer),
  );
};

describe("KnowledgeMap", () => {
  it("replaces a topic regardless of case and whitespace", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- focused service behavior test
    const result = await Effect.runPromise(
      run((service) =>
        Effect.gen(function* () {
          yield* service.markDone({
            topic: "  HTTP  ",
            explanation: "first",
            threadId: ThreadId.make("thread"),
          });
          yield* service.markDone({
            topic: "http",
            explanation: "second",
            threadId: ThreadId.make("thread"),
          });
          return yield* service.list;
        }),
      ),
    );
    expect(result).toHaveLength(1);
    expect((result as any)[0].explanation).toBe("second");
  });
  it("removes a topic and ignores missing topics", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- focused service behavior test
    const result = await Effect.runPromise(
      run((service) =>
        Effect.gen(function* () {
          yield* service.markDone({
            topic: "HTTP",
            explanation: "words",
            threadId: ThreadId.make("thread"),
          });
          yield* service.remove("http");
          return yield* service.remove("missing");
        }),
      ),
    );
    expect(result).toHaveLength(0);
  });
  it("does not overwrite corrupt storage", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- focused service behavior test
    const result = await Effect.runPromise(
      run(
        (service, fs, target) =>
          Effect.gen(function* () {
            const before = yield* fs.readFileString(target);
            const exit = yield* Effect.exit(
              service.markDone({
                topic: "HTTP",
                explanation: "words",
                threadId: ThreadId.make("thread"),
              }),
            );
            const after = yield* fs.readFileString(target);
            return { exit, before, after };
          }),
        "not json",
      ),
    );
    expect((result as any).exit._tag).toBe("Failure");
    expect((result as any).after).toBe((result as any).before);
  });
});
