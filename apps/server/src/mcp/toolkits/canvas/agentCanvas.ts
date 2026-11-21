/**
 * Agent-facing shapes for the canvas toolkit: lenient op specs in, compact
 * tree text out. Pure functions so they stay cheap and easy to test.
 */
import {
  CanvasAsset,
  CanvasNode,
  type CanvasDocument,
  type CanvasOp,
  type CanvasPaint,
} from "@t3tools/contracts";
import { makeCanvasNodeId } from "@t3tools/shared/canvasOps";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CanvasApplyOpInput } from "./tools.ts";

const decodeNode = Schema.decodeUnknownResult(CanvasNode);
const decodeAsset = Schema.decodeUnknownResult(CanvasAsset);

const firstLine = (message: string) => message.split("\n").slice(0, 6).join(" ").slice(0, 400);

type ResolvedAgentOps =
  | {
      readonly ok: true;
      readonly ops: ReadonlyArray<CanvasOp>;
      readonly insertedIds: ReadonlyArray<string>;
      readonly refs: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Fills defaults on agent node specs and resolves batch-local refs to ids.
 * A ref may be used wherever an id is expected in a later op.
 */
export function resolveAgentOps(
  input: ReadonlyArray<CanvasApplyOpInput>,
  makeId: () => string = makeCanvasNodeId,
): ResolvedAgentOps {
  const refs: Record<string, string> = {};
  const insertedIds: string[] = [];
  const ops: CanvasOp[] = [];
  const resolve = (value: string) => refs[value] ?? value;
  const fail = (index: number, reason: string): ResolvedAgentOps => ({
    ok: false,
    reason: `op ${index} (${input[index]?.op}): ${reason}`,
  });

  for (const [index, op] of input.entries()) {
    switch (op.op) {
      case "insert": {
        if (!op.node) return fail(index, "node is required");
        const spec = op.node;
        const id = typeof spec.id === "string" && spec.id.length > 0 ? spec.id : makeId();
        const parent = spec.parentId === undefined ? op.parentId : spec.parentId;
        const parentId = typeof parent === "string" ? resolve(parent) : null;
        const text =
          typeof spec.text === "object" && spec.text !== null
            ? {
                fontSize: 16,
                color: "#000000",
                content: "",
                sizing:
                  spec.width === undefined
                    ? "auto-width"
                    : spec.height === undefined
                      ? "auto-height"
                      : "fixed",
                ...spec.text,
              }
            : spec.text;
        const { childIds: _childIds, ...rest } = spec;
        const decoded = decodeNode({
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          ...rest,
          ...(text === undefined ? {} : { text }),
          id,
          parentId,
        });
        if (Result.isFailure(decoded)) return fail(index, firstLine(decoded.failure.message));
        if (op.ref != null) {
          if (refs[op.ref] !== undefined) return fail(index, `ref "${op.ref}" is already used`);
          refs[op.ref] = id;
        }
        insertedIds.push(id);
        ops.push({
          op: "insert",
          node: decoded.success,
          ...(op.index == null ? {} : { index: op.index }),
        });
        break;
      }
      case "update":
        if (!op.id) return fail(index, "id is required");
        if (!op.patch) return fail(index, "patch is required");
        ops.push({ op: "update", id: resolve(op.id), patch: op.patch });
        break;
      case "delete":
        if (!op.id) return fail(index, "id is required");
        ops.push({ op: "delete", id: resolve(op.id) });
        break;
      case "move":
        if (!op.id) return fail(index, "id is required");
        ops.push({
          op: "move",
          id: resolve(op.id),
          parentId: op.parentId == null ? null : resolve(op.parentId),
          ...(op.index == null ? {} : { index: op.index }),
        });
        break;
      case "rename":
        if (op.name == null) return fail(index, "name is required");
        ops.push({ op: "rename", name: op.name });
        break;
      case "put-asset": {
        const decoded = decodeAsset(op.asset);
        if (Result.isFailure(decoded)) return fail(index, firstLine(decoded.failure.message));
        ops.push({ op: "put-asset", asset: decoded.success });
        break;
      }
    }
  }
  return { ok: true, ops, insertedIds, refs };
}

const num = (value: number) => String(Math.round(value * 100) / 100);

const paint = (fill: CanvasPaint): string => {
  switch (fill.type) {
    case "solid":
      return fill.color;
    case "linear-gradient":
      return `linear(${num(fill.angle)}deg ${fill.stops.map((stop) => stop.color).join(">")})`;
    case "radial-gradient":
      return `radial(${fill.stops.map((stop) => stop.color).join(">")})`;
    case "image":
      return `image(${fill.assetId} ${fill.fit})`;
    case "shader":
      return "shader(glsl)";
  }
};

const quote = (value: string, max: number) =>
  JSON.stringify(value.length > max ? `${value.slice(0, max)}…` : value);

/** One line per node: identity, geometry, then only the styles that are set. */
function describeCanvasNode(node: CanvasNode): string {
  const parts = [
    node.id,
    node.type,
    ...(node.name ? [quote(node.name, 40)] : []),
    `${num(node.x)},${num(node.y)}`,
    `${num(node.width)}x${num(node.height)}`,
  ];
  if (node.rotation) parts.push(`rot=${num(node.rotation)}`);
  if (node.opacity !== undefined && node.opacity !== 1) parts.push(`opacity=${num(node.opacity)}`);
  if (node.visible === false) parts.push("hidden");
  if (node.fills?.length) parts.push(`fill=${node.fills.map(paint).join(",")}`);
  if (node.strokes?.length) {
    parts.push(`stroke=${node.strokes.map((s) => `${num(s.width)}px ${s.color}`).join(",")}`);
  }
  if (node.cornerRadius !== undefined && node.cornerRadius !== 0) {
    parts.push(
      `radius=${typeof node.cornerRadius === "number" ? num(node.cornerRadius) : node.cornerRadius.map(num).join("/")}`,
    );
  }
  if (node.shadows?.length) {
    const [first] = node.shadows;
    parts.push(
      `shadow=${first!.inset ? "inset " : ""}${[first!.x, first!.y, first!.blur, first!.spread].map(num).join(",")} ${first!.color}${node.shadows.length > 1 ? ` +${node.shadows.length - 1}` : ""}`,
    );
  }
  if (node.layerBlur) parts.push(`blur=${num(node.layerBlur)}`);
  if (node.backgroundBlur) parts.push(`bgblur=${num(node.backgroundBlur)}`);
  if (node.clipContent) parts.push("clip");
  if (node.layout) {
    const layout = node.layout;
    parts.push(
      [
        `layout=${layout.direction}`,
        ...(layout.gap ? [`gap=${num(layout.gap)}`] : []),
        ...(layout.padding ? [`pad=${layout.padding.map(num).join(",")}`] : []),
        ...(layout.align ? [`align=${layout.align}`] : []),
        ...(layout.justify ? [`justify=${layout.justify}`] : []),
        ...(layout.wrap ? ["wrap"] : []),
      ].join(" "),
    );
  }
  if (node.text) {
    const text = node.text;
    parts.push(
      `text=${quote(text.content, 80)} ${num(text.fontSize)}px${text.fontWeight ? `/${text.fontWeight}` : ""} ${text.color}${text.fontFamily ? ` ${quote(text.fontFamily, 30)}` : ""}`,
    );
  }
  if (node.animations?.length) {
    parts.push(`anim=${node.animations.map((animation) => animation.property).join(",")}`);
  }
  if (node.className) parts.push(`class=${quote(node.className, 80)}`);
  return parts.join(" ");
}

/** Indented tree text for `canvas_read`, bounded by depth and line count. */
export function formatCanvasTree(
  document: CanvasDocument,
  options: { readonly rootId?: string; readonly depth?: number; readonly maxNodes: number },
): { readonly tree: string; readonly truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const maxDepth = options.depth ?? Number.POSITIVE_INFINITY;
  const visit = (id: string, depth: number) => {
    const node = document.nodes[id];
    if (!node) return;
    if (lines.length >= options.maxNodes) {
      truncated = true;
      return;
    }
    const childIds = node.childIds ?? [];
    const hidden =
      depth >= maxDepth && childIds.length > 0 ? ` (+${childIds.length} children)` : "";
    lines.push(`${"  ".repeat(depth)}${describeCanvasNode(node)}${hidden}`);
    if (depth >= maxDepth) return;
    for (const childId of childIds) visit(childId, depth + 1);
  };
  for (const id of options.rootId === undefined ? document.rootIds : [options.rootId]) {
    visit(id, 0);
  }
  if (truncated)
    lines.push(`… truncated at ${options.maxNodes} nodes; pass rootId to read deeper.`);
  return { tree: lines.length > 0 ? lines.join("\n") : "(empty canvas)", truncated };
}
