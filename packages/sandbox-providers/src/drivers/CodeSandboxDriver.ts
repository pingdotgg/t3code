import { CodeSandbox, VMTier } from "@codesandbox/sdk";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { toSandboxError } from "../errors.ts";
import { SandboxProvider } from "../SandboxProvider.ts";

function isCommandFailure(
  error: unknown,
): error is { readonly exitCode: number; readonly output: string } {
  return (
    Predicate.isObject(error) &&
    typeof (error as { readonly exitCode?: unknown }).exitCode === "number" &&
    typeof (error as { readonly output?: unknown }).output === "string"
  );
}

export interface CodeSandboxSessionLike {
  readonly keepActiveWhileConnected: (enabled: boolean) => void;
  readonly commands: {
    readonly run: (
      command: string,
      opts?: { readonly cwd?: string; readonly env?: Record<string, string> },
    ) => Promise<string>;
    readonly runBackground: (
      command: string,
      opts?: { readonly cwd?: string; readonly env?: Record<string, string> },
    ) => Promise<unknown>;
  };
  readonly hosts: {
    readonly getUrl: (port: number, protocol?: string) => string;
  };
  readonly disconnect: () => Promise<void>;
  readonly dispose: () => void;
}

export interface CodeSandboxHandleLike {
  readonly id: string;
  readonly connect: (opts?: {
    readonly env?: Record<string, string>;
  }) => Promise<CodeSandboxSessionLike>;
}

export interface CodeSandboxSdkLike {
  readonly sandboxes: {
    readonly create: (opts?: {
      readonly id?: string;
      readonly title?: string;
      readonly privacy?: "public" | "unlisted" | "private" | "public-hosts";
      readonly vmTier?: VMTier;
      readonly hibernationTimeoutSeconds?: number;
      readonly automaticWakeupConfig?: { readonly http: boolean; readonly websocket: boolean };
    }) => Promise<CodeSandboxHandleLike>;
    readonly resume: (sandboxId: string) => Promise<CodeSandboxHandleLike>;
    readonly hibernate: (sandboxId: string) => Promise<void>;
    readonly shutdown: (sandboxId: string) => Promise<void>;
    readonly delete: (sandboxId: string) => Promise<void>;
    readonly get: (sandboxId: string) => Promise<{ readonly id: string }>;
    readonly listRunning: () => Promise<{
      readonly vms: ReadonlyArray<{ readonly id: string | undefined }>;
    }>;
  };
}

export interface CodeSandboxDriverOptions {
  readonly apiKey: Redacted.Redacted<string>;
  readonly sdk?: CodeSandboxSdkLike | undefined;
}

function defaultCodeSandboxSdk(apiKey: Redacted.Redacted<string>): CodeSandboxSdkLike {
  return new CodeSandbox(Redacted.value(apiKey)) as unknown as CodeSandboxSdkLike;
}

export function makeCodeSandboxDriver(
  options: CodeSandboxDriverOptions,
): SandboxProvider["Service"] {
  const sdk = options.sdk ?? defaultCodeSandboxSdk(options.apiKey);

  const withConnectedHandle = <A>(
    operation: "exec" | "getPublicUrl",
    providerSandboxId: string,
    getHandle: () => Promise<CodeSandboxHandleLike>,
    run: (session: CodeSandboxSessionLike) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const sandbox = await getHandle();
        // Do not pass env into sandbox.connect(); @codesandbox/sdk appends connect({ env })
        // unescaped into $HOME/.private/.env on every connection.
        const session = await sandbox.connect();
        session.keepActiveWhileConnected(false);
        try {
          return await run(session);
        } finally {
          await session.disconnect().catch(() => undefined);
          session.dispose();
        }
      },
      catch: (cause) =>
        toSandboxError({
          provider: "codesandbox",
          operation,
          sandboxId: providerSandboxId,
          cause,
        }),
    });

  const withSession = <A>(
    operation: "exec" | "getPublicUrl",
    providerSandboxId: string,
    run: (session: CodeSandboxSessionLike) => Promise<A>,
  ) =>
    withConnectedHandle(
      operation,
      providerSandboxId,
      () => sdk.sandboxes.resume(providerSandboxId),
      run,
    );

  return SandboxProvider.of({
    kind: "codesandbox",

    create: Effect.fn("CodeSandboxDriver.create")(function* (input) {
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          sdk.sandboxes.create({
            ...(input.snapshotId !== undefined ? { id: input.snapshotId } : {}),
            title: input.name,
            // Keep sandbox code private while exposing preview ports (guarded by KBCode pairing/DPoP auth).
            privacy: "public-hosts",
            vmTier: VMTier.Nano,
            hibernationTimeoutSeconds: input.idleTimeoutMinutes * 60,
            automaticWakeupConfig: { http: true, websocket: true },
          }),
        catch: (cause) =>
          toSandboxError({
            provider: "codesandbox",
            operation: "create",
            cause,
          }),
      });

      const connectionUrl = yield* withConnectedHandle(
        "getPublicUrl",
        sandbox.id,
        async () => sandbox,
        async (session) => session.hosts.getUrl(input.port, "https"),
      ).pipe(Effect.orElseSucceed(() => undefined));

      return {
        providerSandboxId: sandbox.id,
        state: "running" as const,
        ...(connectionUrl !== undefined ? { connectionUrl } : {}),
        ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
      };
    }),

    exec: Effect.fn("CodeSandboxDriver.exec")(function* (input) {
      return yield* withSession("exec", input.providerSandboxId, async (session) => {
        const runOpts = {
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.env !== undefined ? { env: { ...input.env } } : {}),
        };
        if (input.detached) {
          await session.commands.runBackground(input.command, runOpts);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        try {
          const output = await session.commands.run(input.command, runOpts);
          return { exitCode: 0, stdout: output, stderr: "" };
        } catch (error) {
          if (isCommandFailure(error)) {
            return {
              exitCode: error.exitCode,
              stdout: "",
              stderr: error.output,
            };
          }
          throw error;
        }
      });
    }),

    snapshot: Effect.fn("CodeSandboxDriver.snapshot")(function* (input) {
      yield* Effect.tryPromise({
        try: () => sdk.sandboxes.hibernate(input.providerSandboxId),
        catch: (cause) =>
          toSandboxError({
            provider: "codesandbox",
            operation: "snapshot",
            sandboxId: input.providerSandboxId,
            cause,
          }),
      });
      // CodeSandbox hibernates memory+disk and forks future sandboxes directly from the sandbox ID.
      return {
        snapshotId: input.providerSandboxId,
        stoppedAfterSnapshot: true,
      };
    }),

    pauseOrStop: Effect.fn("CodeSandboxDriver.pauseOrStop")(function* (providerSandboxId) {
      yield* Effect.tryPromise({
        try: () => sdk.sandboxes.hibernate(providerSandboxId),
        catch: (cause) =>
          toSandboxError({
            provider: "codesandbox",
            operation: "pauseOrStop",
            sandboxId: providerSandboxId,
            cause,
          }),
      });
      return {
        state: "paused" as const,
        snapshotId: providerSandboxId,
      };
    }),

    resume: Effect.fn("CodeSandboxDriver.resume")(function* (providerSandboxId, options) {
      const sandbox = yield* Effect.tryPromise({
        try: () => sdk.sandboxes.resume(providerSandboxId),
        catch: (cause) =>
          toSandboxError({
            provider: "codesandbox",
            operation: "resume",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const connectionUrl =
        options?.port !== undefined
          ? yield* withConnectedHandle(
              "getPublicUrl",
              sandbox.id,
              async () => sandbox,
              async (session) => session.hosts.getUrl(options.port!, "https"),
            ).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;

      return {
        providerSandboxId: sandbox.id,
        state: "running" as const,
        ...(connectionUrl !== undefined ? { connectionUrl } : {}),
      };
    }),

    getStatus: Effect.fn("CodeSandboxDriver.getStatus")(function* (providerSandboxId) {
      const [, running] = yield* Effect.tryPromise({
        try: () => Promise.all([sdk.sandboxes.get(providerSandboxId), sdk.sandboxes.listRunning()]),
        catch: (cause) =>
          toSandboxError({
            provider: "codesandbox",
            operation: "getStatus",
            sandboxId: providerSandboxId,
            cause,
          }),
      });

      const isRunning = running.vms.some((vm) => vm.id === providerSandboxId);
      return {
        providerSandboxId,
        state: isRunning ? ("running" as const) : ("paused" as const),
      };
    }),

    destroy: Effect.fn("CodeSandboxDriver.destroy")(function* (providerSandboxId) {
      yield* Effect.tryPromise({
        try: () => sdk.sandboxes.delete(providerSandboxId),
        catch: (cause) =>
          toSandboxError({
            provider: "codesandbox",
            operation: "destroy",
            sandboxId: providerSandboxId,
            cause,
          }),
      });
    }),

    getPublicUrl: Effect.fn("CodeSandboxDriver.getPublicUrl")(function* (providerSandboxId, port) {
      return yield* withSession("getPublicUrl", providerSandboxId, async (session) =>
        session.hosts.getUrl(port, "https"),
      );
    }),
  });
}
