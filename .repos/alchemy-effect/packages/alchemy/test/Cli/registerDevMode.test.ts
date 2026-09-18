import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";

// Pins buildless node dev end to end: the register-dev-mode hooks must
// (1) resolve the monorepo's own packages through their `bun` export
// condition onto src/ — otherwise the CLI runs from src while a user's
// stack (which imports `alchemy`) resolves built lib/, splitting the
// process across two copies of the package — while leaving packages
// without a `bun` condition (published sigil) on their built output, and
// (2) transpile `.tsx` with ALCHEMY'S tsconfig (react-jsx) regardless of
// the invoking project: the child's cwd is an example on purpose. Oxc resolves
// the nearest tsconfig per source file, so the CLI's React files cannot inherit
// the example's JSX settings (which previously produced classic-runtime output
// and "ReferenceError: React is not defined").
it.live.skipIf(!nodeSupportsDevMode)(
  "dev-mode hooks resolve monorepo packages to src and transpile tsx",
  () =>
    Effect.gen(function* () {
      const packageDir = fileURLToPath(new URL("../..", import.meta.url));
      const exampleDir = fileURLToPath(
        new URL("../../../../examples/aws-dev", import.meta.url),
      );
      const runtimeTsx = fileURLToPath(
        new URL("../../src/Cli/components/view/Runtime.tsx", import.meta.url),
      );
      const resolutionProbe = fileURLToPath(
        new URL("./fixtures/register-dev-mode-probe.ts", import.meta.url),
      );
      // No explicit sigil probe: two-arg import.meta.resolve is flagged in
      // node, and Runtime.tsx importing sigil transitively already proves
      // the published package (no `bun` condition) loads from its dist.
      const script = `
        const probe = await import(${JSON.stringify(resolutionProbe)});
        console.log("alchemy=" + probe.alchemyUrl);
        console.log("sub=" + probe.subpathUrl);
        await import(${JSON.stringify(runtimeTsx)});
        console.log("tsx=ok");
      `;
      const handle = yield* ChildProcess.make(
        nodePath!,
        [
          "--import",
          `${packageDir}/bin/register-dev-mode.js`,
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: exampleDir,
          env: {
            NO_COLOR: "1",
            // The Bun test runner's markers must not select Bun for this
            // explicitly Node/pnpm invocation.
            npm_execpath: "",
            npm_config_user_agent: "",
          },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGKILL",
        },
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.stderr.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/alchemy=file:.*\/src\/index\.ts/);
      expect(stdout).toMatch(/sub=file:.*\/src\/Cloudflare\/index\.ts/);
      expect(stdout).toContain("tsx=ok");

      const repoDir = fileURLToPath(new URL("../../../..", import.meta.url));
      const pnpm = Bun.which("pnpm");
      expect(pnpm).not.toBeNull();
      const cli = yield* ChildProcess.make(pnpm!, ["alchemy", "--version"], {
        cwd: repoDir,
        env: {
          NO_COLOR: "1",
          // The Bun test runner's markers must not select Bun for this
          // explicitly Node/pnpm invocation.
          npm_execpath: "",
          npm_config_user_agent: "",
        },
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL",
      });
      const [cliStdout, cliStderr, cliExitCode] = yield* Effect.all(
        [
          cli.stdout.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          cli.stderr.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          cli.exitCode,
        ],
        { concurrency: 3 },
      );
      expect(cliStderr).toBe("");
      expect(cliExitCode).toBe(0);
      expect(cliStdout).toMatch(/alchemy v.*\(node [^,]+, src\)/);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  { timeout: 60_000 },
);
