import {
  CanvasNodeNotFoundError,
  CanvasOpRejectedError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { exportCanvasHtml } from "@t3tools/shared/canvasExport";
import * as Effect from "effect/Effect";

import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { formatCanvasTree, resolveAgentOps } from "./agentCanvas.ts";
import { CanvasScreenshotToolkit, CanvasStandardToolkit } from "./tools.ts";

const EXPORT_MAX_CHARS = 300_000;
const READ_DEFAULT_MAX_NODES = 500;

/** Canvases belong to the calling thread's project; other projects read as missing. */
const access = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Canvas tools need an agent running inside a T3 Code thread.",
    });
  }
  return { caller, canvas: yield* CanvasService.CanvasService };
});

const standardHandlers = {
  canvas_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const canvases = yield* canvas.list({ projectId: caller.projectId });
      const query = input.query?.trim().toLowerCase();
      return {
        canvases: query
          ? canvases.filter((summary) => summary.name.toLowerCase().includes(query))
          : canvases,
      };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
  canvas_create: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const context = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(Effect.asVoid, Effect.provideContext(context));
      const { document, warnings } =
        input.importPath == null
          ? yield* canvas.create(
              { projectId: caller.projectId, name: input.name ?? undefined },
              authorize,
            )
          : yield* canvas.createFromWorkspaceFile(
              {
                projectId: caller.projectId,
                workspaceRoot: caller.worktreePath,
                relativePath: input.importPath,
                name: input.name ?? undefined,
              },
              authorize,
            );
      return {
        documentId: document.id,
        name: document.name,
        nodeCount: Object.keys(document.nodes).length,
        rootIds: document.rootIds.slice(0, 50),
        warnings: warnings.slice(0, 50),
      };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
  canvas_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const document = yield* canvas.get({
        documentId: input.documentId,
        projectId: caller.projectId,
      });
      if (input.rootId != null && !document.nodes[input.rootId]) {
        return yield* new CanvasNodeNotFoundError({
          documentId: input.documentId,
          nodeId: input.rootId,
        });
      }
      const { tree, truncated } = formatCanvasTree(document, {
        ...(input.rootId == null ? {} : { rootId: input.rootId }),
        ...(input.depth == null ? {} : { depth: input.depth }),
        maxNodes: input.maxNodes ?? READ_DEFAULT_MAX_NODES,
      });
      const root = input.rootId == null ? undefined : document.nodes[input.rootId];
      return {
        documentId: document.id,
        name: document.name,
        revision: document.revision,
        nodeCount: Object.keys(document.nodes).length,
        tree,
        truncated,
        ...(root === undefined ? {} : { node: root }),
      };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
  canvas_apply: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const context = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(Effect.asVoid, Effect.provideContext(context));
      const resolved = resolveAgentOps(input.ops);
      if (!resolved.ok) {
        return yield* new CanvasOpRejectedError({
          documentId: input.documentId,
          reason: resolved.reason,
        });
      }
      const { revision } = yield* canvas.applyOps(
        {
          documentId: input.documentId,
          projectId: caller.projectId,
          ops: resolved.ops,
        },
        authorize,
      );
      return { revision, insertedIds: resolved.insertedIds, refs: resolved.refs };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
  canvas_export: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const document = yield* canvas.get({
        documentId: input.documentId,
        projectId: caller.projectId,
      });
      if (input.nodeId != null && !document.nodes[input.nodeId]) {
        return yield* new CanvasNodeNotFoundError({
          documentId: input.documentId,
          nodeId: input.nodeId,
        });
      }
      const html = exportCanvasHtml(document, input.nodeId ?? undefined);
      return html.length > EXPORT_MAX_CHARS
        ? { html: html.slice(0, EXPORT_MAX_CHARS), truncated: true }
        : { html, truncated: false };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
  canvas_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      yield* canvas.open({
        threadId: caller.id,
        projectId: caller.projectId,
        documentId: input.documentId ?? undefined,
      });
      return {};
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
  canvas_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const htmlRender = yield* canvas.render({
        documentId: input.documentId,
        projectId: caller.projectId,
        threadId: caller.id,
        nodeId: input.nodeId ?? undefined,
        scale: input.scale ?? undefined,
        title: input.title ?? undefined,
      });
      return { documentId: input.documentId, htmlRender };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
} satisfies McpToolAccess.Handlers<typeof CanvasStandardToolkit.tools>;

const screenshotHandlers = {
  canvas_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, canvas } = yield* access;
      const shot = yield* canvas.screenshot({
        documentId: input.documentId,
        projectId: caller.projectId,
        nodeId: input.nodeId ?? undefined,
        scale: input.scale ?? undefined,
      });
      return {
        documentId: input.documentId,
        screenshot: {
          mimeType: "image/png" as const,
          data: shot.pngBase64,
          width: shot.width,
          height: shot.height,
        },
      };
    }).pipe(CanvasService.recoverCanvasDisabled),
  ),
} satisfies McpToolAccess.Handlers<typeof CanvasScreenshotToolkit.tools>;

export const layerStandard = McpToolAccess.toLayer(CanvasStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(CanvasScreenshotToolkit, screenshotHandlers);
