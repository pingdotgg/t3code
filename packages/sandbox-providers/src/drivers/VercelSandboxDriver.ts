import { Sandbox } from "@vercel/sandbox";
import type { SandboxState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { toSandboxError } from "../errors.ts";
import { SandboxProvider } from "../SandboxProvider.ts";

/** Vercel Hobby sandbox max execution lifetime is 45 minutes; warn at 40m and snapshot at 43m. */
export const VERCEL_HOBBY_WARNING_MINUTES = 40;
export const VERCEL_HOBBY_SNAPSHOT_MINUTES = 43;
export const VERCEL_HOBBY_CEILING_MINUTES = 45;

export interface VercelCommandFinishedLike {
  readonly exitCode: number;
  readonly stdout: () => Promise<string>;
  readonly stderr: () => Promise<string>;
}

export interface VercelSandboxHandleLike {
  readonly name: string;
  readonly status:
    | "pending"
    | "running"
    | "stopping"
    | "stopped"
    | "failed"
    | "aborted"
    | "snapshotting";
  readonly currentSnapshotId?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly runCommand: (params: {
    readonly cmd: string;
    readonly args?: string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly detached?: boolean;
  }) => Promise<VercelCommandFinishedLike | unknown>;
  readonly domain: (port: number) => string;
  readonly snapshot: (opts?: {
    readonly expiration?: number;
  }) => Promise<{ readonly snapshotId: string }>;
  readonly stop: () => Promise<{ readonly snapshot?: { readonly id: string } | undefined }>;
  readonly delete: (opts?: { readonly deleteOrphanSnapshots?: boolean }) => Promise<void>;
}

export interface VercelSandboxSdkLike {
  readonly create: (params: Record<string, unknown>) => Promise<VercelSandboxHandleLike>;
  readonly get: (params: Record<string, unknown>) => Promise<VercelSandboxHandleLike>;
}

export interface VercelSandboxDriverOptions {
  readonly token?: Redacted.Redacted<string> | undefined;
  readonly teamId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly sdk?: VercelSandboxSdkLike | undefined;
}

const defaultVercelSandboxSdk: VercelSandboxSdkLike = {
  create: (params) =>
    Sandbox.create(
      params as unknown as Parameters<typeof Sandbox.create>[0],
    ) as unknown as Promise<VercelSandboxHandleLike>,
  get: (params) =>
    Sandbox.get(
      params as unknown as Parameters<typeof Sandbox.get>[0],
    ) as unknown as Promise<VercelSandboxHandleLike>,
};

function normalizeVercelStatus(status: VercelSandboxHandleLike["status"]): SandboxState {
  switch (status) {
    case "pending":
      return "creating";
    case "running":
      return "running";
    case "snapshotting":
      return "snapshotting";
    case "stopping":
    case "stopped":
    case "aborted":
      return "paused";
    case "failed":
      return "error";
  }
}

function safeDomain(sandbox: VercelSandboxHandleLike, port: number): string | undefined {
  try {
    return sandbox.domain(port);
  } catch {
    return undefined;
  }
}

export function makeVercelSandboxDriver(
  options: VercelSandboxDriverOptions,
): SandboxProvider["Service"] {
  const sdk = options.sdk ?? defaultVercelSandboxSdk;
  const credentials: Record<string, unknown> =
    options.token !== undefined && options.teamId !== undefined && options.projectId !== undefined
      ? {
          token: Redacted.value(options.token),
          teamId: options.teamId,
          projectId: options.projectId,
        }
      : {};

  return SandboxProvider.of({
    kind: "vercel-sandbox",

    create: Effect.fn("VercelSandboxDriver.create")(function* (input) {
      const baseParams: Record<string, unknown> = {
        ...credentials,
        name: input.name,
        ports: [input.port],
        timeout: VERCEL_HOBBY_CEILING_MINUTES * 60_000,
        resources: { vcpus: 2 },
        persistent: true,
        ...(input.env !== undefined ? { env: { ...input.env } } : {}),
      };
      const params: Record<string, unknown> =
        input.snapshotId !== undefined
          ? {
              ...baseParams,
              source: { type: "snapshot", snapshotId: input.snapshotId },
            }
          : {
              ...baseParams,
              image: "vercel/sandbox/universal:latest",
            };

      const sandbox = yield* Effect.tryPromise({
        try: () => sdk.create(params),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "create",
            cause,
          }),
      });

      const connectionUrl = safeDomain(sandbox, input.port);
      return {
        providerSandboxId: sandbox.name,
        state: normalizeVercelStatus(sandbox.status),
        ...(connectionUrl !== undefined ? { connectionUrl } : {}),
        ...(sandbox.currentSnapshotId !== undefined
          ? { snapshotId: sandbox.currentSnapshotId }
          : input.snapshotId !== undefined
            ? { snapshotId: input.snapshotId }
            : {}),
      };
    }),

    exec: Effect.fn("VercelSandboxDriver.exec")(function* (input) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.get({
            ...credentials,
            name: input.providerSandboxId,
            resume: true,
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "exec",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      return yield* Effect.tryPromise({
        try: async () => {
          const result = await sandbox.runCommand({
            cmd: "sh",
            args: ["-lc", input.command],
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.env !== undefined ? { env: { ...input.env } } : {}),
            ...(input.detached ? { detached: true } : {}),
          });
          if (input.detached) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          const finished = result as VercelCommandFinishedLike;
          const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
          return { exitCode: finished.exitCode, stdout, stderr };
        },
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "exec",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });
    }),

    snapshot: Effect.fn("VercelSandboxDriver.snapshot")(function* (input) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.get({
            ...credentials,
            name: input.providerSandboxId,
            resume: false,
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "snapshot",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      const snap = yield* Effect.tryPromise({
        try: () => sandbox.snapshot(),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "snapshot",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      return {
        snapshotId: snap.snapshotId,
        stoppedAfterSnapshot: true,
      };
    }),

    pauseOrStop: Effect.fn("VercelSandboxDriver.pauseOrStop")(function* (providerSandboxId) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.get({
            ...credentials,
            name: providerSandboxId,
            resume: false,
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "pauseOrStop",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const stopped = yield* Effect.tryPromise({
        try: () => sandbox.stop(),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "pauseOrStop",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const snapshotId = stopped.snapshot?.id ?? sandbox.currentSnapshotId;
      return {
        state: "paused" as const,
        ...(snapshotId !== undefined ? { snapshotId } : {}),
      };
    }),

    resume: Effect.fn("VercelSandboxDriver.resume")(function* (providerSandboxId, options) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.get({
            ...credentials,
            name: providerSandboxId,
            resume: true,
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "resume",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const connectionUrl =
        options?.port !== undefined ? safeDomain(sandbox, options.port) : undefined;
      return {
        providerSandboxId: sandbox.name,
        state: "running" as const,
        ...(connectionUrl !== undefined ? { connectionUrl } : {}),
      };
    }),

    getStatus: Effect.fn("VercelSandboxDriver.getStatus")(function* (providerSandboxId) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.get({
            ...credentials,
            name: providerSandboxId,
            resume: false,
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "getStatus",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      return {
        providerSandboxId: sandbox.name,
        state: normalizeVercelStatus(sandbox.status),
        ...(sandbox.currentSnapshotId !== undefined
          ? { snapshotId: sandbox.currentSnapshotId }
          : {}),
        ...(sandbox.expiresAt !== undefined ? { expiresAt: sandbox.expiresAt.toISOString() } : {}),
      };
    }),

    destroy: Effect.fn("VercelSandboxDriver.destroy")(function* (providerSandboxId) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.get({
            ...credentials,
            name: providerSandboxId,
            resume: false,
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "destroy",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      yield* Effect.tryPromise({
        try: () => sandbox.delete({ deleteOrphanSnapshots: false }),
        catch: (cause) =>
          toSandboxError({
            provider: "vercel-sandbox",
            operation: "destroy",
            sandboxId: providerSandboxId,
            cause,
          }),
      });
    }),

    getPublicUrl: Effect.fn("VercelSandboxDriver.getPublicUrl")(
      function* (providerSandboxId, port) {
        const sandbox = yield* Effect.tryPromise({
          try: () =>
            sdk.get({
              ...credentials,
              name: providerSandboxId,
              resume: false,
            }),
          catch: (cause) =>
            toSandboxError({
              provider: "vercel-sandbox",
              operation: "getPublicUrl",
              sandboxId: providerSandboxId,
              cause,
            }),
        });
        return safeDomain(sandbox, port) ?? null;
      },
    ),
  });
}
