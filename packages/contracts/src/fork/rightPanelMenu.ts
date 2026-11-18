import * as Schema from "effect/Schema";

/**
 * Right-panel menu choices by item id. Values stay unknown here and are parsed where they are
 * read, so a wrong-typed entry is ignored instead of failing settings or config decoding.
 */
export const RightPanelMenuLayer = Schema.Record(Schema.String, Schema.Unknown);
export type RightPanelMenuLayer = typeof RightPanelMenuLayer.Type;

/**
 * This browser's menu choices as stored in client settings. Any stored value decodes, so a
 * malformed one can never fail the client settings; the web resolver reads it as a layer.
 */
export const RightPanelMenuOverrides = Schema.Unknown;

/** A board host: the machine's menu defaults, from the whiteboard's deploy-time config. */
export const WhiteboardPanelCapability = Schema.Struct({ menu: RightPanelMenuLayer });
export type WhiteboardPanelCapability = typeof WhiteboardPanelCapability.Type;

/** An absent field follows the layer below; `key: ""` means no letter. */
export interface RightPanelMenuChoice {
  readonly hidden?: boolean;
  readonly key?: string;
}

const MENU_KEY = /^[A-Za-z0-9]?$/;

/** Keeps the fields that parse and stores letters upper-case; undefined when not an object. */
export function parseRightPanelMenuChoice(value: unknown): RightPanelMenuChoice | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { hidden, key } = value as Record<string, unknown>;
  return {
    ...(typeof hidden === "boolean" ? { hidden } : {}),
    ...(typeof key === "string" && MENU_KEY.test(key) ? { key: key.toUpperCase() } : {}),
  };
}
