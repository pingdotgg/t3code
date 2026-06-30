import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "vite-plus/test";

class OxlintFixtureFailure extends Data.TaggedError("OxlintFixtureFailure")<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  static readonly is = (u: unknown): u is OxlintFixtureFailure =>
    Predicate.isTagged(u, "OxlintFixtureFailure");
}

class OxlintFixtureExpectedFailure extends Data.TaggedError("OxlintFixtureExpectedFailure")<{
  readonly ruleName: string;
}> {
  override get message() {
    return `Expected oxlint to report a failure for rule ${this.ruleName}, but it passed.`;
  }
}

const encodeOxlintConfig = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface RuleHarness {
  readonly run: (
    source: string,
  ) => Effect.Effect<
    string,
    OxlintFixtureFailure | PlatformError.PlatformError | Schema.SchemaError,
    NodeServices.NodeServices
  >;
  readonly runAndExpectFailure: (
    source: string,
  ) => Effect.Effect<
    string,
    OxlintFixtureExpectedFailure | PlatformError.PlatformError | Schema.SchemaError,
    NodeServices.NodeServices
  >;
  readonly valid: (name: string, source: string) => void;
  readonly invalid: (name: string, source: string, assertion?: (output: string) => void) => void;
}

interface RuleHarnessOptions {
  readonly filename?: string;
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const spawnAndCollectOutput = Effect.fnUntraced(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { exitCode, stdout, stderr };
}, Effect.scoped);

const runNodeEffect = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

export const createOxlintRuleHarness = (
  ruleName: string,
  options: RuleHarnessOptions = {},
): RuleHarness => {
  const [pluginName, shortRuleName] = ruleName.split("/");
  const diagnosticRuleName =
    pluginName && shortRuleName ? `${pluginName}\\(${shortRuleName}\\)` : ruleName;

  const run: RuleHarness["run"] = Effect.fnUntraced(function* (source: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-oxlint-" });
    const configPath = path.join(fixtureDir, ".oxlintrc.json");
    const sourcePath = path.join(fixtureDir, options.filename ?? "fixture.ts");
    const repoRoot = path.join(import.meta.dirname, "..", "..");
    const oxlintBin = path.join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");
    const pluginPath = path.join(repoRoot, "oxlint-plugin-t3code", "index.ts");

    yield* fs.writeFileString(
      configPath,
      yield* encodeOxlintConfig({
        jsPlugins: [{ name: "t3code", specifier: pluginPath }],
        rules: { [ruleName]: "error" },
      }),
    );
    yield* fs.writeFileString(sourcePath, source);

    const output = yield* spawnAndCollectOutput(
      ChildProcess.make(oxlintBin, ["--config", configPath, sourcePath], { cwd: repoRoot }),
    );

    if (output.exitCode !== 0) {
      return yield* new OxlintFixtureFailure({
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    return `${output.stdout}${output.stderr}`;
  }, Effect.scoped);

  const runAndExpectFailure: RuleHarness["runAndExpectFailure"] = (source) =>
    run(source).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          OxlintFixtureFailure.is(error)
            ? Effect.succeed(
                `oxlint fixture failed with exit code ${error.exitCode}\n${error.stdout}\n${error.stderr}`,
              )
            : Effect.fail(error),
        onSuccess: () => Effect.fail(new OxlintFixtureExpectedFailure({ ruleName })),
      }),
    );

  return {
    run,
    runAndExpectFailure,
    valid(name, source) {
      it(name, async () => {
        await runNodeEffect(run(source));
      });
    },
    invalid(name, source, assertion) {
      it(name, async () => {
        const output = await runNodeEffect(runAndExpectFailure(source));
        assert.match(output, new RegExp(diagnosticRuleName));
        assertion?.(output);
      });
    },
  };
};
