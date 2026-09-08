import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { SOURCE_CONTROL_CLI_COMMANDS, type SourceControlCliCommand } from "@t3tools/contracts";

import { expandHomePath } from "../os-jank.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Maps the logical command name a caller passes to {@link VcsProcess} onto the
 * executable actually spawned. Callers keep using `"gh"`, `"glab"`, and `"az"`
 * as identifiers — in error payloads and in the process limiter — while the
 * user stays free to point each one at a specific binary.
 */
export class VcsExecutables extends Context.Service<
  VcsExecutables,
  {
    readonly resolve: (command: string) => Effect.Effect<string>;
  }
>()("t3/vcs/VcsExecutables") {}

const OVERRIDABLE_COMMANDS: ReadonlySet<string> = new Set(SOURCE_CONTROL_CLI_COMMANDS);

function isOverridable(command: string): command is SourceControlCliCommand {
  return OVERRIDABLE_COMMANDS.has(command);
}

/** Every command resolves by name on PATH. */
export const layerPathOnly = Layer.succeed(
  VcsExecutables,
  VcsExecutables.of({ resolve: Effect.succeed }),
);

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;

  // Only the hosting CLIs are configurable, so Git — the hot path — never pays
  // for a settings read.
  const resolve = (command: string): Effect.Effect<string> =>
    isOverridable(command)
      ? serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.sourceControlCliPaths[command].trim()),
          Effect.flatMap((override) =>
            override.length === 0
              ? Effect.succeed(command)
              : expandHomePath(override).pipe(Effect.provideService(Path.Path, path)),
          ),
          Effect.orElseSucceed(() => command),
        )
      : Effect.succeed(command);

  return VcsExecutables.of({ resolve });
});

export const layer = Layer.effect(VcsExecutables, make);
