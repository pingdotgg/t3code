import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import * as Logs from "../../Alchemist/routes/logs.ts";
import { paint } from "../CliKit/index.ts";
import { formatLocalTimestamp, TAIL_COLORS } from "../Format.ts";
import {
  config,
  envFile,
  parseSince,
  profile,
  resolveStage,
  stage,
} from "./flags.ts";
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
  Flag.withDescription(
    "Comma-separated logical resource IDs to include (for example Worker,Api)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const logsSince = Flag.String("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
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
  const target = {
    entrypoint: main,
    stage,
    profile,
    envFile: Option.getOrUndefined(envFile),
  };
  const available = yield* Logs.resources(target);
  const selectedSet = new Set(selected);
  const matching = available.filter(
    (resource) =>
      selectedSet.size === 0 ||
      selectedSet.has(resource.fqn) ||
      selectedSet.has(resource.logicalId),
  );
  const colors = new Map(
    matching.map((resource, index) => [
      resource.fqn,
      TAIL_COLORS[index % TAIL_COLORS.length]!,
    ]),
  );
  const format = (entry: {
    resource: { fqn: string };
    timestamp: Date;
    message: string;
  }) =>
    `${paint(colors.get(entry.resource.fqn) ?? "gray", `${formatLocalTimestamp(entry.timestamp)} [${entry.resource.fqn}]`)} ${entry.message}`;

  if (tail) {
    const tailing = matching.filter((resource) => resource.supportsTail);
    if (tailing.length === 0) {
      yield* Console.log("No matching resources support live logs.");
      return;
    }
    yield* Console.log(
      `Tailing: ${tailing.map(({ logicalId }) => logicalId).join(", ")}`,
    );
    yield* Logs.tail({ target, resources: selected }).pipe(
      Stream.runForEach((entry) => Console.log(format(entry))),
    );
    return;
  }

  const entries = yield* Logs.entries({
    target,
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
