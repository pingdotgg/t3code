import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import * as LegacyV1Recovery from "../orchestration-v2/legacy/LegacyV1Recovery.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);
const encodeReport = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

const recoverV1Command = Command.make("recover-v1", {
  baseDir: baseDirFlag,
  source: Flag.String("source").pipe(
    Flag.optional,
    Flag.withDescription("V1 database (defaults to userdata/state.sqlite)."),
  ),
  target: Flag.String("target").pipe(
    Flag.optional,
    Flag.withDescription("V2 database (defaults to userdata/statev2.sqlite)."),
  ),
  output: Flag.String("output").pipe(
    Flag.optional,
    Flag.withDescription("Create a NEW recovered V2 database; never overwrite either input."),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Report recovery without publishing an output database."),
  ),
}).pipe(
  Command.withDescription(
    "Recover Stable history into a separate V2 database. Without --output, only report changes.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
      const configuredBaseDir = Option.orElse(flags.baseDir, () => envHome);
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
      const recovery = yield* LegacyV1Recovery.LegacyV1Recovery;
      const source = yield* expandHomePath(
        Option.getOrElse(flags.source, () => path.join(baseDir, "userdata", "state.sqlite")),
      );
      const target = yield* expandHomePath(
        Option.getOrElse(flags.target, () => path.join(baseDir, "userdata", "statev2.sqlite")),
      );
      const output = flags.dryRun ? undefined : Option.getOrUndefined(flags.output);
      const report = yield* recovery.recover({
        source,
        target,
        ...(output === undefined ? {} : { output: yield* expandHomePath(output) }),
      });
      yield* Console.log(yield* encodeReport(report));
    }).pipe(Effect.provide(LegacyV1Recovery.layer)),
  ),
);

export const threadsCommand = Command.make("threads").pipe(
  Command.withDescription("Recover thread history."),
  Command.withSubcommands([recoverV1Command]),
);
