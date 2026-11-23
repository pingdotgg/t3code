import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WorkflowHandlers from "./handlers.ts";
import { WorkflowToolkit } from "./tools.ts";

const handlersWith = (workflows: Partial<Workflows.Workflows["Service"]>) =>
  McpToolAccess.HandlersLayer.layer(WorkflowHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:workflow"),
          requestNamespace: "client:workflow",
          thread: undefined,
          client: { sessionId: "session-1", label: "t3 CLI", access: "full-access" },
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(Workflows.Workflows)(workflows),
      ),
    ),
  );

it.effect("start passes an explicit null payload through and defaults an omitted one to {}", () =>
  Effect.gen(function* () {
    const payloads: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      for (const input of [{ input: null }, {}]) {
        yield* toolkit
          .handle("t3_workflow", {
            action: "start",
            workflow: "echo",
            idempotencyKey: "trial",
            ...input,
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }
    }).pipe(
      Effect.provide(
        handlersWith({
          start: (_workflow, input) =>
            Effect.sync(() => {
              payloads.push(input);
              return { runId: "run-1" };
            }),
          get: () => Effect.succeed({ run: undefined, steps: [], references: [] } as never),
        }),
      ),
    );
    expect(payloads).toEqual([null, {}]);
  }),
);

it.effect("signal refuses a run destination mixed with a channel destination", () =>
  Effect.gen(function* () {
    const delivered: Array<unknown> = [];
    const results = yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      return yield* Effect.forEach(
        [
          { runId: "run-1", wait: "review", channel: "other" },
          { workflow: "other", channel: "other", runId: "run-1" },
          { runId: "run-1", wait: "review" },
        ],
        (address) =>
          toolkit
            .handle("t3_workflow", { action: "signal", value: { choice: "yes" }, ...address })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.map((parts) => parts.at(-1)?.result),
            ),
      );
    }).pipe(
      Effect.provide(
        handlersWith({
          signal: (address) =>
            Effect.sync(() => {
              delivered.push(address);
              return "delivered" as const;
            }),
        }),
      ),
    );
    for (const result of results.slice(0, -1)) {
      expect(result).toMatchObject({ code: "invalid_request" });
    }
    expect(results.at(-1)).toEqual({ delivery: "delivered" });
    expect(delivered).toEqual([{ runId: "run-1", wait: "review" }]);
  }),
);

it.effect("questions are narrowed to a kind, and runs to a tag", () =>
  Effect.gen(function* () {
    const filters: Array<unknown> = [];
    const question = (name: string, kind?: string) => ({
      runId: "run-1",
      name,
      request: { title: name, choices: ["Yes"] },
      ...(kind === undefined ? {} : { kind }),
      askedAt: "2026-11-20T00:00:00.000Z",
      thread: null,
    });
    const results = yield* Effect.gen(function* () {
      const toolkit = yield* WorkflowToolkit;
      return yield* Effect.forEach(
        [
          { action: "questions" as const, kind: "feature" },
          { action: "questions" as const },
          { action: "list" as const, tag: "backlog" },
        ],
        (input) =>
          toolkit.handle("t3_workflow", input).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          ),
      );
    }).pipe(
      Effect.provide(
        handlersWith({
          questions: Effect.succeed([
            question("wanted", "feature"),
            question("meant", "intended"),
            question("plain"),
          ]),
          list: (filter) =>
            Effect.sync(() => {
              filters.push(filter);
              return [];
            }),
        }),
      ),
    );
    expect(results[0]).toMatchObject({ questions: [{ name: "wanted" }] });
    expect(results[1]).toMatchObject({
      questions: [{ name: "wanted" }, { name: "meant" }, { name: "plain" }],
    });
    expect(filters).toEqual([{ tag: "backlog" }]);
  }),
);
