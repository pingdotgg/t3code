import { Schema } from "effect";

import { NonNegativeInt } from "./baseSchemas.ts";

export const PREVIEW_ACCESSIBILITY_MAX_NODES = 4_000;
export const PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS = 10_000;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Tristate = Schema.Literals(["true", "false", "mixed"]);

/**
 * One node of a streamed page's accessibility tree. Ids are namespaced per
 * capture session and never reused, so an id from a replaced document is stale.
 */
export interface PreviewAccessibilityNode {
  readonly id: string;
  readonly role: string;
  readonly name?: string;
  readonly description?: string;
  /** Omitted for password and other secret fields; see `protected`. */
  readonly value?: string;
  readonly url?: string;
  readonly level?: number;
  readonly checked?: "true" | "false" | "mixed";
  readonly pressed?: "true" | "false" | "mixed";
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly readonly?: boolean;
  readonly required?: boolean;
  readonly invalid?: boolean;
  readonly focused?: boolean;
  readonly editable?: boolean;
  readonly multiline?: boolean;
  readonly protected?: boolean;
  readonly children?: ReadonlyArray<PreviewAccessibilityNode>;
}

export const PreviewAccessibilityNode: Schema.Codec<PreviewAccessibilityNode> = Schema.Struct({
  id: Text(100),
  role: Text(100),
  name: Schema.optionalKey(Text(2_000)),
  description: Schema.optionalKey(Text(2_000)),
  value: Schema.optionalKey(Text(PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS)),
  url: Schema.optionalKey(Text(2_048)),
  level: Schema.optionalKey(NonNegativeInt),
  checked: Schema.optionalKey(Tristate),
  pressed: Schema.optionalKey(Tristate),
  expanded: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  readonly: Schema.optionalKey(Schema.Boolean),
  required: Schema.optionalKey(Schema.Boolean),
  invalid: Schema.optionalKey(Schema.Boolean),
  focused: Schema.optionalKey(Schema.Boolean),
  editable: Schema.optionalKey(Schema.Boolean),
  multiline: Schema.optionalKey(Schema.Boolean),
  protected: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<PreviewAccessibilityNode> => PreviewAccessibilityNode),
    ),
  ),
});

const countNodes = (root: PreviewAccessibilityNode) => {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++count > PREVIEW_ACCESSIBILITY_MAX_NODES) return count;
    if (node.children) stack.push(...node.children);
  }
  return count;
};

/** A full replacement of the semantic page; viewers never patch an older one. */
export const PreviewAccessibilityDocument = Schema.Struct({
  /** Changes whenever the top-level document or the capture session is replaced. */
  document: Text(200),
  version: NonNegativeInt,
  truncated: Schema.Boolean,
  root: PreviewAccessibilityNode,
}).check(
  Schema.makeFilter((value: { readonly root: PreviewAccessibilityNode }) =>
    countNodes(value.root) > PREVIEW_ACCESSIBILITY_MAX_NODES
      ? `Accessibility documents must not exceed ${PREVIEW_ACCESSIBILITY_MAX_NODES} nodes.`
      : undefined,
  ),
);
export type PreviewAccessibilityDocument = typeof PreviewAccessibilityDocument.Type;

/** Read-only viewers may subscribe; it never changes page state. */
export const PreviewAccessibilitySubscription = Schema.Struct({
  type: Schema.Literal("accessibility"),
  enabled: Schema.Boolean,
});
export type PreviewAccessibilitySubscription = typeof PreviewAccessibilitySubscription.Type;

export const PreviewAccessibilityActionKind = Schema.Literals(["activate", "setValue"]);
export type PreviewAccessibilityActionKind = typeof PreviewAccessibilityActionKind.Type;

/** Page mutation: only the controlling viewer's actions run, against the current document. */
export const PreviewAccessibilityAction = Schema.Struct({
  type: Schema.Literal("accessibilityAction"),
  document: Text(200),
  node: Text(100),
  action: PreviewAccessibilityActionKind,
  value: Schema.optionalKey(Text(PREVIEW_ACCESSIBILITY_VALUE_MAX_CHARS)),
  /** After `setValue`, press Enter in the field. */
  submit: Schema.optionalKey(Schema.Boolean),
});
export type PreviewAccessibilityAction = typeof PreviewAccessibilityAction.Type;
