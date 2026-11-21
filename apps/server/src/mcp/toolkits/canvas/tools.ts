import {
  CanvasDocumentId,
  CanvasDocumentSummary,
  CanvasError,
  CanvasNodeId,
  NonNegativeInt,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { HTML_RENDER_MAX_TITLE_LENGTH } from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  CanvasService.CanvasService,
];
const failure = Schema.Union([OrchestratorMcpFailure, CanvasError]);

/**
 * The node model, taught once in canvas_apply and referenced by the others.
 * Kept short: these descriptions ride along in every agent session.
 */
const NODE_MODEL = [
  "Node model: a flat map of nodes with id, type (frame|group|rect|ellipse|line|path|text|image), parentId (null = top level), and x,y,width,height in px relative to the parent's top-left. Children render back-to-front in insertion order.",
  "Optional CSS-shaped styles: fills [{type:'solid',color:'#rrggbb[aa]'} | {type:'linear-gradient',angle,stops:[{offset:0..1,color}]} | {type:'radial-gradient',stops} | {type:'image',assetId,fit:'fill'|'fit'|'crop'|'tile'}], strokes [{color,width,align?,dash?}], cornerRadius (number or [tl,tr,br,bl]), shadows [{x,y,blur,spread,color,inset?}], opacity, rotation (deg), visible, clipContent, layerBlur, backgroundBlur.",
  "Frames may set layout {direction:'row'|'column',gap?,padding?:[t,r,b,l],align?:'start'|'center'|'end'|'stretch',justify?:'start'|'center'|'end'|'space-between',wrap?} (flexbox; it positions children).",
  "Text nodes set text {content,fontSize,color,fontFamily?,fontWeight?,lineHeight?,letterSpacing?,align?,sizing?:'auto-width'|'auto-height'|'fixed'}. path/line nodes set path (SVG path data, node-local).",
  "animations [{id,property:'x'|'y'|'width'|'height'|'rotation'|'opacity'|'scale'|'cornerRadius'|'fill',keyframes:[{offset:0..1,value,easing?}],durationMs,delayMs?,loop?,alternate?,trigger?:'load'|'hover'|'press'}]. className: Tailwind classes for HTML export.",
].join("\n");

// Providers commonly send null for optional parameters.
const optionalParam = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const DocumentIdParam = CanvasDocumentId.annotate({
  description: "From canvas_list or canvas_create.",
});

const CanvasListTool = Tool.make("canvas_list", {
  description: "List this thread's project canvases: ids, names, revisions, node counts.",
  // An empty struct serializes as `anyOf [object, array]`, which some providers reject.
  parameters: Schema.Struct({
    query: optionalParam(
      Schema.String.annotate({ description: "Only canvases whose name contains this text." }),
    ),
  }),
  success: Schema.Struct({ canvases: Schema.Array(CanvasDocumentSummary) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List canvases")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasCreateTool = Tool.make("canvas_create", {
  description:
    "Create a canvas in this thread's project, empty or imported from a workspace .pen (pencil.dev), .fig (Figma), or .zip holding one plus assets. Then call canvas_open to show it.",
  parameters: Schema.Struct({
    name: optionalParam(
      Schema.String.annotate({
        description: "Defaults to the imported file's name or 'Untitled'.",
      }),
    ),
    importPath: optionalParam(
      Schema.String.annotate({
        description: "Workspace-relative .pen, .fig, or .zip to import.",
      }),
    ),
  }),
  success: Schema.Struct({
    documentId: CanvasDocumentId,
    name: Schema.String,
    nodeCount: NonNegativeInt,
    rootIds: Schema.Array(CanvasNodeId),
    warnings: Schema.Array(Schema.String),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasReadTool = Tool.make("canvas_read", {
  description:
    'Read a canvas as an indented tree, one node per line: `id type "name" x,y wxh` plus key styles. Use rootId and depth to zoom in; with rootId, that node\'s full JSON is included.',
  parameters: Schema.Struct({
    documentId: DocumentIdParam,
    rootId: optionalParam(
      CanvasNodeId.annotate({ description: "Start here instead of the top level." }),
    ),
    depth: optionalParam(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })).annotate({
        description: "Levels below the start. Default all.",
      }),
    ),
    maxNodes: optionalParam(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 })).annotate({
        description: "Line limit. Default 500.",
      }),
    ),
  }),
  success: Schema.Struct({
    documentId: CanvasDocumentId,
    name: Schema.String,
    revision: NonNegativeInt,
    nodeCount: NonNegativeInt,
    tree: Schema.String,
    truncated: Schema.Boolean,
    node: Schema.optional(Schema.Unknown),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasApplyOp = Schema.Struct({
  op: Schema.Literals(["insert", "update", "delete", "move", "rename", "put-asset"]),
  ref: optionalParam(
    Schema.String.annotate({
      description:
        "insert: a name for the new node; later ops in the batch may use it as an id or parentId.",
    }),
  ),
  node: optionalParam(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description:
        "insert: the node. type required; id generated if omitted; parentId null, x,y 0 and shapes 100x100 by default; text without a size auto-sizes.",
    }),
  ),
  id: optionalParam(
    Schema.String.annotate({ description: "update, delete, move: node id or ref." }),
  ),
  patch: optionalParam(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description:
        "update: fields to set; null clears. Arrays (fills, shadows...) are replaced whole. Reparent with move.",
    }),
  ),
  parentId: optionalParam(
    Schema.NullOr(Schema.String).annotate({
      description:
        "insert, move: parent id or ref; null = top level. insert prefers node.parentId.",
    }),
  ),
  index: optionalParam(
    NonNegativeInt.annotate({
      description: "insert, move: sibling position (0 = back). Default front.",
    }),
  ),
  name: optionalParam(Schema.String.annotate({ description: "rename: new canvas name." })),
  asset: optionalParam(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description:
        "put-asset: {id, mimeType, url (data: URL), width?, height?}; image fills reference it by assetId.",
    }),
  ),
});

const CanvasApplyTool = Tool.make("canvas_apply", {
  description: [
    "Edit a canvas with an atomic batch of ops; the user sees it live. Returns the new revision and inserted ids keyed by ref.",
    NODE_MODEL,
    "Example: [{op:'insert',ref:'card',node:{type:'frame',x:40,y:40,width:320,height:200,fills:[{type:'solid',color:'#ffffff'}],cornerRadius:16,shadows:[{x:0,y:8,blur:24,spread:0,color:'#0000001f'}],layout:{direction:'column',gap:8,padding:[24,24,24,24]}}},{op:'insert',node:{type:'text',parentId:'card',text:{content:'Hello',fontSize:24,fontWeight:600,color:'#111111'}}}]",
  ].join("\n"),
  parameters: Schema.Struct({
    documentId: DocumentIdParam,
    ops: Schema.Array(CanvasApplyOp).check(Schema.isMaxLength(2000)),
  }),
  success: Schema.Struct({
    revision: NonNegativeInt,
    insertedIds: Schema.Array(CanvasNodeId),
    refs: Schema.Record(Schema.String, CanvasNodeId),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Edit canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CanvasScreenshotTool = Tool.make("canvas_screenshot", {
  description:
    "Render a canvas or one node to PNG, longest side capped at 2048 px; screenshot a node for detail. Needs a client with the canvas open; on failure call canvas_open.",
  parameters: Schema.Struct({
    documentId: DocumentIdParam,
    nodeId: optionalParam(
      CanvasNodeId.annotate({
        description: "Only this node. Default whole canvas.",
      }),
    ),
    scale: optionalParam(
      Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 4 })).annotate({
        description: "Pixel scale. Default 1; lowered to stay within 2048 px.",
      }),
    ),
  }),
  success: Schema.Struct({
    documentId: CanvasDocumentId,
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: NonNegativeInt,
      height: NonNegativeInt,
    }),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasExportTool = Tool.make("canvas_export", {
  description:
    "Export a node or whole canvas as standalone HTML with Tailwind classes and CSS keyframe animations. Prefer a nodeId; whole canvases can be large.",
  parameters: Schema.Struct({
    documentId: DocumentIdParam,
    nodeId: optionalParam(CanvasNodeId.annotate({ description: "Node to export." })),
  }),
  success: Schema.Struct({ html: Schema.String, truncated: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Export canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasOpenTool = Tool.make("canvas_open", {
  description:
    "Show a canvas in this thread's Canvas panel. Omit documentId to just open the panel.",
  parameters: Schema.Struct({
    documentId: optionalParam(DocumentIdParam),
  }),
  success: Schema.Struct({}).annotate({ description: "The client opened the canvas." }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Open canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CanvasRenderTool = Tool.make("canvas_render", {
  description:
    "Show a frozen PNG snapshot of a canvas or node inline in this thread before your reply; later edits don't change it. Keeps shader fills. Needs the canvas open in a web or desktop client (canvas_open first). Longest side capped at 2048 px.",
  parameters: Schema.Struct({
    documentId: DocumentIdParam,
    nodeId: optionalParam(CanvasNodeId.annotate({ description: "Omit for the whole canvas." })),
    scale: optionalParam(
      Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 4 })).annotate({
        description: "Pixel scale. Default 1; lowered to stay within 2048 px.",
      }),
    ),
    title: optionalParam(
      Schema.String.check(Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH)).annotate({
        description: "Snapshot name. Default node or canvas name.",
      }),
    ),
  }),
  success: Schema.Struct({
    documentId: CanvasDocumentId,
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
    }),
  }),
  failure,
  dependencies: [...dependencies, HtmlRender.HtmlRender],
})
  .annotate(Tool.Title, "Show canvas snapshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Canvases belong to the calling thread's project, so only thread callers are offered these.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CanvasStandardToolkit = Toolkit.make(
  CanvasListTool,
  CanvasCreateTool,
  CanvasReadTool,
  CanvasApplyTool,
  CanvasExportTool,
  CanvasOpenTool,
  CanvasRenderTool,
);

export const CanvasScreenshotToolkit = Toolkit.make(CanvasScreenshotTool);

export type CanvasApplyOpInput = typeof CanvasApplyOp.Type;
