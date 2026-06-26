import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { cwd } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as Schema from "effect/Schema";

import type { WorkflowRuntime, WorkflowSdkRegistry } from "./t3work-sdk.types.ts";

const REGISTRY_SYMBOL = Symbol.for("@t3work/sdk/registry");
const CURRENT_MODULE_FILE = fileURLToPath(import.meta.url);
// `defineWorkflow` lives in the sibling dispatch module, so its frame sits between this
// file and the true caller. Skip it too — otherwise a relative workflow path resolves
// against the SDK rather than the file (or workflow body) that called `defineWorkflow`.
const DISPATCH_MODULE_FILE = CURRENT_MODULE_FILE.replace(/\.internal\.ts$/, ".ts");
const SDK_FRAME_FILES = new Set([CURRENT_MODULE_FILE, DISPATCH_MODULE_FILE]);
const nodeRequire = createRequire(import.meta.url);

type NodeFsModule = {
  readonly existsSync: (path: string) => boolean;
  readonly statSync: (path: string) => { readonly isFile: () => boolean };
};

export const runtimeStorage = new AsyncLocalStorage<WorkflowRuntime>();

export function getRegistry(): WorkflowSdkRegistry {
  const scope = globalThis as typeof globalThis & {
    [REGISTRY_SYMBOL]?: WorkflowSdkRegistry;
  };

  if (!scope[REGISTRY_SYMBOL]) {
    scope[REGISTRY_SYMBOL] = {
      toolGroups: new Map(),
      tools: new Map(),
      recipes: new Map(),
    };
  }

  return scope[REGISTRY_SYMBOL];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function decodeWithSchema<Value>(
  schema: Schema.Schema<Value>,
  input: unknown,
  message: string,
): Promise<Value> {
  try {
    return await (Schema.decodeUnknownPromise(schema as never)(input) as Promise<Value>);
  } catch (error) {
    throw new Error(`${message}: ${formatError(error)}`);
  }
}

export function duplicateRegistrationError(kind: string, id: string): Error {
  return new Error(`Duplicate ${kind} registration '${id}'. ${kind} ids must be globally unique.`);
}

function normalizeFilePath(fileName: string): string {
  return fileName.startsWith("file://") ? fileURLToPath(fileName) : fileName;
}

function findCallerFilePath(): string | undefined {
  const originalPrepareStackTrace = Error.prepareStackTrace;

  try {
    Error.prepareStackTrace = (_error, structuredStackTrace) => structuredStackTrace;
    const error = new Error();
    Error.captureStackTrace(error, findCallerFilePath);
    const stack = error.stack as unknown as ReadonlyArray<NodeJS.CallSite> | undefined;

    for (const callSite of stack ?? []) {
      const fileName = callSite.getFileName();
      if (!fileName) {
        continue;
      }

      const normalizedFileName = normalizeFilePath(fileName);
      if (!SDK_FRAME_FILES.has(normalizedFileName)) {
        return normalizedFileName;
      }
    }
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
  }

  return undefined;
}

function camelCaseSegment(segment: string): string {
  return segment.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function getNodeFs(): NodeFsModule {
  return nodeRequire("node:fs") as NodeFsModule;
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function setNestedValue(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").map(camelCaseSegment);
  let cursor = root;

  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }

    const nextValue = cursor[segment];
    if (typeof nextValue !== "object" || nextValue === null || Array.isArray(nextValue)) {
      const nextCursor: Record<string, unknown> = {};
      cursor[segment] = nextCursor;
      cursor = nextCursor;
      continue;
    }

    cursor = nextValue as Record<string, unknown>;
  }
}

export function resolveWorkflowAbsolutePath(displayPath: string): {
  readonly absolutePath: string;
  readonly callerFilePath?: string;
} {
  if (displayPath.startsWith("file://")) {
    return { absolutePath: fileURLToPath(displayPath) };
  }

  if (isAbsoluteFilePath(displayPath)) {
    return { absolutePath: displayPath };
  }

  const callerFilePath = findCallerFilePath();
  const baseUrl = callerFilePath
    ? new URL(".", pathToFileURL(callerFilePath))
    : pathToFileURL(`${cwd()}/`);
  return {
    absolutePath: fileURLToPath(new URL(displayPath, baseUrl)),
    ...(callerFilePath ? { callerFilePath } : {}),
  };
}

export function ensureWorkflowPathExists(
  displayPath: string,
  absolutePath: string,
  callerFilePath?: string,
): void {
  const fs = getNodeFs();

  if (!fs.existsSync(absolutePath)) {
    const from = callerFilePath ? ` from '${callerFilePath}'` : "";
    throw new Error(
      `Workflow '${displayPath}' does not resolve to an existing file${from}. Resolved '${absolutePath}'.`,
    );
  }

  if (!fs.statSync(absolutePath).isFile()) {
    throw new Error(
      `Workflow '${displayPath}' resolved to '${absolutePath}', but it is not a file.`,
    );
  }
}
