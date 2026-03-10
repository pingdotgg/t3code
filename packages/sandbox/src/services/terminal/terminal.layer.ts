import { randomUUID } from "node:crypto";
import type { PtyHandle, Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ManagedSandboxLookupError, SandboxService, type CreateSandboxOptions } from "../sandbox";
import { JEVIN_AI_SNAPSHOT_USER } from "../snapshot";
import {
  PtyConnectionError,
  PtyCreationError,
  PtyInputError,
  PtyResizeError,
  PtyWaitError,
  SandboxCreationError,
  SandboxLookupError,
  TerminalCleanupError,
  TerminalStartupCleanupError,
} from "./terminal.errors";
import type {
  OpenSandboxPtySessionOptions,
  PlaygroundSession,
  StartPlaygroundSessionOptions,
  TerminalServiceLayerOptions,
  TerminalServiceOptions,
  TerminalServiceShape,
} from "./terminal.service";
import { TerminalService } from "./terminal.service";

function createSandboxName(customName?: string): string {
  if (customName) {
    return customName;
  }

  return `jevin-playground-${Date.now()}`;
}

function createSessionEnvs(envs?: Record<string, string>): Record<string, string> {
  return {
    HOME: `/home/${JEVIN_AI_SNAPSHOT_USER}`,
    USER: JEVIN_AI_SNAPSHOT_USER,
    ZDOTDIR: `/home/${JEVIN_AI_SNAPSHOT_USER}`,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    ...(envs ?? {}),
  };
}

function createSessionCleanup(
  sandbox: Sandbox,
  activePty: () => PtyHandle | undefined,
  deleteSandboxOnCleanup: boolean,
  deleteSandbox: (sandbox: Sandbox) => Effect.Effect<void, TerminalCleanupError>,
): Effect.Effect<void, TerminalCleanupError> {
  let isCleanedUp = false;

  return Effect.suspend(() => {
    if (isCleanedUp) {
      return Effect.void;
    }

    isCleanedUp = true;
    const cleanupErrors: string[] = [];

    const disconnectPty = (() => {
      const pty = activePty();

      if (!pty) {
        return Effect.void;
      }

      return Effect.tryPromise({
        try: () => pty.disconnect(),
        catch: (cause) =>
          `Failed to disconnect PTY session ${pty.sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }).pipe(
        Effect.match({
          onFailure: (message) => {
            cleanupErrors.push(message);
          },
          onSuccess: () => undefined,
        }),
        Effect.asVoid,
      );
    })();

    const deleteSandboxEffect = deleteSandboxOnCleanup
      ? deleteSandbox(sandbox).pipe(
          Effect.match({
            onFailure: (error: TerminalCleanupError) => {
              cleanupErrors.push(error.message);
            },
            onSuccess: () => undefined,
          }),
          Effect.asVoid,
        )
      : Effect.void;

    return Effect.gen(function* () {
      yield* disconnectPty;
      yield* deleteSandboxEffect;

      if (cleanupErrors.length > 0) {
        yield* Effect.fail(
          new TerminalCleanupError({
            message: cleanupErrors.join("\n"),
          }),
        );
      }
    });
  });
}

function createPtySession(
  sandbox: Sandbox,
  sessionOptions: StartPlaygroundSessionOptions,
  deleteSandboxOnCleanup: boolean,
  deleteSandbox: (sandbox: Sandbox) => Effect.Effect<void, TerminalCleanupError>,
): Effect.Effect<
  PlaygroundSession,
  PtyCreationError | PtyConnectionError | TerminalStartupCleanupError
> {
  return Effect.gen(function* () {
    let pty: PtyHandle | undefined;

    const cleanup = createSessionCleanup(sandbox, () => pty, deleteSandboxOnCleanup, deleteSandbox);

    pty = yield* Effect.tryPromise({
      try: () =>
        sandbox.process.createPty({
          id: randomUUID(),
          cwd: sessionOptions.cwd ?? "/workspace",
          envs: createSessionEnvs(sessionOptions.envs),
          cols: sessionOptions.cols,
          rows: sessionOptions.rows,
          onData: sessionOptions.onData ?? (() => {}),
        }),
      catch: (cause) =>
        new PtyCreationError({
          message: "Failed to create the Daytona PTY session.",
          sandboxId: sandbox.id,
          cause,
        }),
    });

    const connectedPty = pty;

    yield* Effect.tryPromise({
      try: () => connectedPty.waitForConnection(),
      catch: (cause) =>
        new PtyConnectionError({
          message: "Failed to connect to the Daytona PTY session.",
          sessionId: connectedPty.sessionId,
          cause,
        }),
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          cleanup.pipe(
            Effect.matchEffect({
              onFailure: (cleanupError) =>
                Effect.fail(
                  new TerminalStartupCleanupError({
                    message: `${error.message}\n${cleanupError.message}`,
                    cause: error,
                  }),
                ),
              onSuccess: () => Effect.fail(error),
            }),
          ),
        onSuccess: () => Effect.void,
      }),
    );

    return {
      sandbox,
      sandboxId: sandbox.id,
      sessionId: connectedPty.sessionId,
      pty: connectedPty,
      cleanup,
      sendInput: (input) =>
        Effect.tryPromise({
          try: () => connectedPty.sendInput(input),
          catch: (cause) =>
            new PtyInputError({
              message: "Failed to forward input to the Daytona PTY session.",
              sessionId: connectedPty.sessionId,
              cause,
            }),
        }),
      resize: (cols, rows) =>
        Effect.tryPromise({
          try: () => connectedPty.resize(cols, rows),
          catch: (cause) =>
            new PtyResizeError({
              message: "Failed to resize the Daytona PTY session.",
              sessionId: connectedPty.sessionId,
              cols,
              rows,
              cause,
            }),
        }).pipe(Effect.asVoid),
      wait: Effect.tryPromise({
        try: () => connectedPty.wait(),
        catch: (cause) =>
          new PtyWaitError({
            message: "Failed while waiting for the Daytona PTY session to exit.",
            sessionId: connectedPty.sessionId,
            cause,
          }),
      }),
    } satisfies PlaygroundSession;
  });
}

export function makeTerminalService(options: TerminalServiceOptions): TerminalServiceShape {
  const sandboxService = options.sandboxService;

  const createManagedSandbox = (
    createOptions: CreateSandboxOptions,
  ): Effect.Effect<Sandbox, SandboxCreationError> =>
    sandboxService.createSandbox(createOptions).pipe(
      Effect.mapError(
        (error) =>
          new SandboxCreationError({
            message: "Failed to create the Daytona sandbox for the PTY playground.",
            cause: error.cause ?? error.message,
          }),
      ),
    );

  const lookupManagedSandbox = (sandboxId: string): Effect.Effect<Sandbox, SandboxLookupError> =>
    sandboxService.getSandbox(sandboxId).pipe(
      Effect.mapError(
        (error: ManagedSandboxLookupError) =>
          new SandboxLookupError({
            message: error.message,
            sandboxId,
            cause: error.cause,
          }),
      ),
    );

  const deleteManagedSandbox = (sandbox: Sandbox): Effect.Effect<void, TerminalCleanupError> =>
    sandboxService.deleteSandbox(sandbox).pipe(
      Effect.mapError(
        (error) =>
          new TerminalCleanupError({
            message: error.message,
          }),
      ),
    );

  return {
    startPlaygroundSession(sessionOptions: StartPlaygroundSessionOptions = {}) {
      return Effect.gen(function* () {
        const sandbox = yield* createManagedSandbox({
          sandboxName: createSandboxName(sessionOptions.sandboxName),
          labels: {
            capability: "terminal",
          },
        });

        return yield* createPtySession(sandbox, sessionOptions, false, deleteManagedSandbox);
      });
    },
    openSandboxPtySession(sessionOptions: OpenSandboxPtySessionOptions) {
      return Effect.gen(function* () {
        const sandbox = yield* lookupManagedSandbox(sessionOptions.sandboxId);

        return yield* createPtySession(
          sandbox,
          sessionOptions,
          sessionOptions.deleteSandboxOnCleanup ?? false,
          deleteManagedSandbox,
        );
      });
    },
  };
}

export function makeTerminalServiceLayer(
  options: TerminalServiceLayerOptions = {},
): Layer.Layer<TerminalService, never, SandboxService> {
  return Layer.effect(
    TerminalService,
    Effect.gen(function* () {
      void options;
      const sandboxService = yield* SandboxService;

      return makeTerminalService({
        sandboxService,
      });
    }),
  );
}

export const TerminalServiceLive = makeTerminalServiceLayer;
