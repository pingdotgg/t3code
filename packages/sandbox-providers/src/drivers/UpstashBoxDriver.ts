import { Box, type BoxConfig, type BoxGetOptions } from "@upstash/box";
import type { SandboxState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { toSandboxError } from "../errors.ts";
import { SandboxProvider } from "../SandboxProvider.ts";

export interface UpstashRunLike {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: string;
}

export interface UpstashBoxHandleLike {
  readonly id: string;
  readonly exec: {
    readonly command: (command: string) => Promise<UpstashRunLike>;
  };
  readonly snapshot: (options: { readonly name: string }) => Promise<{ readonly id: string }>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly getStatus: () => Promise<{ readonly status: string }>;
  readonly delete: () => Promise<void>;
  readonly getPublicURL: (port: number) => Promise<{ readonly url: string }>;
}

export interface UpstashBoxSdkLike {
  readonly create: (config?: BoxConfig) => Promise<UpstashBoxHandleLike>;
  readonly fromSnapshot: (snapshotId: string, config?: BoxConfig) => Promise<UpstashBoxHandleLike>;
  readonly get: (boxId: string, options?: BoxGetOptions) => Promise<UpstashBoxHandleLike>;
}

export interface UpstashBoxDriverOptions {
  readonly apiKey: Redacted.Redacted<string>;
  readonly sdk?: UpstashBoxSdkLike | undefined;
}

const defaultUpstashBoxSdk: UpstashBoxSdkLike = {
  create: (config) => Box.create(config) as unknown as Promise<UpstashBoxHandleLike>,
  fromSnapshot: (snapshotId, config) =>
    Box.fromSnapshot(snapshotId, config) as unknown as Promise<UpstashBoxHandleLike>,
  get: (boxId, options) => Box.get(boxId, options) as unknown as Promise<UpstashBoxHandleLike>,
};

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatShellCommand(input: {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly detached?: boolean | undefined;
}): string {
  const parts: string[] = [];
  if (input.env !== undefined) {
    for (const [key, value] of Object.entries(input.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        parts.push(`export ${key}=${shellSingleQuote(value)}`);
      }
    }
  }
  if (input.cwd !== undefined) {
    parts.push(`cd ${shellSingleQuote(input.cwd)}`);
  }
  if (input.detached) {
    parts.push(
      `nohup sh -lc ${shellSingleQuote(input.command)} >/tmp/kbcode-bg.log 2>&1 </dev/null &`,
    );
  } else {
    parts.push(input.command);
  }
  return parts.join(" && ");
}

function normalizeUpstashStatus(status: string): SandboxState {
  switch (status.toLowerCase()) {
    case "creating":
      return "creating";
    case "idle":
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "deleted":
      return "stopped";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

export function makeUpstashBoxDriver(options: UpstashBoxDriverOptions): SandboxProvider["Service"] {
  const sdk = options.sdk ?? defaultUpstashBoxSdk;
  const apiKey = Redacted.value(options.apiKey);

  return SandboxProvider.of({
    kind: "upstash-box",

    create: Effect.fn("UpstashBoxDriver.create")(function* (input) {
      const config: BoxConfig = {
        apiKey,
        name: input.name,
        runtime: "node",
        size: "small",
        keepAlive: false,
        ...(input.env !== undefined ? { env: { ...input.env } } : {}),
        ...(input.gitToken !== undefined ? { git: { token: input.gitToken } } : {}),
      };

      const box = yield* Effect.tryPromise({
        try: () =>
          input.snapshotId !== undefined
            ? sdk.fromSnapshot(input.snapshotId, config)
            : sdk.create(config),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "create",
            cause,
          }),
      });

      const publicUrl = yield* Effect.tryPromise({
        try: () => box.getPublicURL(input.port),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "getPublicUrl",
            sandboxId: box.id,
            cause,
          }),
      }).pipe(
        Effect.map((result) => result.url),
        Effect.orElseSucceed(() => undefined),
      );

      return {
        providerSandboxId: box.id,
        state: "running" as const,
        ...(publicUrl !== undefined ? { connectionUrl: publicUrl } : {}),
        ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
      };
    }),

    exec: Effect.fn("UpstashBoxDriver.exec")(function* (input) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(input.providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "exec",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      const command = formatShellCommand(input);
      const run = yield* Effect.tryPromise({
        try: () => box.exec.command(command),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "exec",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      return {
        exitCode: run.exitCode ?? 0,
        stdout: run.stdout || run.result || "",
        stderr: run.stderr || "",
      };
    }),

    snapshot: Effect.fn("UpstashBoxDriver.snapshot")(function* (input) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(input.providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "snapshot",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      const snap = yield* Effect.tryPromise({
        try: () => box.snapshot({ name: input.name }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "snapshot",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });

      return {
        snapshotId: snap.id,
        stoppedAfterSnapshot: false,
      };
    }),

    pauseOrStop: Effect.fn("UpstashBoxDriver.pauseOrStop")(function* (providerSandboxId) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "pauseOrStop",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      yield* Effect.tryPromise({
        try: () => box.pause(),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "pauseOrStop",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      return { state: "paused" as const };
    }),

    resume: Effect.fn("UpstashBoxDriver.resume")(function* (providerSandboxId, options) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "resume",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      yield* Effect.tryPromise({
        try: () => box.resume(),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "resume",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const publicUrl =
        options?.port !== undefined
          ? yield* Effect.tryPromise({
              try: () => box.getPublicURL(options.port!),
              catch: (cause) =>
                toSandboxError({
                  provider: "upstash-box",
                  operation: "getPublicUrl",
                  sandboxId: providerSandboxId,
                  cause,
                }),
            }).pipe(
              Effect.map((result) => result.url),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;

      return {
        providerSandboxId,
        state: "running" as const,
        ...(publicUrl !== undefined ? { connectionUrl: publicUrl } : {}),
      };
    }),

    getStatus: Effect.fn("UpstashBoxDriver.getStatus")(function* (providerSandboxId) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "getStatus",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const { status } = yield* Effect.tryPromise({
        try: () => box.getStatus(),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "getStatus",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      return {
        providerSandboxId,
        state: normalizeUpstashStatus(status),
      };
    }),

    destroy: Effect.fn("UpstashBoxDriver.destroy")(function* (providerSandboxId) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "destroy",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      yield* Effect.tryPromise({
        try: () => box.delete(),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "destroy",
            sandboxId: providerSandboxId,
            cause,
          }),
      });
    }),

    getPublicUrl: Effect.fn("UpstashBoxDriver.getPublicUrl")(function* (providerSandboxId, port) {
      const box = yield* Effect.tryPromise({
        try: () => sdk.get(providerSandboxId, { apiKey }),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "getPublicUrl",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const pub = yield* Effect.tryPromise({
        try: () => box.getPublicURL(port),
        catch: (cause) =>
          toSandboxError({
            provider: "upstash-box",
            operation: "getPublicUrl",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      return pub.url;
    }),
  });
}
