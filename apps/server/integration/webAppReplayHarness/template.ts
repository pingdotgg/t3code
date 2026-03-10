import type { ReplayRef, ReplayScopes } from "./types.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isReplayRef(value: unknown): value is ReplayRef {
  return isPlainRecord(value) && typeof value.$ref === "string";
}

export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry)) as T;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return Buffer.from(value) as T;
  }
  if (ArrayBuffer.isView(value)) {
    if ("slice" in value && typeof value.slice === "function") {
      return value.slice() as T;
    }
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    ) as T;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
  ) as T;
}

function readPath(source: unknown, pathExpression: string): unknown {
  const segments = pathExpression.split(".");
  let current: unknown = source;

  for (const segment of segments) {
    if (!segment) continue;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isPlainRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function readScopedPath(pathExpression: string, scopes: ReplayScopes): unknown {
  if (pathExpression.startsWith("state.")) {
    return readPath(scopes.state, pathExpression.slice("state.".length));
  }
  if (pathExpression.startsWith("request.")) {
    return readPath(scopes.request, pathExpression.slice("request.".length));
  }
  throw new Error(`Unsupported replay path '${pathExpression}'.`);
}

export function resolveTemplate(value: unknown, scopes: ReplayScopes): unknown {
  if (isReplayRef(value)) {
    return readScopedPath(value.$ref, scopes);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplate(entry, scopes));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveTemplate(entry, scopes)]),
  );
}

export function matchesPartial(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((entry, index) => matchesPartial(actual[index], entry));
  }
  if (isPlainRecord(expected)) {
    if (!isPlainRecord(actual)) {
      return false;
    }
    return Object.entries(expected).every(([key, value]) => matchesPartial(actual[key], value));
  }
  return Object.is(actual, expected);
}

export function readScopedTemplatePath(pathExpression: string, scopes: ReplayScopes): unknown {
  return readScopedPath(pathExpression, scopes);
}
