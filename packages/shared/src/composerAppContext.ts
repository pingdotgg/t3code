import type { AppContextRecord, ComposerContextId } from "@t3tools/contracts";

/**
 * App mentions carry their identity in the reference itself: the label is the
 * app name and the context id encodes the bundle id reversibly. The composer
 * keeps no draft record for them, so a reference in persisted text, a paste,
 * or a stash restores the same record at send time.
 */

const APP_CONTEXT_ID_PREFIX = "app_";
const CONTEXT_ID_MAX_CHARS = 128;

/** `_` escapes everything a context id cannot hold: `.` → `_0`, `-` → `_1`, `X` → `_x`, `_` → `__`. */
export function appContextIdForBundleId(bundleId: string): ComposerContextId | undefined {
  let encoded = APP_CONTEXT_ID_PREFIX;
  for (const character of bundleId) {
    if (/[a-z0-9]/u.test(character)) encoded += character;
    else if (character === "_") encoded += "__";
    else if (character === ".") encoded += "_0";
    else if (character === "-") encoded += "_1";
    else if (/[A-Z]/u.test(character)) encoded += `_${character.toLowerCase()}`;
    else return undefined;
  }
  return encoded.length <= CONTEXT_ID_MAX_CHARS ? (encoded as ComposerContextId) : undefined;
}

export function bundleIdFromAppContextId(contextId: string): string | undefined {
  if (!contextId.startsWith(APP_CONTEXT_ID_PREFIX)) return undefined;
  const encoded = contextId.slice(APP_CONTEXT_ID_PREFIX.length);
  let bundleId = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index]!;
    if (character !== "_") {
      bundleId += character;
      continue;
    }
    const escaped = encoded[index + 1];
    index += 1;
    if (escaped === "_") bundleId += "_";
    else if (escaped === "0") bundleId += ".";
    else if (escaped === "1") bundleId += "-";
    else if (escaped !== undefined && /[a-z]/u.test(escaped)) bundleId += escaped.toUpperCase();
    else return undefined;
  }
  return bundleId.length > 0 ? bundleId : undefined;
}

export function isAppContextId(contextId: string): boolean {
  return contextId.startsWith(APP_CONTEXT_ID_PREFIX);
}

/** The wire record for one app reference; undefined when the id is not an app id. */
export function appContextRecordFromReference(reference: {
  readonly contextId: string;
  readonly label: string;
}): AppContextRecord | undefined {
  const bundleId = bundleIdFromAppContextId(reference.contextId);
  if (bundleId === undefined) return undefined;
  const name = reference.label.trim();
  if (name.length === 0) return undefined;
  return {
    version: 1,
    contextId: reference.contextId as ComposerContextId,
    kind: "app",
    label: name,
    name,
    bundleId,
  };
}
