/**
 * Resolves the desktop MCP binary only when Computer Use is enabled in
 * server settings. Missing settings service → treat as enabled (dev/tests).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

    const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const desktopControl = yield* Option.match(settingsService, {
      onNone: () =>
        Effect.succeed({
          enabled: true,
          agentCursorEnabled: true,
          browserControlEnabled: true,
        }),
      onSome: (service) =>
        service.getSettings.pipe(
          Effect.map((settings) => settings.desktopControl),
          Effect.orElseSucceed(() => ({
            enabled: true,
            agentCursorEnabled: true,
            browserControlEnabled: true,
          })),
        ),
    });

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
