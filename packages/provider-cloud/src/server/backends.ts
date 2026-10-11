/**
 * A cloud runtime behind one shape: start remote work from a prompt, wait for
 * it, and say what happened. The backend drives its provider's own CLI, so
 * sign-in, environments, and repository access stay the CLI's.
 *
 * @module provider-cloud/server/backends
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { CloudCliError, lastLine, type CloudCli } from "./cli.ts";

export interface CloudTask {
  readonly id: string;
  readonly url: string;
}

export interface CloudRunInput {
  readonly cwd: string;
  readonly prompt: string;
  /** The Codex Cloud environment the thread chose, for runtimes that need one. */
  readonly cloudEnvironment?: string;
  /** Called once the remote task exists, before the run waits on it. */
  readonly onTask: (task: CloudTask) => Effect.Effect<void>;
}

export interface CloudRunResult {
  /** What the thread shows as the agent's reply. */
  readonly text: string;
}

export interface CloudBackend {
  /** Product name used in messages, such as "Codex Cloud". */
  readonly label: string;
  readonly run: (input: CloudRunInput) => Effect.Effect<CloudRunResult, CloudCliError>;
}

const fail = (detail: string) => Effect.fail(new CloudCliError({ detail }));

const failure = (fallback: string, output: { stdout: string; stderr: string }) =>
  fail(lastLine(output.stderr) ?? lastLine(output.stdout) ?? fallback);

// `codex cloud status` prints `[STATUS] title`, then environment and age, then the diff summary.
const CODEX_STATUS_LINE = /^\[(PENDING|READY|APPLIED|ERROR)\]\s*(.*)$/;

type CodexTaskStatus = {
  readonly state: "PENDING" | "READY" | "APPLIED" | "ERROR";
  readonly title: string;
  /** `no diff`, or the added and removed line counts. */
  readonly summary: string | undefined;
};

/** Reads `codex cloud status` output; `undefined` when it is not a status report. */
const parseCodexStatus = (stdout: string): CodexTaskStatus | undefined => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const match = lines[0] && CODEX_STATUS_LINE.exec(lines[0]);
  if (!match) return undefined;
  return {
    state: match[1] as CodexTaskStatus["state"],
    title: match[2] ?? "",
    summary: lines[2],
  };
};

/** The task `codex cloud exec` created, from the task URL it prints last. */
const parseCodexTask = (stdout: string): CloudTask | undefined => {
  const url = stdout
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => /^https?:\/\//.test(line));
  const id = url
    ?.split(/[?#]/)[0]
    ?.split("/")
    .findLast((part) => part.length > 0);
  return url && id ? { id, url } : undefined;
};

/**
 * Codex Cloud: each turn submits a task to the thread's environment, polls
 * it until Codex finishes, then applies the task's diff to the thread's
 * workspace so it lands like any local turn's changes.
 */
export const makeCodexCloudBackend = (options: {
  readonly cli: CloudCli;
  /** Resolves the environment a thread asked for to the id `codex cloud exec` takes. */
  readonly resolveEnvironment?: (environment: string) => Effect.Effect<string, CloudCliError>;
  readonly pollInterval?: Duration.Input;
}): CloudBackend => {
  const { cli } = options;
  const pollInterval = options.pollInterval ?? Duration.seconds(10);
  const status = (cwd: string, task: CloudTask) =>
    cli({ args: ["cloud", "status", task.id], cwd }).pipe(
      Effect.flatMap((result) => {
        const parsed = parseCodexStatus(result.stdout);
        return parsed ? Effect.succeed(parsed) : failure("Codex Cloud status failed.", result);
      }),
    );
  return {
    label: "Codex Cloud",
    run: Effect.fnUntraced(function* (input) {
      if (!input.cloudEnvironment)
        return yield* fail("Choose a Codex Cloud environment from Run on before sending.");
      const environment = options.resolveEnvironment
        ? yield* options.resolveEnvironment(input.cloudEnvironment)
        : input.cloudEnvironment;
      // `-` reads the prompt from stdin, so no prompt text is ever parsed as an argument.
      const submitted = yield* cli({
        args: ["cloud", "exec", "--env", environment, "-"],
        cwd: input.cwd,
        stdin: input.prompt,
      });
      const task = submitted.code === 0 ? parseCodexTask(submitted.stdout) : undefined;
      if (!task) return yield* failure("Codex Cloud did not accept the task.", submitted);
      yield* input.onTask(task);

      let current = yield* status(input.cwd, task);
      while (current.state === "PENDING") {
        yield* Effect.sleep(pollInterval);
        current = yield* status(input.cwd, task);
      }
      const title = current.title || "The task";
      if (current.state === "ERROR")
        return yield* fail(
          `Codex Cloud could not finish the task. Open it for details: ${task.url}`,
        );
      if (current.summary === "no diff")
        return {
          text: `**${title}** finished in Codex Cloud with no changes.\n\n${task.url}`,
        };

      const applied = yield* cli({ args: ["cloud", "apply", task.id], cwd: input.cwd });
      if (applied.code !== 0)
        return yield* fail(
          `Codex Cloud finished, but its changes did not apply here: ${
            lastLine(applied.stdout) ?? lastLine(applied.stderr) ?? "git apply failed"
          }. Open the task: ${task.url}`,
        );
      const summary = current.summary ? ` (${current.summary})` : "";
      return {
        text: `**${title}** finished in Codex Cloud. Its changes${summary} are applied to this workspace.\n\n${task.url}`,
      };
    }),
  };
};
