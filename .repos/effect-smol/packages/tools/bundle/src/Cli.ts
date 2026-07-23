/**
 * Command definitions for the `effect-bundle` bundle-size CLI.
 *
 * This module wires the top-level `bundle` command to the reporting service and
 * exposes the workflows used when maintaining fixture bundle sizes. `compare`
 * builds the package's local fixtures and compares them with matching fixture
 * files from another checkout, `report` bundles an explicit list of entrypoints
 * and prints a Markdown table, and `visualize` prompts for local fixtures before
 * producing visualization output for inspection.
 *
 * Command output is intentionally split by workflow. `compare` requires an
 * existing `--base-dir` (`-b`) and writes its Markdown report to `--output-path`
 * (`-o`), defaulting to `stats.txt` resolved from the current working directory.
 * `report` accepts one or more existing files and writes to stdout. `visualize`
 * uses `--output-dir` (`-o`) for generated bundle artifacts, so `-o` names a
 * file for `compare` but a directory for `visualize`.
 *
 * @since 4.0.0
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as Prompt from "effect/unstable/cli/Prompt"
import { Fixtures } from "./Fixtures.ts"
import { Reporter } from "./Reporter.ts"

const baseDirectory = Flag.directory("base-dir", { mustExist: true }).pipe(
  Flag.withAlias("b"),
  Flag.withDescription("The base directory to use for bundle size comparisons")
)

const outputPath = Flag.file("output-path").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("The name of the file to write the bundle size report to"),
  Flag.withDefault("stats.txt"),
  Flag.mapEffect(Effect.fnUntraced(function*(outputPath) {
    const path = yield* Path.Path
    return path.resolve(outputPath)
  }))
)

const compare = Command.make("compare", { baseDirectory, outputPath }).pipe(
  Command.withHandler(Effect.fnUntraced(function*({ baseDirectory, outputPath }) {
    const fs = yield* FileSystem.FileSystem
    const reporter = yield* Reporter
    const report = yield* reporter.report({ baseDirectory })
    yield* fs.writeFileString(outputPath, report)
    yield* Effect.log(`Bundle size report written to: '${outputPath}'`)
  }))
)

const outputDirectory = Flag.directory("output-dir").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("The name of the directory to write the bundle size visualizations to"),
  Flag.mapEffect(Effect.fnUntraced(function*(outputPath) {
    const path = yield* Path.Path
    return path.resolve(outputPath)
  }))
)

const visualize = Command.make("visualize", { outputDirectory }).pipe(
  Command.withHandler(Effect.fnUntraced(function*({ outputDirectory }) {
    const path = yield* Path.Path
    const { fixtures, fixturesDir } = yield* Fixtures
    const reporter = yield* Reporter

    const paths = yield* Prompt.multiSelect({
      message: "Select files whose bundle size you would like to visualize",
      choices: fixtures.map((fixture) => ({
        title: fixture,
        value: path.join(fixturesDir, fixture)
      }))
    })

    yield* reporter.visualize({ paths, outputDirectory })
  }))
)

const reportPaths = Argument.file("paths", { mustExist: true }).pipe(
  Argument.withDescription("Fixture files to include in the report"),
  Argument.variadic({ min: 1 })
)

const report = Command.make("report", { paths: reportPaths }).pipe(
  Command.withHandler(Effect.fnUntraced(function*({ paths }) {
    const reporter = yield* Reporter
    const report = yield* reporter.reportSelected({ paths })
    yield* Console.log(report)
  }))
)

/**
 * Bundle analysis CLI command with subcommands for comparing fixture bundle sizes, reporting selected fixtures, and generating visualizations.
 *
 * @category commands
 * @since 4.0.0
 */
export const cli = Command.make("bundle").pipe(
  Command.withSubcommands([compare, report, visualize])
)
