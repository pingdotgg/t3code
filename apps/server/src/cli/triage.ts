/**
 * `t3 triage` - hand a misbehaving install to the user's own coding agent.
 *
 * The command is deliberately thin: it writes a `context.md` with machine facts
 * (version, paths, server liveness), then launches claude or codex
 * interactively, seeded with the playbook from `triagePrompt.ts`. The agent
 * asks the user what went wrong, investigates, and files the issue; the
 * harness's own permission prompts gate anything it wants to run. With no
 * agent CLI installed, the prompt and context are written to disk for the user
 * to paste into whatever agent they do have.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeReadlinePromises from "node:readline/promises";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";
import { resolveCliCommand } from "./invocation.ts";
import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
} from "./triagePrompt.ts";

interface TriageAgent {
  readonly id: "claude" | "codex";
  readonly command: string;
  readonly label: string;
}

const TRIAGE_AGENTS: ReadonlyArray<TriageAgent> = [
  { id: "claude", command: "claude", label: "Claude Code" },
  { id: "codex", command: "codex", label: "Codex" },
];

export class TriageAgentUnavailableError extends Schema.TaggedErrorClass<TriageAgentUnavailableError>()(
  "TriageAgentUnavailableError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `\`${this.agent}\` is not installed or was not found on PATH.`;
  }
}

export class TriageAgentChoiceRequiredError extends Schema.TaggedErrorClass<TriageAgentChoiceRequiredError>()(
  "TriageAgentChoiceRequiredError",
  {},
) {
  override get message(): string {
    return "Both claude and codex are installed and there is no terminal to ask which to use. Re-run with --agent claude or --agent codex.";
  }
}

export class TriageAgentSpawnError extends Schema.TaggedErrorClass<TriageAgentSpawnError>()(
  "TriageAgentSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not start \`${this.command}\`.`;
  }
}

/** One human-readable line about the local server, for `context.md`. */
const describeServerProcess = Effect.fn("triage.describeServerProcess")(function* (
  serverRuntimeStatePath: string,
) {
  // readPersistedServerRuntimeState swallows read/decode failures itself and
  // returns none, so a corrupt state file reads as "not running" here.
  const state = yield* readPersistedServerRuntimeState(serverRuntimeStatePath);
  if (Option.isNone(state)) {
    return "not running (no server-runtime.json; the server may never have started here)";
  }
  if (!isProcessAlive(state.value.pid)) {
    return `not running (state file is stale: pid ${String(state.value.pid)} is dead; last origin ${state.value.origin})`;
  }
  return `running (pid ${String(state.value.pid)}, ${state.value.origin})`;
});

const pickAgent = (agents: ReadonlyArray<TriageAgent>) =>
  Effect.promise(async () => {
    const readline = NodeReadlinePromises.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const menu = agents
        .map((agent, index) => `  [${String(index + 1)}] ${agent.label}`)
        .join("\n");
      for (;;) {
        const answer = (await readline.question(`Run triage with:\n${menu}\n> `)).trim();
        const byNumber = agents[Number.parseInt(answer, 10) - 1];
        if (byNumber !== undefined) {
          return byNumber;
        }
        const byId = agents.find((agent) => agent.id === answer.toLowerCase());
        if (byId !== undefined) {
          return byId;
        }
      }
    } finally {
      readline.close();
    }
  });

/**
 * Run the agent CLI as a normal interactive session: the user's terminal is
 * the UI, and the harness's own permission prompts gate every action. Resolves
 * with the child's exit code.
 */
const runInteractiveSession = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
  readonly cwd: string;
}) =>
  Effect.callback<number, TriageAgentSpawnError>((resume) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      stdio: "inherit",
      shell: input.shell,
    });
    child.once("error", (cause) =>
      resume(Effect.fail(new TriageAgentSpawnError({ command: input.command, cause }))),
    );
    // Signal death has no exit code; report failure rather than success.
    child.once("exit", (code, signal) => resume(Effect.succeed(code ?? (signal === null ? 0 : 1))));
  });

const agentFlag = Flag.choice("agent", ["claude", "codex"]).pipe(
  Flag.withDescription("Agent CLI to use. Default: ask when both are installed."),
  Flag.optional,
);

const modelFlag = Flag.string("model").pipe(
  Flag.withDescription("Model passed through to the agent CLI. Default: the agent's default."),
  Flag.optional,
);

export const triageCommand = Command.make("triage", {
  baseDir: baseDirFlag,
  agent: agentFlag,
  model: modelFlag,
}).pipe(
  Command.withDescription(
    "Investigate a T3 Code problem on this machine with claude or codex, and help file a good issue.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Triage is a user-facing feature: always the userdata state, never dev.
      // --base-dir wins; T3CODE_HOME is its documented env equivalent (same
      // precedence as `t3 pair`).
      const explicitBaseDir = Option.getOrUndefined(flags.baseDir);
      const envHome = yield* Config.string("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(explicitBaseDir ?? Option.getOrUndefined(envHome));
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});

      const now = yield* DateTime.now;
      const scratchDir = path.join(
        paths.stateDir,
        "triage",
        // ISO instant, made safe for Windows paths.
        DateTime.formatIso(now).replaceAll(":", "-").replace(".", "-"),
      );
      yield* fs.makeDirectory(scratchDir, { recursive: true });

      const version = packageJson.version;
      const contextFilePath = path.join(scratchDir, "context.md");
      yield* fs.writeFileString(
        contextFilePath,
        buildTriageContext({
          generatedAt: DateTime.formatIso(now),
          version,
          releaseTag: version.includes("-nightly.")
            ? `v${version} (nightly build; if this tag does not exist, clone main)`
            : `v${version}`,
          os: `${yield* HostProcessPlatform} ${yield* HostProcessArchitecture} (${NodeOS.release()})`,
          nodeVersion: process.version,
          launchedAs: yield* resolveCliCommand("triage"),
          server: yield* describeServerProcess(paths.serverRuntimeStatePath),
          paths: {
            stateDir: paths.stateDir,
            dbPath: paths.dbPath,
            settingsPath: paths.settingsPath,
            logsDir: paths.logsDir,
            serverLogPath: paths.serverLogPath,
            serverTracePath: paths.serverTracePath,
            providerEventLogPath: paths.providerEventLogPath,
            terminalLogsDir: paths.terminalLogsDir,
            providerStatusCacheDir: paths.providerStatusCacheDir,
            secretsDir: paths.secretsDir,
            sourceCacheDir: path.join(baseDir, "source"),
          },
        }),
      );

      const installed: Array<TriageAgent> = [];
      for (const agent of TRIAGE_AGENTS) {
        if (yield* isCommandAvailable(agent.command)) {
          installed.push(agent);
        }
      }

      const requested = Option.getOrUndefined(flags.agent);
      let selected: TriageAgent | undefined;
      if (requested !== undefined) {
        selected = installed.find((agent) => agent.id === requested);
        if (selected === undefined) {
          return yield* new TriageAgentUnavailableError({ agent: requested });
        }
      } else if (installed.length === 1) {
        selected = installed[0];
      } else if (installed.length > 1) {
        // Both streams must be terminals: with stdout redirected the picker
        // prompt is invisible and the command would hang waiting on it.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          return yield* new TriageAgentChoiceRequiredError();
        }
        selected = yield* pickAgent(installed);
      }

      // The full seed prompt always goes to disk. The agent is launched with a
      // one-line pointer at it: Windows `.cmd` shims run through cmd.exe,
      // which cannot carry the multiline playbook as an argv string, and with
      // no agent installed the same file is the paste-anywhere fallback.
      const promptFilePath = path.join(scratchDir, "prompt.md");
      yield* fs.writeFileString(promptFilePath, buildTriageSeedPrompt(contextFilePath));

      if (selected === undefined) {
        yield* Console.log(
          [
            "No supported agent CLI (claude, codex) was found on this machine.",
            "",
            "The triage prompt and machine context were written to:",
            `  ${promptFilePath}`,
            `  ${contextFilePath}`,
            "",
            "Paste the prompt file into any coding agent to run triage by hand.",
          ].join("\n"),
        );
        return;
      }

      const model = Option.getOrUndefined(flags.model);
      const spawnSpec = yield* resolveSpawnCommand(selected.command, [
        ...(model === undefined ? [] : ["--model", model]),
        buildTriageLaunchPrompt(promptFilePath),
      ]);
      yield* Console.log(`Starting ${selected.label}. It will ask what went wrong.\n`);
      const exitCode = yield* runInteractiveSession({ ...spawnSpec, cwd: scratchDir });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    }),
  ),
);
