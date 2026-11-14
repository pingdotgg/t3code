import type { OrchestrationV2CreationSource, ThreadId } from "@t3tools/contracts";
import { NORMAL_DISPLAY_MODE, resolveDisplayMode } from "@t3tools/shared/displayModes";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** The raw fields of a client's `launchThread` request, before any default is applied. */
export interface ClientLaunch {
  readonly threadId?: ThreadId | undefined;
  readonly reuseExistingThread?: boolean | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
}

/** Copies the default mode into a thread that does not exist yet; true when it wrote a mode entry. */
const adopt = Effect.fn("NewThreadDisplayMode.adopt")(
  function* (threadId: ThreadId) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings;
    const mode = resolveDisplayMode(current.newThreadDisplayMode);
    const entry = mode.id === NORMAL_DISPLAY_MODE.id ? undefined : mode.id;
    if (current.threadDisplayModes[threadId] === entry) return false;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    if ((yield* threads.getThreadShell(threadId)) !== null) return false;
    yield* settings.updateSettings({ threadDisplayModes: { [threadId]: entry ?? null } });
    return entry !== undefined;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("New thread display mode not set", { cause }).pipe(Effect.as(false)),
  ),
);

const undo = Effect.fn("NewThreadDisplayMode.undo")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    if ((yield* threads.getThreadShell(threadId)) !== null) return;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ threadDisplayModes: { [threadId]: null } });
  },
  Effect.catchCause((cause) => Effect.logWarning("New thread display mode not removed", { cause })),
);

/**
 * Opens a new thread that the user starts in the web or desktop app in the default display mode,
 * before its first message goes out. Apply it only at the client `launchThread` RPC: MCP, scheduled
 * tasks and server launches reach `ThreadLaunchService` another way, some with `creationSource: "web"`,
 * and must keep Normal.
 */
export const forClientLaunch =
  (launch: ClientLaunch) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E,
    R | ServerSettings.ServerSettingsService | ThreadManagementService.ThreadManagementService
  > => {
    const threadId = launch.threadId;
    // Scripts omit creationSource; the RPC handler counts them as web only for the launch itself.
    if (
      launch.creationSource !== "web" ||
      launch.reuseExistingThread === true ||
      threadId === undefined
    ) {
      return effect;
    }
    return adopt(threadId).pipe(
      Effect.flatMap((wrote) =>
        wrote ? effect.pipe(Effect.onError(() => undo(threadId))) : effect,
      ),
    );
  };
