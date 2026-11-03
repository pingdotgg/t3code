import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_AGENT_SLEEP_BLOCK_CHANNEL } from "../channels.ts";

const AgentSleepBlock = Schema.Struct({
  active: Schema.Boolean,
});

/**
 * Current powerSaveBlocker id, or null while the blocker is not held. The
 * renderer reports only the aggregate "agents running" boolean, so keeping
 * the id here makes repeated identical reports idempotent.
 */
let blockerId: number | null = null;

/**
 * Blocks system suspend and hibernate while agents are running, without
 * keeping the display awake (`prevent-app-suspension`) — an agent can work
 * for hours behind a blanked screen, and the OS screensaver policy is the
 * user's, not the app's. On Linux this maps to a logind sleep inhibitor, so
 * sleeping is still possible through the user's own session-end actions.
 */
export function applyAgentSleepBlock(active: boolean): void {
  try {
    if (active) {
      blockerId ??= Electron.powerSaveBlocker.start("prevent-app-suspension");
      return;
    }
    if (blockerId !== null) {
      Electron.powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not toggle the agent sleep blocker", error));
  }
}

export const installAgentSleepBlock = Effect.fn("desktop.ipc.installAgentSleepBlock")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_AGENT_SLEEP_BLOCK_CHANNEL,
        payload: AgentSleepBlock,
        result: Schema.Void,
        handler: ({ active }) => Effect.sync(() => applyAgentSleepBlock(active)),
      }),
    );
    // Same shutdown hygiene as the notification badge: a renderer that died
    // mid-turn must not leave the machine awake forever.
    yield* app.on("before-quit", () => applyAgentSleepBlock(false));
    yield* Effect.addFinalizer(() => Effect.sync(() => applyAgentSleepBlock(false)));
  },
);
