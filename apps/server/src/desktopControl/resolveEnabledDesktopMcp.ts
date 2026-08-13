/**
 * Resolves the desktop MCP binary only when Computer Use is enabled in
 * server settings. Settings lookup failures fail closed (tools omitted).
 */
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { resolveDesktopMcpPath } from "./desktopMcpBinary.ts";

export type DesktopMcpLaunch = {
  readonly path: string;
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
};

export const resolveEnabledDesktopMcp = Effect.fn("desktopControl.resolveEnabledDesktopMcp")(
  function* () {
    const path = yield* resolveDesktopMcpPath();
    if (path === undefined) {
      return undefined;
    }

    const settings = yield* ServerSettings.ServerSettingsService;
    const desktopControl = yield* settings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.desktopControl),
      // Fail closed: never inject desktop MCP when we cannot confirm the user
      // still has Computer Use enabled.
      Effect.orElseSucceed(() => ({
        enabled: false,
        agentCursorEnabled: false,
        browserControlEnabled: false,
      })),
    );

    if (!desktopControl.enabled) {
      return undefined;
    }

    const env: Array<{ name: string; value: string }> = [];
    if (!desktopControl.agentCursorEnabled) {
      env.push({ name: "T3_DESKTOP_AGENT_CURSOR", value: "0" });
    }
    if (!desktopControl.browserControlEnabled) {
      env.push({ name: "T3_DESKTOP_BROWSER", value: "0" });
    }

    return { path, env } satisfies DesktopMcpLaunch;
  },
);
