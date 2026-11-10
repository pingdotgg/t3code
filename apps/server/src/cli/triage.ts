// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadlinePromises from "node:readline/promises";

import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { buildTriageLaunchPrompt } from "../triage/triagePrompt.ts";
import { describeServerProcess, writeTriageSession } from "../triage/triageSession.ts";
import { baseDirFlag } from "./config.ts";
import { interactiveStdin } from "./consoleStdin.ts";
import { resolveCliCommand } from "./invocation.ts";

interface TriageAgent {
  readonly id: "claude" | "codex";
  readonly command: string;
  readonly label: string;
}

const TRIAGE_AGENTS: ReadonlyArray<TriageAgent> = [
  { id: "claude", command: "claude", label: "Claude Code" },
  { id: "codex", command: "codex", label: "Codex" },
];

export class TriageAgentUnavailableError extends Schema.TaggedError<TriageAgentUnavailableError>()(
  "TriageAgentUnavailableError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `\`${this.agent}\` is not installed or was not found on PATH.`;
  }
}

export class TriageAgentChoiceRequiredError extends Schema.TaggedError<TriageAgentChoiceRequiredError>()(
  "TriageAgentChoiceRequiredError",
  {},
) {
  override get message(): string {
    return "Both claude and codex are installed and there is no terminal to ask which to use. Re-run with --agent claude or --agent codex.";
  }
}

export class TriageAgentSpawnError extends Schema.TaggedError<TriageAgentSpawnError>()(
  "TriageAgentSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not start \`${this.command}\`.`;
  }
}

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

const runInteractiveSession = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
  readonly cwd: string;
}) =>
  Effect.callback<number, TriageAgentSpawnError>((resume) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      // The Windows desktop launcher supplies terminal input through the reopened console.
      stdio: [interactiveStdin(), "inherit", "inherit"],
      shell: input.shell,
    });
    child.once("error", (cause) =>
      resume(Effect.fail(new TriageAgentSpawnError({ command: input.command, cause }))),
    );
    child.once("exit", (code, signal) => resume(Effect.succeed(code ?? (signal === null ? 0 : 1))));
  });

const agentFlag = Flag.Literals("agent", ["claude", "codex"]).pipe(
  Flag.withDescription("Agent CLI to use. Default: ask when both are installed."),
  Flag.optional,
);

const modelFlag = Flag.String("model").pipe(
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
      // Triage is a user-facing feature: always the userdata state, never dev.
      const explicitBaseDir = Option.getOrUndefined(flags.baseDir);
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(explicitBaseDir ?? Option.getOrUndefined(envHome));
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});

      const session = yield* writeTriageSession({
        baseDir,
        paths,
        entry: {
          kind: "cli",
          cliVersion: packageJson.version,
          launchedAs: yield* resolveCliCommand("triage"),
        },
        server: yield* describeServerProcess(paths.serverRuntimeStatePath),
      });

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
        // The picker needs terminal output too, or its invisible prompt hangs.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          return yield* new TriageAgentChoiceRequiredError();
        }
        selected = yield* pickAgent(installed);
      }

      // Windows .cmd shims cannot carry multiline argv; the prompt file also serves as the paste fallback.
      const { sessionDir, promptFilePath, contextFilePath } = session;

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
      const exitCode = yield* runInteractiveSession({ ...spawnSpec, cwd: sessionDir });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    }),
  ),
);
