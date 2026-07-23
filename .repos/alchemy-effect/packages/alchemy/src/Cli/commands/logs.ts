import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { findProviderByType, type LogLine } from "../../Provider.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import {
  envFile,
  formatLocalTimestamp,
  importStack,
  instrumentCommand,
  parseResourceFilter,
  parseSince,
  profile,
  resourceFilter,
  script,
  stage,
  TAIL_COLORS,
  TAIL_RESET,
} from "./_shared.ts";

const logsLimit = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch"),
  Flag.withDefault(100),
);

const logsSince = Flag.string("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const logsCommand = Command.make(
  "logs",
  {
    main: script,
    envFile,
    stage,
    profile,
    filter: resourceFilter,
    limit: logsLimit,
    since: logsSince,
  },
  instrumentCommand(
    "logs",
    (a: { main: string; stage: string; profile: string; limit: number }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fnUntraced(function* ({
      main,
      stage,
      envFile,
      profile,
      filter,
      limit,
      since,
    }) {
      const stackEffect = yield* importStack(main);

      const services = Layer.mergeAll(
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Layer.succeed(AuthProviders, {}),
        Layer.succeed(Stage, stage),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        State.localState(),
      );

      const sinceDate = since ? parseSince(since) : undefined;

      yield* Effect.gen(function* () {
        const stack = yield* stackEffect;

        yield* Effect.gen(function* () {
          const state = yield* yield* State.State;
          const filterSet = parseResourceFilter(filter);
          const availableIds = [
            ...new Set(Object.values(stack.resources).map((r) => r.LogicalId)),
          ].sort();

          if (filterSet) {
            for (const id of filterSet) {
              if (!availableIds.includes(id)) {
                return yield* Effect.die(
                  new Error(
                    `Unknown resource '${id}' in --filter. Available: ${availableIds.join(", ") || "(none)"}`,
                  ),
                );
              }
            }
          }

          const fqns = Object.keys(stack.resources);
          const allLogs: { logicalId: string; lines: LogLine[] }[] = [];

          for (const fqn of fqns) {
            const resource = stack.resources[fqn]!;
            if (filterSet && !filterSet.has(resource.LogicalId)) continue;

            const resourceState = yield* state.get({
              stack: stack.name,
              stage: stack.stage,
              fqn,
            });
            if (!(resourceState as any)?.attr) continue;

            const provider = yield* findProviderByType(resource.Type);
            if (!provider.logs) continue;

            const lines = yield* provider.logs({
              id: resource.LogicalId,
              instanceId: (resourceState as any).instanceId,
              props: (resourceState as any).props,
              output: (resourceState as any).attr,
              options: { limit, since: sinceDate },
            });

            allLogs.push({ logicalId: resource.LogicalId, lines });
          }

          if (allLogs.length === 0) {
            if (filterSet) {
              yield* Console.log(
                "No resources with logs match --filter (deploy first, or selected resources may not expose logs).",
              );
            } else {
              yield* Console.log(
                "No resources with logs found. Deploy first, then run logs.",
              );
            }
            return;
          }

          const merged = allLogs
            .flatMap(({ logicalId, lines }, i) => {
              const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
              return lines.map((line) => ({
                ...line,
                formatted: `${color}${formatLocalTimestamp(line.timestamp)} [${logicalId}]${TAIL_RESET} ${line.message}`,
              }));
            })
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          for (const entry of merged) {
            yield* Console.log(entry.formatted);
          }
        }).pipe(Effect.provide(stack.services));
      }).pipe(Effect.provide(services));
    }),
  ),
);
