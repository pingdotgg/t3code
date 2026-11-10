import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Alchemist from "../../Alchemist/index.ts";
import { paint } from "../../Util/Terminal.ts";
import { formatLocalTimestamp, TAIL_COLORS } from "../Format.ts";
import { config, envFile, parseSince, profile, resolveStage, stage } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const logsLimit = Flag.Int("limit").pipe(
  Flag.withDescription("Number of log entries to fetch (default: 100)"),
  Flag.withDefault(100),
);

const tail = Flag.Boolean("tail").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Continue streaming new log entries"),
  Flag.withDefault(false),
);

const resources = Flag.String("resource").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Comma-separated logical resource IDs to include (for example Worker,Api)"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const logsSince = Flag.String("since").pipe(
  Flag.withDescription("Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

interface LogsArgs {
  readonly main: string;
  readonly stage: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string | undefined;
  readonly resources: string | undefined;
  readonly limit: number;
  readonly since: string | undefined;
  readonly tail: boolean;
}

const runLogs = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  resources,
  limit,
  since,
  tail,
}: LogsArgs) {
  const sinceDate = since ? yield* parseSince(since) : undefined;
  const selected = (resources ?? "")
    .split(",")
    .map((resource) => resource.trim())
    .filter((resource) => resource.length > 0);
  const stack = yield* Alchemist.importStack(main);
  const options = { stage, profile, envFile: Option.getOrUndefined(envFile) };
  // Colors are assigned as each resource first appears, so the command
  // builds the stack once instead of listing resources up front.
  const colors = new Map<string, (typeof TAIL_COLORS)[number]>();
  const format = (entry: Alchemist.Logs.LogEntry) => {
    const fqn = entry.resource.fqn;
    if (!colors.has(fqn)) colors.set(fqn, TAIL_COLORS[colors.size % TAIL_COLORS.length]!);
    return `${paint(colors.get(fqn)!, `${formatLocalTimestamp(entry.timestamp)} [${fqn}]`)} ${entry.message}`;
  };

  if (tail) {
    // The merged stream ends at once when no selected resource can tail.
    let received = false;
    yield* Alchemist.Logs.tail({ ...options, stack, resources: selected }).pipe(
      Stream.runForEach((entry) => {
        received = true;
        return Console.log(format(entry));
      }),
    );
    if (!received) yield* Console.log("No matching resources support live logs.");
    return;
  }

  const entries = yield* Alchemist.Logs.entries({
    ...options,
    stack,
    resources: selected,
    limit,
    since: sinceDate,
  });
  if (entries.length === 0) {
    yield* Console.log(
      selected.length > 0
        ? "No resources with logs match --resource (deploy first, or selected resources may not expose logs)."
        : "No resources with logs found. Deploy first, then run logs.",
    );
    return;
  }
  for (const entry of entries) yield* Console.log(format(entry));
});

export const logsCommand = Command.make(
  "logs",
  {
    main: config,
    envFile,
    stage,
    profile,
    resources,
    limit: logsLimit,
    since: logsSince,
    tail,
  },
  (args) =>
    resolveStage("live", args.stage, args.envFile).pipe(
      Effect.flatMap((stage) =>
        instrumentCommand("logs", (a: LogsArgs) => ({
          "alchemy.stage": a.stage,
          "alchemy.profile": a.profile ?? "",
          "alchemy.main": a.main,
          "alchemy.limit": a.limit,
          "alchemy.tail": a.tail,
        }))(runLogs)({ ...args, stage }),
      ),
    ),
).pipe(Command.withDescription("Fetch or tail logs from stack resources"));
