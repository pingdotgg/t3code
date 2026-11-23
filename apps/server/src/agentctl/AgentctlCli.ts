import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { AgentResourceList, SshInfo, type AgentResource } from "./agentState.ts";

// T3 talks to agentctl only through its CLI and `-o json` output. The daemon's
// control socket is private: its protocol is versioned per build.

/**
 * An agentctl command that did not succeed. Its message reaches the UI: for a
 * command agentctl rejected, that is agentctl's own one-line error.
 */
export class AgentctlError extends Schema.TaggedError<AgentctlError>()("AgentctlError", {
  /** The subcommand, such as `get` or `apply`. */
  command: Schema.String,
  reason: Schema.Literals(["unavailable", "failed", "timeout", "unexpected-output", "unsupported"]),
  /** agentctl's own error line, for a command it rejected. */
  reported: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Could not run agentctl. Install it and make sure it is on PATH.";
      case "failed":
        return this.reported ?? `agentctl ${this.command} failed.`;
      case "timeout":
        return `agentctl ${this.command} timed out.`;
      case "unexpected-output":
        return `agentctl ${this.command} printed output T3 Code does not understand.`;
      case "unsupported":
        return `This agentctl has no \`${this.command}\`. Update agentctl.`;
    }
  }
}

/** What `get agents --watch` reports: the Agents each time they change, or trouble it retries. */
export type AgentctlWatchEvent =
  | { readonly _tag: "Agents"; readonly agents: ReadonlyArray<AgentResource> }
  | { readonly _tag: "Trouble"; readonly message: string };

export interface AgentctlApplyInput {
  readonly manifestPath: string;
  readonly name: string;
}

export class AgentctlCli extends Context.Service<
  AgentctlCli,
  {
    readonly listAgents: Effect.Effect<ReadonlyArray<AgentResource>, AgentctlError>;
    /**
     * Follows the Agents until agentctl ends the watch, such as once agentd is upgraded. It never
     * starts agentd. Fails as `unsupported` for an agentctl older than `get --watch`.
     */
    readonly watchAgents: Stream.Stream<AgentctlWatchEvent, AgentctlError>;
    readonly sshInfo: (name: string) => Effect.Effect<SshInfo, AgentctlError>;
    readonly start: (name: string) => Effect.Effect<void, AgentctlError>;
    readonly stop: (name: string) => Effect.Effect<void, AgentctlError>;
    readonly remove: (name: string) => Effect.Effect<void, AgentctlError>;
    /** Applies without waiting; provisioning progress shows up in `listAgents`. */
    readonly apply: (input: AgentctlApplyInput) => Effect.Effect<void, AgentctlError>;
  }
>()("t3/agentctl/AgentctlCli") {}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * agentctl prints `agentctl: <message>` for every error. Provisioning output can
 * precede it on stderr, so the last such line wins.
 */
export function agentctlErrorMessage(result: CommandResult): string {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reported = lines.findLast((line) => line.startsWith("agentctl: "));
  if (reported !== undefined) return reported.slice("agentctl: ".length);
  return lines.at(-1) ?? `agentctl exited with code ${result.exitCode}`;
}

const QUERY_TIMEOUT = Duration.seconds(30);
// `start` and `stop` wait for the Sandbox; agentctl's own default is 10 minutes.
const LIFECYCLE_TIMEOUT = Duration.minutes(11);

const WATCH_AGENTS_ARGS = ["get", "agents", "--watch", "-o", "json"];

/** clap's wording when this agentctl predates `get --watch`. */
const isUnknownWatchFlag = (stderr: string) => /unexpected argument '--watch'/u.test(stderr);

const decodeAgents = Schema.decodeEffect(Schema.fromJsonString(AgentResourceList));

const nonEmptyLines = <E>(bytes: Stream.Stream<Uint8Array, E>) =>
  bytes.pipe(
    Stream.mapError((cause) => new AgentctlError({ command: "get", reason: "failed", cause })),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => line.trim()),
    Stream.filter((line) => line.length > 0),
  );

const decodeUtf8 = (chunks: ReadonlyArray<Uint8Array>) => {
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
};

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = (args: ReadonlyArray<string>, timeout: Duration.Duration) => {
    const command = args[0] ?? "";
    return Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolveSpawnCommand("agentctl", args);
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              shell: resolved.shell,
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) => new AgentctlError({ command, reason: "unavailable", cause }),
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((cause) => new AgentctlError({ command, reason: "failed", cause })));
        return {
          exitCode,
          stdout: decodeUtf8(stdout),
          stderr: decodeUtf8(stderr),
        } satisfies CommandResult;
      }),
    ).pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentctlError({ command, reason: "timeout" })),
          onSome: Effect.succeed,
        }),
      ),
    );
  };

  const runChecked = (args: ReadonlyArray<string>, timeout = QUERY_TIMEOUT) =>
    run(args, timeout).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new AgentctlError({
                command: args[0] ?? "",
                reason: "failed",
                reported: agentctlErrorMessage(result),
              }),
            ),
      ),
    );

  const runJson = <A>(
    decode: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
    args: ReadonlyArray<string>,
  ) =>
    runChecked(args).pipe(
      Effect.flatMap((stdout) =>
        decode(stdout).pipe(
          Effect.mapError(
            (cause) =>
              new AgentctlError({ command: args[0] ?? "", reason: "unexpected-output", cause }),
          ),
        ),
      ),
    );

  // Each line is the whole list, as `get agents -o json` prints it, so a missed one needs no recovery.
  const watchAgents = Stream.unwrap(
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand("agentctl", WATCH_AGENTS_ARGS);
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            shell: resolved.shell,
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new AgentctlError({ command: "get", reason: "unavailable", cause }),
          ),
        );
      const stderr: string[] = [];
      const agents = nonEmptyLines(handle.stdout).pipe(
        Stream.mapEffect((line) =>
          decodeAgents(line).pipe(
            Effect.map((listed): AgentctlWatchEvent => ({ _tag: "Agents", agents: listed })),
            Effect.mapError(
              (cause) => new AgentctlError({ command: "get", reason: "unexpected-output", cause }),
            ),
          ),
        ),
      );
      // agentctl reports a failure it keeps retrying once, until the watch recovers.
      const trouble = nonEmptyLines(handle.stderr).pipe(
        Stream.tap((line) => Effect.sync(() => stderr.push(line))),
        Stream.filter((line) => line.startsWith("agentctl: ")),
        Stream.map((line): AgentctlWatchEvent => ({
          _tag: "Trouble",
          message: line.slice("agentctl: ".length),
        })),
      );
      const ended = handle.exitCode.pipe(
        Effect.mapError((cause) => new AgentctlError({ command: "get", reason: "failed", cause })),
        Effect.flatMap((exitCode) => {
          if (exitCode === 0) return Effect.void;
          const result = { exitCode, stdout: "", stderr: stderr.join("\n") };
          return Effect.fail(
            isUnknownWatchFlag(result.stderr)
              ? new AgentctlError({ command: "get --watch", reason: "unsupported" })
              : new AgentctlError({
                  command: "get",
                  reason: "failed",
                  reported: agentctlErrorMessage(result),
                }),
          );
        }),
      );
      return Stream.merge(agents, trouble).pipe(
        Stream.concat(Stream.drain(Stream.fromEffect(ended))),
      );
    }),
  );

  return AgentctlCli.of({
    listAgents: runJson(decodeAgents, ["get", "agents", "-o", "json"]),
    watchAgents,
    sshInfo: Effect.fn("AgentctlCli.sshInfo")(function (name) {
      return runJson(Schema.decodeEffect(Schema.fromJsonString(SshInfo)), [
        "ssh-info",
        name,
        "-o",
        "json",
      ]);
    }),
    start: Effect.fn("AgentctlCli.start")(function (name) {
      return runChecked(["start", `agent/${name}`], LIFECYCLE_TIMEOUT).pipe(Effect.asVoid);
    }),
    stop: Effect.fn("AgentctlCli.stop")(function (name) {
      return runChecked(["stop", `agent/${name}`], LIFECYCLE_TIMEOUT).pipe(Effect.asVoid);
    }),
    remove: Effect.fn("AgentctlCli.remove")(function (name) {
      return runChecked(["delete", `agent/${name}`]).pipe(Effect.asVoid);
    }),
    // agentctl reads values from the `.env` beside the manifest.
    apply: Effect.fn("AgentctlCli.apply")(function ({ manifestPath, name }) {
      return runChecked(["apply", "-f", manifestPath, "--name", name]).pipe(Effect.asVoid);
    }),
  });
});

export const layer = Layer.effect(AgentctlCli, make);
