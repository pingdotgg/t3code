import { mobileSourceMapKey, type MobilePlatform } from "@t3tools/shared/mobileSourceMaps";

import { stripBundlePaths, symbolicateStack, type CompactSourceMap } from "./sourceMap.ts";

/** The JS bundle a record came from, read from its OTLP resource. */
interface BundleIdentity {
  readonly platform: MobilePlatform;
  /** Observe reports one only for an OTA launch. */
  readonly updateId: string | undefined;
  readonly easBuildId: string | undefined;
}

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * The map for the bundle that threw. A build map never stands in for a
 * missing OTA map: its offsets belong to a different bundle.
 */
export function bundleSourceMapKey(identity: BundleIdentity): string | undefined {
  if (identity.updateId !== undefined) {
    return BUNDLE_ID_PATTERN.test(identity.updateId)
      ? mobileSourceMapKey(identity.platform, "ota", identity.updateId)
      : undefined;
  }
  if (identity.easBuildId !== undefined && BUNDLE_ID_PATTERN.test(identity.easBuildId)) {
    return mobileSourceMapKey(identity.platform, "build", identity.easBuildId);
  }
  return undefined;
}

interface JsException {
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

/** JavaScript exception records with a stack; native crash frames are not in the bundle. */
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

const stringValue = (key: string, value: string) => ({ key, value: { stringValue: value } });

const setAttribute = (attributes: Array<unknown>, key: string, value: string) => {
  const index = attributes.findIndex((attribute) => isRecord(attribute) && attribute.key === key);
  if (index === -1) attributes.push(stringValue(key, value));
  else attributes[index] = stringValue(key, value);
};

/** Why a stack stayed minified, recorded as `relay.symbolication.status`. */
export type SourceMapMiss =
  /** A development or local build: no update or EAS build to name a map. */
  | "no_bundle_id"
  | "source_map_missing"
  | "source_map_too_large"
  | "source_map_invalid"
  /** The bucket could not be read; retried shortly. */
  | "source_map_unavailable"
  /** The request named more bundles than the relay decodes for one request. */
  | "source_map_limit";

/**
 * Rewrites one exception's stack, growing it by at most `maxGrowth`, and
 * records the outcome on the record so a stack still minified in Axiom
 * explains itself.
 */
export function applySymbolication(
  exception: JsException,
  found: { readonly key: string; readonly map: CompactSourceMap } | SourceMapMiss,
  maxGrowth: number,
): { readonly symbolicated: boolean; readonly growth: number } {
  const stack = stripBundlePaths(exception.stack);
  if (stack !== exception.stack) setAttribute(exception.attributes, "exception.stacktrace", stack);
  if (typeof found === "string") {
    setAttribute(exception.attributes, "relay.symbolication.status", found);
    return { symbolicated: false, growth: 0 };
  }
  const result = symbolicateStack(stack, found.map, maxGrowth);
  setAttribute(exception.attributes, "relay.symbolication.source_map", found.key);
  if (result.mappedFrames === 0) {
    setAttribute(exception.attributes, "relay.symbolication.status", "no_bundle_frames");
    return { symbolicated: false, growth: 0 };
  }
  setAttribute(exception.attributes, "relay.symbolication.status", "symbolicated");
  setAttribute(exception.attributes, "relay.symbolication.raw_stacktrace", stack);
  setAttribute(exception.attributes, "exception.stacktrace", result.stack);
  return { symbolicated: true, growth: result.growth };
}

const isFatal = (attributes: ReadonlyArray<unknown>) =>
  attributes.some(
    (attribute) =>
      isRecord(attribute) &&
      attribute.key === "expo.error.is_fatal" &&
      isRecord(attribute.value) &&
      attribute.value.boolValue === true,
  );

/**
 * A fatal JS error ends in a native abort, which Observe reports as a second crash with the
 * same generic stack in the same session. Marks those `relay.crash.js_fatal` so they don't
 * bury real native crashes. Both arrive together on the next launch.
 */
export function markJsFatalCrashes(payload: unknown): number {
  const records: Array<Array<unknown>> = [];
  const fatalSessions = new Set<string>();
  for (const resourceLogs of arrayAt(payload, "resourceLogs") ?? []) {
    for (const scopeLogs of arrayAt(resourceLogs, "scopeLogs") ?? []) {
      for (const logRecord of arrayAt(scopeLogs, "logRecords") ?? []) {
        const attributes = arrayAt(logRecord, "attributes");
        if (!attributes || !isFatal(attributes)) continue;
        const session = stringAttribute(attributes, "session.id");
        if (session === undefined) continue;
        if (stringAttribute(attributes, "expo.error.source") === "nativeCrash") {
          records.push(attributes);
        } else {
          fatalSessions.add(session);
        }
      }
    }
  }
  let marked = 0;
  for (const attributes of records) {
    if (!fatalSessions.has(stringAttribute(attributes, "session.id")!)) continue;
    attributes.push({ key: "relay.crash.js_fatal", value: { boolValue: true } });
    marked += 1;
  }
  return marked;
}
