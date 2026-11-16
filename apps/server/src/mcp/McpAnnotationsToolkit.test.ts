import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as AnnotationStore from "../annotations/AnnotationStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

// McpToolAccessTestkit's live threads all belong to this project.
const projectId = ProjectId.make("project:mcp-test");

const threadInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-annotations-test"),
  requestNamespace: "provider-session-annotations-test",
  thread: {
    threadId: ThreadId.make("thread-annotations-test"),
    providerSessionId: "provider-session-annotations-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layer = McpHttpServer.layerAnnotationsToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(AnnotationStore.layer),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeedSome({ id } as never),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-annotations-toolkit-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const call = (
  name: string,
  args: Record<string, unknown>,
  invocation: McpInvocationContext.McpInvocationScope = threadInvocation,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

describe("annotations MCP tools", () => {
  it.effect("claims, completes and releases the calling thread's annotations", () =>
    Effect.gen(function* () {
      const store = yield* AnnotationStore.AnnotationStore;
      yield* store.create(projectId, {
        id: "first",
        comment: "Make the button bigger",
        screenshot: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
      });
      yield* store.create(projectId, { id: "second", comment: "Which font?" });

      const claimed = yield* call("annotations_claim", {});
      expect(claimed.isError).toBe(false);
      expect(claimed.structuredContent).toMatchObject({
        annotation: { id: "first", number: 1, status: "in_progress" },
      });
      const screenshotPath = (
        claimed.structuredContent as { annotation: { screenshotPath?: string } }
      ).annotation.screenshotPath;
      expect(screenshotPath?.endsWith("first.jpg")).toBe(true);

      const done = yield* call("annotations_complete", {
        id: "first",
        summary: "Bigger button; lint passes.",
      });
      expect(done.structuredContent).toMatchObject({
        annotation: { status: "done", summary: "Bigger button; lint passes." },
      });

      yield* call("annotations_claim", { id: "second" });
      const asked = yield* call("annotations_release", {
        id: "second",
        question: true,
        summary: "Serif or sans?",
      });
      expect(asked.structuredContent).toMatchObject({
        annotation: { status: "todo", question: true },
      });
      const empty = yield* call("annotations_claim", {});
      expect(empty.structuredContent).toEqual({ annotation: null });

      const open = yield* call("annotations_list", {});
      expect(
        (open.structuredContent as { annotations: Array<{ id: string }> }).annotations.map(
          (a) => a.id,
        ),
      ).toEqual(["second"]);
      const all = yield* call("annotations_list", { all: true });
      expect(
        (all.structuredContent as { annotations: Array<{ id: string }> }).annotations,
      ).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports a conflict and refuses callers outside a thread", () =>
    Effect.gen(function* () {
      const store = yield* AnnotationStore.AnnotationStore;
      yield* store.create(projectId, { id: "only", comment: "Fix the header" });
      const conflict = yield* call("annotations_complete", { id: "only", summary: "Done" });
      expect(conflict.isError).toBe(true);
      // A client outside a thread is not offered thread-bound tools at all.
      const outside = yield* call(
        "annotations_claim",
        {},
        {
          ...threadInvocation,
          thread: undefined,
          client: { sessionId: "client", label: "Client", access: "full-access" },
        },
      ).pipe(Effect.flip);
      expect(outside.message).toContain("Tool 'annotations_claim' not found");
      // Still todo: the refused caller claimed nothing.
      expect(Option.isSome(yield* store.claim(projectId, "only"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
