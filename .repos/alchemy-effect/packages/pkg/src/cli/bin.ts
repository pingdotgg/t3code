#!/usr/bin/env node
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import { CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/cli";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import pkg from "../../package.json" with { type: "json" };
import { Group, pack } from "./pack.ts";
import { publish } from "./publish.ts";

const groupFlag = Flag.String("group").pipe(
  Flag.withDescription(
    "Display group and directory glob, as NAME=GLOB or NAME[Collapsed]=GLOB (repeatable), e.g. --group Alchemy=./packages/*",
  ),
  Flag.withSchema(Group),
  Flag.atLeast(1),
);

const registryFlag = Flag.String("registry").pipe(
  Flag.withDescription(
    "Registry origin used for install URLs. Falls back to PKG_REGISTRY, then https://pkg.alchemy.run",
  ),
  Flag.withFallbackConfig(Config.String("PKG_REGISTRY")),
  Flag.withDefault("https://pkg.alchemy.run"),
);

const outFlag = Flag.String("out").pipe(
  Flag.withDescription("Directory to write tarballs and the manifest into"),
  Flag.withDefault(".pkg"),
);

export const packCommand = Command.make(
  "pack",
  {
    group: groupFlag,
    registry: registryFlag,
    out: outFlag,
    since: Flag.String("since").pipe(
      Flag.withDescription("Compare HEAD with this Git ref; defaults to the PR base in Actions"),
      Flag.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Pack every configured package regardless of changes"),
    ),
    rebuildAllPaths: Flag.String("rebuild-all-path").pipe(
      Flag.withDescription(
        "Additional exact path or directory/** forcing all packages (repeatable)",
      ),
      Flag.atLeast(0),
    ),
  },
  ({ group, registry, out, since, all, rebuildAllPaths }) =>
    Effect.gen(function* () {
      const cwd = yield* Effect.sync(() => process.cwd());
      yield* pack({
        cwd,
        groups: group,
        registry,
        out,
        since: Option.getOrUndefined(since),
        all,
        rebuildAllPaths,
      });
    }),
).pipe(
  Command.withDescription(
    "Pack workspace packages into reproducible tarballs with dependencies rewritten to registry URLs",
  ),
  Command.withExamples([
    {
      command:
        "pkg pack --group 'alchemy=./packages/alchemy' --group '@alchemy.run[Collapsed]=./packages/{better-auth,pkg}' --group '@distilled.cloud[Collapsed]=./submodules/distilled/packages/*'",
    },
  ]),
);

const dirFlag = Flag.String("dir").pipe(
  Flag.withDescription("Directory written by pkg pack"),
  Flag.withDefault(".pkg"),
);

export const publishCommand = Command.make(
  "publish",
  { registry: registryFlag, dir: dirFlag },
  ({ registry, dir }) =>
    Effect.gen(function* () {
      const cwd = yield* Effect.sync(() => process.cwd());
      yield* publish({ cwd, dir, registry });
    }),
).pipe(
  Command.withDescription(
    "Publish a pkg pack directory from the current GitHub Actions job, after its manifest artifact has been uploaded",
  ),
  Command.withExamples([{ command: "pkg publish --registry https://pkg.alchemy.run" }]),
);

export const root = Command.make("pkg", {}, () =>
  Effect.fail(CliError.ShowHelp.make({ commandPath: ["pkg"], errors: [] })),
).pipe(
  Command.withDescription("Pack and publish preview packages for pull requests."),
  Command.withSubcommands([packCommand, publishCommand]),
);

Command.run(root, { version: pkg.version }).pipe(
  Effect.provide(
    Layer.mergeAll(
      PlatformServices,
      FetchHttpClient.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
    ),
  ),
  runMain,
);
