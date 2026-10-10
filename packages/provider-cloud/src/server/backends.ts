/**
 * The two cloud runtimes behind one shape: start remote work from a prompt,
 * wait for it, and say what happened. Each backend drives its provider's
 * own CLI, so sign-in, environments, and repository access stay the CLI's.
 *
 * @module provider-cloud/server/backends
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CloudCliError, lastLine, type CloudCli } from "./cli.ts";

export interface CloudTask {
  readonly id: string;
  readonly url: string;
}

export interface CloudRunInput {
  readonly cwd: string;
  readonly prompt: string;
  /** The cloud session earlier turns of this thread ran in, for runtimes that continue one. */
  readonly session: string | undefined;
  /** Called once the remote task exists, before the run waits on it. */
  readonly onTask: (task: CloudTask) => Effect.Effect<void>;
}

export interface CloudRunResult {
  readonly task: CloudTask;
  /** What the thread shows as the agent's reply. */
  readonly text: string;
  /** The cloud session later turns continue, when the runtime keeps one. */
  readonly session?: string;
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
 * Codex Cloud: each turn submits a task to the configured environment, polls
 * it until Codex finishes, then applies the task's diff to the thread's
 * workspace so it lands like any local turn's changes.
 */
export const makeCodexCloudBackend = (options: {
  readonly cli: CloudCli;
  readonly environment: string;
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
      if (!options.environment)
        return yield* fail(
          "Set the Codex Cloud environment in this provider's settings. Run codex cloud to list yours.",
        );
      const submitted = yield* cli({
        args: ["cloud", "exec", "--env", options.environment, "--", input.prompt],
        cwd: input.cwd,
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
          task,
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
        task,
        text: `**${title}** finished in Codex Cloud. Its changes${summary} are applied to this workspace.\n\n${task.url}`,
      };
    }),
  };
};

const ClaudeCloudOutput = Schema.Union([
  // Created and waited for the result: the same shape as a local `-p` result.
  Schema.Struct({
    type: Schema.Literal("result"),
    is_error: Schema.Boolean,
    result: Schema.optional(Schema.String),
    session_id: Schema.String,
    session_url: Schema.optional(Schema.String),
  }),
  // Created or messaged without waiting.
  Schema.Struct({
    ok: Schema.Literal(true),
    session_id: Schema.String,
    url: Schema.String,
    title: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.optional(Schema.String) }),
]);
const decodeClaudeCloudOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeCloudOutput),
);

// Printed on stderr as soon as `claude -p --cloud` has a session, before it waits.
const CLAUDE_SESSION_LINE = /^Cloud session: (\S+) \((https?:\/\/\S+)\)$/;

/** The session a `claude -p --cloud` stderr line announces. */
const parseClaudeSessionLine = (line: string): CloudTask | undefined => {
  const match = CLAUDE_SESSION_LINE.exec(line.trim());
  return match?.[1] && match[2] ? { id: match[1], url: match[2] } : undefined;
};

const claudeSessionUrl = (id: string) => `https://claude.ai/code/${id}`;

/**
 * Claude Code Cloud: the first turn creates a cloud session for the thread's
 * repository, and later turns message that same session. Claude Code waits
 * for the cloud reply where the account supports it; otherwise the turn ends
 * once the message is delivered and the session keeps working on claude.ai.
 */
export const makeClaudeCloudBackend = (options: { readonly cli: CloudCli }): CloudBackend => ({
  label: "Claude Code Cloud",
  run: Effect.fnUntraced(function* (input) {
    let announced: CloudTask | undefined;
    const result = yield* options.cli({
      args: ["-p", "--output-format", "json", "--cloud", ...(input.session ? [input.session] : [])],
      cwd: input.cwd,
      stdin: input.prompt,
      onStderrLine: (line) => {
        const task = announced ? undefined : parseClaudeSessionLine(line);
        if (!task) return Effect.void;
        announced = task;
        return input.onTask(task);
      },
    });
    const line = lastLine(result.stdout);
    const output = line === undefined ? undefined : decodeClaudeCloudOutput(line);
    if (output === undefined || output._tag === "None")
      return yield* failure("Claude Code could not reach the cloud session.", result);
    const parsed = output.value;
    if ("type" in parsed) {
      const task = {
        id: parsed.session_id,
        url: parsed.session_url ?? announced?.url ?? claudeSessionUrl(parsed.session_id),
      };
      if (!announced) yield* input.onTask(task);
      if (parsed.is_error)
        return yield* fail(`${parsed.result || "The cloud session failed."} (${task.url})`);
      return { task, session: task.id, text: parsed.result ?? "" };
    }
    if (!parsed.ok)
      return yield* fail(parsed.error ?? lastLine(result.stderr) ?? "Claude Code Cloud failed.");
    const task = { id: parsed.session_id, url: parsed.url };
    yield* input.onTask(task);
    return {
      task,
      session: task.id,
      text: input.session
        ? `Sent to the Claude Code Cloud session. It replies there: ${task.url}`
        : `Started ${parsed.title ? `**${parsed.title}**` : "a session"} in Claude Code Cloud. Follow its progress there, and send follow-ups from here: ${task.url}`,
    };
  }),
});
