import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { LinearService } from "../../../linear/LinearService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Testkit from "../../McpToolAccess.testkit.ts";
import { LinearToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

it.effect("allows read-only Linear reads and refuses writes before the service runs", () =>
  Effect.gen(function* () {
    let writes = 0;
    const dependencies = Layer.mergeAll(
      Testkit.liveThreadsLayer,
      Layer.mock(LinearService)({
        issues: () =>
          Effect.succeed({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }),
        mutate: () =>
          Effect.sync(() => {
            writes++;
            return { success: true, id: "created" };
          }),
      }),
    );
    const toolkit = yield* LinearToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "test",
      thread: undefined,
      client: { sessionId: "client", label: "Read only", access: "read-only", linked: false },
      capabilities: new Set(["linear"]),
      issuedAt: 1,
    };
    const read = yield* toolkit
      .handle("linear_issues", {})
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(dependencies),
      );
    expect(read.at(-1)?.result).toEqual({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    const error = yield* toolkit
      .handle("linear_mutate", { change: { kind: "issueArchive", id: "issue" } })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(dependencies),
      );
    expect(error.at(-1)?.result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "capability_denied",
    });
    expect(writes).toBe(0);
    const written = yield* toolkit
      .handle("linear_mutate", { change: { kind: "issueArchive", id: "issue" } })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          client: { sessionId: "writer", label: "Writer", access: "full-access", linked: false },
        }),
        Effect.provide(dependencies),
      );
    expect(written.at(-1)?.result).toEqual({ success: true, id: "created" });
    expect(writes).toBe(1);
    const denied = yield* toolkit.handle("linear_issues", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...scope,
        capabilities: new Set<McpInvocationContext.McpCapability>(),
      }),
      Effect.provide(dependencies),
    );
    expect(denied.at(-1)?.result).toMatchObject({
      _tag: "McpCapabilityUnavailableError",
      capability: "linear",
    });
  }),
);
