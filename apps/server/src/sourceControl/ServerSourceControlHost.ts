/**
 * The server's implementation of `SourceControlHost.SourceControlHost`, the only server surface
 * source control provider packages may use.
 *
 * @module sourceControl/ServerSourceControlHost
 */
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    return SourceControlHost.SourceControlHost.of({
      settings: { get: serverSettings.getSettings },
      process: { run: process.run },
    });
  }),
);
