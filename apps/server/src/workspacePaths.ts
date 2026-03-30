import fs from "node:fs/promises";

import { type WorkspaceAvailabilityState } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

const WORKSPACE_PATH_CACHE_TTL_MS = 1_000;

type CachedWorkspacePathState = {
  readonly expiresAt: number;
  readonly state: WorkspaceAvailabilityState;
};

const workspacePathStateCache = new Map<string, CachedWorkspacePathState>();

export class WorkspacePathError extends Schema.TaggedErrorClass<WorkspacePathError>()(
  "WorkspacePathError",
  {
    operation: Schema.String,
    path: Schema.String,
    state: Schema.Literals(["missing", "not_directory", "inaccessible"]),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    switch (this.state) {
      case "missing":
        return `Workspace folder is missing: ${this.path}`;
      case "not_directory":
        return `Workspace path is not a folder: ${this.path}`;
      case "inaccessible":
      default:
        return `Workspace folder is inaccessible: ${this.path}`;
    }
  }
}

export function clearWorkspacePathStateCache(path?: string): void {
  if (path) {
    workspacePathStateCache.delete(path);
    return;
  }
  workspacePathStateCache.clear();
}

export async function inspectWorkspacePathState(path: string): Promise<WorkspaceAvailabilityState> {
  const cached = workspacePathStateCache.get(path);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.state;
  }

  let state: WorkspaceAvailabilityState;
  try {
    const stat = await fs.stat(path);
    state = stat.isDirectory() ? "available" : "not_directory";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    state = code === "ENOENT" ? "missing" : "inaccessible";
  }

  workspacePathStateCache.set(path, {
    expiresAt: now + WORKSPACE_PATH_CACHE_TTL_MS,
    state,
  });
  return state;
}

export const getWorkspacePathState = (path: string) =>
  Effect.promise(() => inspectWorkspacePathState(path));

export const assertWorkspaceDirectory = (path: string, operation: string) =>
  getWorkspacePathState(path).pipe(
    Effect.flatMap((state) =>
      state === "available"
        ? Effect.succeed(path)
        : Effect.fail(
            new WorkspacePathError({
              operation,
              path,
              state,
            }),
          ),
    ),
  );

export function resolveWorkspaceUnavailableReason(
  state: WorkspaceAvailabilityState,
): string | null {
  switch (state) {
    case "missing":
      return "Workspace folder is missing.";
    case "not_directory":
      return "Workspace path is not a folder.";
    case "inaccessible":
      return "Workspace folder is inaccessible.";
    case "available":
    default:
      return null;
  }
}
