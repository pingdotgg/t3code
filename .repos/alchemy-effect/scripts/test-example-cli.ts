import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { forwardSignals } from "../packages/alchemy-test/src/DevCli.ts";

const example = process.argv[2];
if (example === undefined) {
  throw new Error(
    "Usage: bun scripts/test-example-cli.ts <example-directory> [--dev-only]",
  );
}
const devOnly = process.argv.includes("--dev-only");

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const exampleRoot = path.resolve(repositoryRoot, example);
// The real launcher, not `bin/alchemy.ts`: it pins bun's tsconfig to
// alchemy's own, so the CLI's .tsx files are not transpiled with the
// example's JSX settings (solid-js examples otherwise crash the CLI).
const alchemyBin = path.join(
  repositoryRoot,
  "packages",
  "alchemy",
  "bin",
  "cli.js",
);
const stage = "cli-example-test";
// The summary line the CLI prints once a run converges. In non-TTY mode every
// line carries a `[time] LEVEL (#fiber): ` prefix, so anchor on the text.
const DONE = /Done: \d+ succeeded/;
const timeoutMs = 4 * 60_000;
// With a profile (`bun test:examples --profile testing`) the CLI must see the
// real ALCHEMY_HOME (where the profile's credentials live) and must NOT run
// as CI, which makes auth resolution skip profiles for env credentials.
// Without a profile, run against an empty home as CI so the CLI can only
// authenticate from env vars, the way a fresh CI runner would.
const profile = process.env.ALCHEMY_PROFILE;
const alchemyHome =
  profile === undefined
    ? fs.mkdtempSync(path.join(os.tmpdir(), "alchemy-example-cli-"))
    : undefined;
const childEnv = {
  ...process.env,
  ...(alchemyHome === undefined
    ? {}
    : { ALCHEMY_HOME: alchemyHome, AWS_PROFILE: undefined, CI: "true" }),
  NO_COLOR: "1",
};

type CommandResult = {
  readonly exitCode: number | null;
  readonly output: string;
};

const command = (name: "dev" | "deploy" | "destroy") => [
  "bun",
  alchemyBin,
  name,
  "--stage",
  stage,
  "--no-input",
  ...(name === "dev" ? [] : ["--yes"]),
];

const run = (
  name: "deploy" | "destroy",
  timeout = timeoutMs,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command(name)[0]!, command(name).slice(1), {
      cwd: exampleRoot,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    forwardSignals(child);
    let output = "";
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The CLI and its process group have already exited.
      }
    };
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (process.env.DEBUG) process.stderr.write(text);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      output += `\nTimed out after ${timeout / 1000}s waiting for alchemy ${name}.`;
      killGroup();
    }, timeout);
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });

const runDev = (): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command("dev")[0]!, command("dev").slice(1), {
      cwd: exampleRoot,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    forwardSignals(child);
    let output = "";
    let settled = false;
    let ready = false;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The CLI and its process group have already exited.
      }
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output });
    };
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (process.env.DEBUG) process.stderr.write(text);
      if (!ready && DONE.test(output) && /https?:\/\//.test(output)) {
        ready = true;
        killGroup("SIGINT");
        setTimeout(() => killGroup("SIGKILL"), 15_000).unref();
      }
      // A failed run leaves `dev` waiting for a file change that never
      // comes; fail now instead of at the timeout.
      if (!ready && output.includes("alchemy dev: run failed")) {
        killGroup("SIGKILL");
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (exitCode) => finish(ready ? 0 : exitCode));
    const timer = setTimeout(() => {
      output += `\nTimed out after ${timeoutMs / 1000}s waiting for alchemy dev to become ready.`;
      killGroup("SIGKILL");
    }, timeoutMs);
  });

const assertSuccess = (
  name: "dev" | "deploy" | "destroy",
  result: CommandResult,
) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${example}: alchemy ${name} failed (exit ${result.exitCode ?? "signal"})\n${result.output}`,
    );
  }
};

const assertOutput = (
  name: "dev" | "deploy" | "destroy",
  result: CommandResult,
  expected: readonly RegExp[],
) => {
  for (const pattern of expected) {
    if (!pattern.test(result.output)) {
      throw new Error(
        `${example}: alchemy ${name} output did not match ${pattern}\n${result.output}`,
      );
    }
  }
};

let primaryFailure: unknown;
try {
  const dev = await runDev();
  assertSuccess("dev", dev);
  assertOutput("dev", dev, [new RegExp(`Dev · ${stage}`), DONE, /https?:\/\//]);

  if (!devOnly) {
    const deployed = await run("deploy");
    assertSuccess("deploy", deployed);
    assertOutput("deploy", deployed, [
      new RegExp(`Deploy · ${stage}`),
      DONE,
      /https?:\/\//,
    ]);
  }
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    const destroyed = await run("destroy");
    if (destroyed.exitCode !== 0 && primaryFailure === undefined) {
      primaryFailure = new Error(
        `${example}: alchemy destroy failed (exit ${destroyed.exitCode ?? "signal"})\n${destroyed.output}`,
      );
    } else if (destroyed.exitCode !== 0) {
      console.error(
        `${example}: cleanup destroy also failed\n${destroyed.output}`,
      );
    } else if (primaryFailure === undefined) {
      assertOutput("destroy", destroyed, [
        new RegExp(`Destroy · ${stage}`),
        DONE,
      ]);
    }
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = error;
    else console.error(`${example}: cleanup destroy failed`, error);
  } finally {
    if (alchemyHome !== undefined) {
      fs.rmSync(alchemyHome, { recursive: true, force: true });
    }
  }
}

if (primaryFailure !== undefined) throw primaryFailure;
