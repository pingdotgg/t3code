import type { PluginId } from "@t3tools/contracts/plugin";
import type { TerminalSessionHandle, TerminalsCapability } from "@t3tools/plugin-sdk";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import * as TerminalManager from "../../terminal/Manager.ts";

const quoteShellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const commandLine = (command: string, args: ReadonlyArray<string> | undefined) =>
  [command, ...(args ?? [])].map(quoteShellArg).join(" ");

// A plugin owns exactly the terminal namespace `plugin:<id>:*` — every handle
// `spawn` mints uses this thread-id prefix.
const ownedThreadPrefix = (pluginId: PluginId) => `plugin:${pluginId}:`;

const defaultHandle = (pluginId: PluginId, terminalId: string): TerminalSessionHandle => ({
  threadId: `${ownedThreadPrefix(pluginId)}${terminalId}`,
  terminalId,
});

// Terminal handles are plain caller-supplied data, so `sendInput`/`kill`/`observe`
// must NOT trust the incoming thread id: a plugin (or one driven by malicious
// webhook/UI data) could otherwise synthesize a handle for a foreign plugin's
// terminal (`plugin:other:run-1`) or a core thread and write to / close / attach
// to it. Enforce the plugin-owned prefix — its documented session boundary — as
// defense-in-depth before forwarding to the manager.
export class TerminalHandleOwnershipError extends Schema.TaggedErrorClass<TerminalHandleOwnershipError>()(
  "TerminalHandleOwnershipError",
  { threadId: Schema.String, terminalId: Schema.String },
) {
  override get message(): string {
    return `Terminal handle for thread ${JSON.stringify(this.threadId)} is not owned by this plugin.`;
  }
}

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
  const prefix = ownedThreadPrefix(input.pluginId);

  const requireOwnedHandle = (
    handle: TerminalSessionHandle,
  ): Effect.Effect<TerminalSessionHandle, TerminalHandleOwnershipError> =>
    handle.threadId.startsWith(prefix)
      ? Effect.succeed(handle)
      : Effect.fail(
          new TerminalHandleOwnershipError({
            threadId: handle.threadId,
            terminalId: handle.terminalId,
          }),
        );

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
      // Open + track atomically: mask interruption so that once `open` succeeds
      // the terminal is always recorded in `live` before any interruptible work.
      // Otherwise an interrupt landing in the gap would leak the PTY/process —
      // shutdown snapshots `live` and would never see it.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const terminalId =
            request.terminalId ??
            `run-${yield* Clock.currentTimeMillis}-${(yield* Random.nextInt).toString(36)}`;
          const handle = defaultHandle(input.pluginId, terminalId);
          const snapshot = yield* restore(
            input.manager.open({
              ...handle,
              cwd: request.cwd,
              ...(request.env === undefined ? {} : { env: request.env }),
              cols: request.cols ?? 120,
              rows: request.rows ?? 30,
            }),
          );
          live.set(terminalId, handle);
          yield* restore(
            input.manager.write({
              ...handle,
              data: `${commandLine(request.command, request.args)}\n`,
            }),
          );
          return { handle, snapshot };
        }),
      ),
    observe: (handle, listener) =>
      requireOwnedHandle(handle).pipe(
        Effect.flatMap((owned) =>
          input.manager.attachStream(
            {
              ...owned,
              restartIfNotRunning: false,
            },
            listener,
          ),
        ),
      ),
    sendInput: (request) =>
      requireOwnedHandle(request).pipe(Effect.flatMap(() => input.manager.write(request))),
    kill: (request) =>
      requireOwnedHandle(request).pipe(
        Effect.flatMap(() =>
          closeHandle(
            { threadId: request.threadId, terminalId: request.terminalId },
            request.deleteHistory,
          ),
        ),
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
