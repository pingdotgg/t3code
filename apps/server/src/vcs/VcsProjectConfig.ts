import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsDriverKind, type VcsDriverKind as VcsDriverKindType } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

const ProjectVcsConfig = Schema.Struct({
  vcs: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(VcsDriverKind),
    }),
  ),
  vcsKind: Schema.optional(VcsDriverKind),
});
const ProjectVcsConfigJson = fromLenientJson(ProjectVcsConfig);
const decodeProjectVcsConfigJson = Schema.decodeUnknownOption(ProjectVcsConfigJson);

type ProjectVcsConfigFile = typeof ProjectVcsConfig.Type;

export interface VcsProjectConfigResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKindType | "auto";
}

export interface VcsProjectConfigShape {
  readonly resolveKind: (
    input: VcsProjectConfigResolveInput,
  ) => Effect.Effect<VcsDriverKindType | "auto">;
}

export class VcsProjectConfig extends Context.Service<VcsProjectConfig, VcsProjectConfigShape>()(
  "t3/vcs/VcsProjectConfig",
) {}

function configuredKind(config: ProjectVcsConfigFile): VcsDriverKindType | "auto" {
  return config.vcs?.kind ?? config.vcsKind ?? "auto";
}

const parseConfig = (raw: string): Option.Option<ProjectVcsConfigFile> =>
  decodeProjectVcsConfigJson(raw);

export const make = Effect.fn("makeVcsProjectConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".t3code", "vcs.json");
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  const readConfiguredKind = Effect.fn("VcsProjectConfig.readConfiguredKind")(function* (
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logWarning("failed to read VCS project config", {
          configPath,
          error,
        }).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(raw)) {
      return "auto" as const;
    }

    const parsed = parseConfig(raw.value);
    if (Option.isNone(parsed)) {
      yield* Effect.logWarning("invalid VCS project config", {
        configPath,
      });
      return "auto" as const;
    }

    return configuredKind(parsed.value);
  });

  const resolveKind: VcsProjectConfigShape["resolveKind"] = Effect.fn(
    "VcsProjectConfig.resolveKind",
  )(function* (input) {
    if (input.requestedKind !== undefined && input.requestedKind !== "auto") {
      return input.requestedKind;
    }

    const configPath = yield* findConfigPath(input.cwd);
    return yield* Option.match(configPath, {
      onNone: () => Effect.succeed("auto" as const),
      onSome: readConfiguredKind,
    });
  });

  return VcsProjectConfig.of({
    resolveKind,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make());
