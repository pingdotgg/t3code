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

it.effect("start passes an explicit null payload through and defaults an omitted one to {}", () =>
  Effect.gen(function* () {
    const payloads: Array<unknown> = [];
    const layerDependencies = Layer.mergeAll(
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
      Layer.mock(Workflows.Workflows)({
        start: (_workflow, input) =>
          Effect.sync(() => {
            payloads.push(input);
            return { runId: "run-1" };
          }),
        get: () => Effect.succeed({ run: undefined, steps: [], references: [] } as never),
      }),
    );
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
        McpToolAccess.HandlersLayer.layer(WorkflowHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
    expect(payloads).toEqual([null, {}]);
  }),
);
