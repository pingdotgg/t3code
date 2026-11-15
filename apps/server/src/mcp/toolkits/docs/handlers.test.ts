import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type DocComment,
  EnvironmentId,
  ProjectId,
  type Project as ProjectRecord,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as DocCommentsService from "../../../docs/DocCommentsService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as KnownWorkspaces from "../../../workspace/KnownWorkspaces.ts";
import * as WorkspaceDocs from "../../../workspace/WorkspaceDocs.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as DocsHandlers from "./handlers.ts";
import { DocsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:docs");
const projectId = ProjectId.make("project:docs");

const comment = (id: string, docPath: string, resolved: boolean): DocComment => ({
  id,
  projectId,
  docPath,
  quote: "Ship it",
  prefix: "",
  suffix: "",
  author: { kind: "user", threadId: null },
  body: `Comment ${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: resolved ? "2026-01-02T00:00:00.000Z" : null,
  sentToThreadId: null,
  replies: [],
});

const comments = [
  comment("open-plan", "docs/plan.md", false),
  comment("resolved-plan", "docs/plan.md", true),
  comment("open-spec", "docs/specs/api.md", false),
];

const layerWorkspace = WorkspaceDocs.layer.pipe(
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
      ),
    ),
  ),
  Layer.provideMerge(WorkspaceEntries.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-docs-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

// Runs one docs tool as an agent on the project's root checkout, `checkout`.
type DocsTools = typeof DocsToolkit.tools;

const callTool = <Name extends keyof DocsTools>(
  checkout: string,
  name: Name,
  params: Tool.ParametersEncoded<DocsTools[Name]>,
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      layerWorkspace,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:docs"),
        requestNamespace: "session",
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed({
            ...McpToolAccessTestkit.liveThreadShell(id),
            projectId,
          }),
      }),
      Layer.mock(Project.ProjectService)({
        getById: () => Effect.succeedSome({ workspaceRoot: checkout } as ProjectRecord),
      }),
      Layer.mock(DocCommentsService.DocCommentsService)({
        list: ({ docPath }) =>
          Effect.succeed({ comments: comments.filter((entry) => entry.docPath === docPath) }),
        listForProject: ({ includeResolved }) =>
          Effect.succeed(comments.filter((entry) => includeResolved || entry.resolvedAt === null)),
      }),
    );
    const toolkit = yield* DocsToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(DocsHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle(name, params as Parameters<typeof toolkit.handle<Name>>[1])
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result as Record<string, unknown>;
  });

const makeCheckout = Effect.fn("makeCheckout")(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-docs-" });
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  }
  return root;
});

describe("docs toolkit", () => {
  it.effect("reads a doc with only its open comments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* makeCheckout({ "docs/plan.md": "# Plan\n\nShip it.\n" });

        const read = yield* callTool(checkout, "docs_read", { docPath: "docs/plan.md" });
        expect(read).toMatchObject({
          docPath: "docs/plan.md",
          title: "plan",
          markdown: "# Plan\n\nShip it.\n",
          truncated: false,
        });
        expect((read.comments as ReadonlyArray<DocComment>).map((entry) => entry.id)).toEqual([
          "open-plan",
        ]);

        expect(
          yield* callTool(checkout, "docs_read", { docPath: "docs/missing.md" }),
        ).toMatchObject({
          code: "invalid_request",
          message: "No doc exists at 'docs/missing.md'.",
        });
        expect(yield* callTool(checkout, "docs_read", { docPath: "../outside.md" })).toMatchObject({
          code: "invalid_request",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("lists markdown docs recursively with open comment counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* makeCheckout({
          "docs/plan.md": "# Plan\n",
          "docs/specs/api.md": "# API\n",
          "docs/specs/diagram.png": "png",
          "docs/notes.txt": "notes",
          "README.md": "# Readme\n",
        });

        expect(yield* callTool(checkout, "docs_list", {})).toEqual({
          docs: [
            { docPath: "docs/plan.md", title: "plan", openComments: 1 },
            { docPath: "docs/specs/api.md", title: "api", openComments: 1 },
          ],
          truncated: false,
        });
        expect(yield* callTool(checkout, "docs_list", { folder: "missing" })).toEqual({
          docs: [],
          truncated: false,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("opens only a doc that exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* makeCheckout({ "docs/plan.md": "# Plan\n\nShip **Friday**.\n" });
        expect(yield* callTool(checkout, "docs_open", { docPath: "docs/plan.md" })).toEqual({
          doc: { docPath: "docs/plan.md", title: "plan", excerpt: "Ship Friday." },
        });
        expect(yield* callTool(checkout, "docs_open", { docPath: "docs/gone.md" })).toMatchObject({
          code: "invalid_request",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
