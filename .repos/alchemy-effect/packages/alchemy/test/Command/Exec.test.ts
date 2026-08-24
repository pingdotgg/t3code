import * as Command from "@/Command";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Command.providers() });

const FIXTURE_DIR = pathe.resolve(import.meta.dirname, "exec-fixture");

// Copy the fixture into a scoped temp directory so each run starts clean and
// the suite never mutates the committed source tree (the command appends to
// `runs.log` and the test rewrites `src/input.txt`).
const makeTemporaryFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tempDir = yield* fs.makeTempDirectoryScoped();
  yield* fs.copy(FIXTURE_DIR, tempDir);
  return { cwd: tempDir };
});

test.provider(
  "list returns [] for non-listable Command.Exec",
  () =>
    Effect.gen(function* () {
      // Command.Exec is a local side-effect step with no remote enumeration
      // API, so list() is the non-listable pattern: always returns [].
      const provider = yield* Provider.findProvider(Command.Exec);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { timeout: 30000 },
);

test.provider(
  "runs on file, env, and command changes; delete leaves side effects alone",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      const fixture = yield* makeTemporaryFixture();
      const runsLog = pathe.join(fixture.cwd, "runs.log");
      const inputFile = pathe.join(fixture.cwd, "src", "input.txt");

      // The command appends a line per run; counting lines tells us exactly
      // how many times the command actually executed.
      const countRuns = Effect.gen(function* () {
        if (!(yield* fs.exists(runsLog))) return 0;
        const content = yield* fs.readFileString(runsLog);
        return content.split("\n").filter((line) => line.length > 0).length;
      });

      const deploy = (props: { command?: string; env?: { MARKER: string } }) =>
        stack.deploy(
          Command.Exec("test-exec", {
            command: props.command ?? "bash run.sh",
            shell: true,
            cwd: fixture.cwd,
            env: props.env ?? { MARKER: "first" },
            memo: { include: ["src/**"] },
          }),
        );

      const exec1 = yield* deploy({});

      // Memoization is enabled, so the input-file hash is recorded.
      expect(exec1.hash.input).toEqual(expect.any(String));
      expect(yield* countRuns).toBe(1);

      // Unchanged inputs — the run is skipped.
      const exec2 = yield* deploy({});
      expect(exec2.hash.input).toBe(exec1.hash.input);
      expect(yield* countRuns).toBe(1);

      // An env-only change re-runs (e.g. a recreated database's connection URL
      // with identical files). The hash tracks input files only, so it is
      // unchanged — the re-run is driven by the prop change, not the hash.
      const exec3 = yield* deploy({ env: { MARKER: "second" } });
      expect(yield* countRuns).toBe(2);
      expect(exec3.hash.input).toBe(exec1.hash.input);

      // A command-only change re-runs.
      const exec4 = yield* deploy({
        command: "bash run.sh second-run",
        env: { MARKER: "second" },
      });
      expect(yield* countRuns).toBe(3);
      expect(exec4.hash.input).toBe(exec3.hash.input);

      // A memoized input file change re-runs and changes the input hash.
      yield* fs.writeFileString(inputFile, "two\n");
      const exec5 = yield* deploy({
        command: "bash run.sh second-run",
        env: { MARKER: "second" },
      });
      expect(yield* countRuns).toBe(4);
      expect(exec5.hash.input).not.toBe(exec4.hash.input);

      // Destroy never reverses the command's side effects…
      yield* stack.destroy();
      expect(yield* countRuns).toBe(4);

      // …and forgets the run key, so an unchanged redeploy runs again.
      const exec6 = yield* deploy({
        command: "bash run.sh second-run",
        env: { MARKER: "second" },
      });
      expect(yield* countRuns).toBe(5);
      expect(exec6.hash.input).toBe(exec5.hash.input);

      yield* stack.destroy();
    }),
  { timeout: 60000 },
);
