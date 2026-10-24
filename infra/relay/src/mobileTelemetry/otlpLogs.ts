/**
 * Finds and rewrites JavaScript exception stacks in the OTLP/JSON log
 * payloads `expo-observe` sends. Each record keeps its `exception.*`
 * attributes; a symbolicated record carries the original stack in
 * `relay.symbolication.raw_stacktrace`.
 */
import { symbolicateStack, type CompactSourceMap } from "./sourceMap.ts";

export type MobilePlatform = "ios" | "android";

/** The JS bundle a record came from, read from its OTLP resource. */
export interface BundleIdentity {
  readonly platform: MobilePlatform;
  /** The running update; embedded launches report the embedded bundle's id. */
  readonly updateId: string | undefined;
  /** Set on binaries built by EAS Build. */
  readonly easBuildId: string | undefined;
}

export type SourceMapKind = "ota" | "build";

/** Update and build ids are UUIDs; anything else never names a stored map. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

/** The R2 key a map is stored under. Uploads use the same layout. */
export const sourceMapKey = (platform: MobilePlatform, kind: SourceMapKind, id: string) =>
  `${platform}/${kind}/${id}.map`;

/**
 * The key of the map for the bundle that threw. Observe reports an update id
 * only for an OTA launch, so its map is the update's; without one the app ran
 * the binary's embedded bundle, whose map is the build's. The build map never
 * stands in for a missing OTA map: its offsets belong to a different bundle.
 */
export function bundleSourceMapKey(identity: BundleIdentity): string | undefined {
  if (identity.updateId !== undefined) {
    return BUNDLE_ID_PATTERN.test(identity.updateId)
      ? sourceMapKey(identity.platform, "ota", identity.updateId)
      : undefined;
  }
  if (identity.easBuildId !== undefined && BUNDLE_ID_PATTERN.test(identity.easBuildId)) {
    return sourceMapKey(identity.platform, "build", identity.easBuildId);
  }
  return undefined;
}

export interface JsException {
  readonly identity: BundleIdentity;
  readonly stack: string;
  /** The record's attribute list, updated in place by `applySymbolication`. */
  readonly attributes: Array<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const arrayAt = (value: unknown, key: string): Array<unknown> | undefined => {
  const child = isRecord(value) ? value[key] : undefined;
  return Array.isArray(child) ? child : undefined;
};

const stringAttribute = (attributes: ReadonlyArray<unknown>, key: string): string | undefined => {
  for (const attribute of attributes) {
    if (!isRecord(attribute) || attribute.key !== key) continue;
    const value = isRecord(attribute.value) ? attribute.value.stringValue : undefined;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

const platformOf = (attributes: ReadonlyArray<unknown>): MobilePlatform | undefined => {
  const osType = stringAttribute(attributes, "os.type");
  if (osType === "darwin") return "ios";
  if (osType === "linux") return "android";
  return undefined;
};

/**
 * JavaScript exception records with a stack, from a decoded OTLP/JSON logs
 * request. Native crashes are skipped: their frames are not in the bundle.
 */
export function collectJsExceptions(payload: unknown): ReadonlyArray<JsException> {
  const exceptions: Array<JsException> = [];
  for (const resourceLogs of arrayAt(payload, "resourceLogs") ?? []) {
    const resourceAttributes =
      arrayAt(isRecord(resourceLogs) ? resourceLogs.resource : undefined, "attributes") ?? [];
    const platform = platformOf(resourceAttributes);
    if (platform === undefined) continue;
    const identity: BundleIdentity = {
      platform,
      updateId:
        stringAttribute(resourceAttributes, "expo.app.updates.id") ??
        stringAttribute(resourceAttributes, "expo.app.update_id"),
      easBuildId: stringAttribute(resourceAttributes, "expo.eas_build.id"),
    };
    for (const scopeLogs of arrayAt(resourceLogs, "scopeLogs") ?? []) {
      for (const logRecord of arrayAt(scopeLogs, "logRecords") ?? []) {
        const attributes = arrayAt(logRecord, "attributes");
        if (!attributes) continue;
        const stack = stringAttribute(attributes, "exception.stacktrace");
        if (stack === undefined) continue;
        if (stringAttribute(attributes, "expo.error.source") === "nativeCrash") continue;
        exceptions.push({ identity, stack, attributes });
      }
    }
  }
  return exceptions;
}

export type SymbolicationStatus = "symbolicated" | "no_bundle_frames" | "source_map_missing";

export interface SymbolicationOutcome {
  readonly status: SymbolicationStatus;
  readonly mappedFrames: number;
  /** How much longer the stack got. */
  readonly growth: number;
}

const stringValue = (key: string, value: string) => ({ key, value: { stringValue: value } });

const setAttribute = (attributes: Array<unknown>, key: string, value: string) => {
  const index = attributes.findIndex((attribute) => isRecord(attribute) && attribute.key === key);
  if (index === -1) attributes.push(stringValue(key, value));
  else attributes[index] = stringValue(key, value);
};

/**
 * Rewrites one exception's stack with the map found for it, growing it by at
 * most `maxGrowth`, and records how that went on the record so a stack still
 * minified in Axiom explains itself.
 */
export function applySymbolication(
  exception: JsException,
  found: { readonly key: string; readonly map: CompactSourceMap } | undefined,
  maxGrowth: number,
): SymbolicationOutcome {
  if (!found) {
    setAttribute(exception.attributes, "relay.symbolication.status", "source_map_missing");
    return { status: "source_map_missing", mappedFrames: 0, growth: 0 };
  }
  const result = symbolicateStack(exception.stack, found.map, maxGrowth);
  setAttribute(exception.attributes, "relay.symbolication.source_map", found.key);
  if (result.mappedFrames === 0) {
    setAttribute(exception.attributes, "relay.symbolication.status", "no_bundle_frames");
    return { status: "no_bundle_frames", mappedFrames: 0, growth: 0 };
  }
  setAttribute(exception.attributes, "relay.symbolication.status", "symbolicated");
  setAttribute(exception.attributes, "relay.symbolication.raw_stacktrace", exception.stack);
  setAttribute(exception.attributes, "exception.stacktrace", result.stack);
  return { status: "symbolicated", mappedFrames: result.mappedFrames, growth: result.growth };
}
