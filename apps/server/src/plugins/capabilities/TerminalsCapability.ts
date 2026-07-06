import type { PluginId } from "@t3tools/contracts/plugin";
import type { TerminalSessionHandle, TerminalsCapability } from "@t3tools/plugin-sdk";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import * as TerminalManager from "../../terminal/Manager.ts";

const quoteShellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const commandLine = (command: string, args: ReadonlyArray<string> | undefined) =>
  [command, ...(args ?? [])].map(quoteShellArg).join(" ");

const defaultHandle = (pluginId: PluginId, terminalId: string): TerminalSessionHandle => ({
  threadId: `plugin:${pluginId}:${terminalId}`,
  terminalId,
});

export interface TerminalsCapabilityBundle {
  readonly capability: TerminalsCapability;
  /** Closes every terminal the plugin still holds open; run on plugin scope close. */
  readonly shutdown: Effect.Effect<void>;
}

export function makeTerminalsCapability(input: {
  readonly pluginId: PluginId;
  readonly manager: TerminalManager.TerminalManager["Service"];
}): TerminalsCapabilityBundle {
  // Track live terminals so a plugin that forgets to kill one, throws after
  // spawn, or has its scope aborted cannot leak the underlying PTY/process.
  const live = new Map<string, TerminalSessionHandle>();

  const closeHandle = (handle: TerminalSessionHandle, deleteHistory?: boolean) =>
    input.manager
      .close({
        threadId: handle.threadId,
        terminalId: handle.terminalId,
        ...(deleteHistory === undefined ? {} : { deleteHistory }),
      })
      .pipe(Effect.ensuring(Effect.sync(() => live.delete(handle.terminalId))));

  const capability: TerminalsCapability = {
    spawn: (request) =>
      Effect.gen(function* () {
        const terminalId =
          request.terminalId ??
          `run-${yield* Clock.currentTimeMillis}-${(yield* Random.nextInt).toString(36)}`;
        const handle = defaultHandle(input.pluginId, terminalId);
        const snapshot = yield* input.manager.open({
          ...handle,
          cwd: request.cwd,
          ...(request.env === undefined ? {} : { env: request.env }),
          cols: request.cols ?? 120,
          rows: request.rows ?? 30,
        });
        live.set(terminalId, handle);
        yield* input.manager.write({
          ...handle,
          data: `${commandLine(request.command, request.args)}\n`,
        });
        return { handle, snapshot };
      }),
    observe: (handle, listener) =>
      input.manager.attachStream(
        {
          ...handle,
          restartIfNotRunning: false,
        },
        listener,
      ),
    sendInput: (request) => input.manager.write(request),
    kill: (request) =>
      closeHandle(
        { threadId: request.threadId, terminalId: request.terminalId },
        request.deleteHistory,
      ),
  };

  // Suspend so the live set is read at teardown time, not at construction.
  const shutdown = Effect.suspend(() =>
    Effect.forEach(Array.from(live.values()), (handle) => closeHandle(handle).pipe(Effect.ignore), {
      discard: true,
    }),
  );

  return { capability, shutdown };
}
