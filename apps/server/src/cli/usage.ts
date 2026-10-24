import {
  OrchestratorMcpUsageLimitsResult,
  OrchestratorMcpUsageSpendResult,
  type OrchestratorMcpUsageWindow,
} from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { formatDuration } from "@t3tools/shared/usageLimits";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, reportThreadErrors, withThreadTools } from "./thread.ts";

type Reading = Pick<
  OrchestratorMcpUsageLimitsResult["providers"][number],
  "ageMins" | "windows" | "unavailable"
>;

const MINUTE = 60_000;

const formatWindow = (window: OrchestratorMcpUsageWindow) => {
  const reset =
    window.resetsInMins === null
      ? ""
      : window.resetsInMins === 0
        ? " · resets now"
        : ` · resets in ${formatDuration(window.resetsInMins * MINUTE)}`;
  return `  ${window.label.padEnd(16)} ${String(window.remainingPercent).padStart(3)}% left${reset}`;
};

const formatReading = (title: string, reading: Reading) => [
  reading.ageMins === null
    ? title
    : `${title} · read ${formatDuration(reading.ageMins * MINUTE)} ago`,
  ...(reading.unavailable === null
    ? reading.windows.map(formatWindow)
    : [`  ${reading.unavailable}`]),
];

const formatNotices = (notices: ReadonlyArray<string>) =>
  notices.length === 0 ? [] : ["Notices", ...notices.map((notice) => `  ${notice}`)];

const formatLimits = (limits: OrchestratorMcpUsageLimitsResult) => {
  const lines = [
    ...limits.providers.flatMap((provider) =>
      formatReading(
        String(provider.providerInstanceId) === String(provider.driverKind)
          ? provider.providerInstanceId
          : `${provider.providerInstanceId} [${provider.driverKind}]`,
        provider,
      ),
    ),
    ...limits.pooledAccounts.flatMap((account) =>
      formatReading(`${account.source} · ${account.accountId} [${account.driverKind}]`, account),
    ),
  ];
  return [
    ...(lines.length === 0 ? ["No providers are enabled."] : lines),
    ...formatNotices(limits.notices),
  ].join("\n");
};

const amount = (costUsd: number | null, totalTokens: number) =>
  `${(costUsd === null ? "unpriced" : formatUsd(costUsd)).padStart(11)}  ${formatTokens(totalTokens).padStart(6)} tokens`;

const formatSpend = (spend: OrchestratorMcpUsageSpendResult) => {
  const { window } = spend;
  const range =
    window.days === 1
      ? "past 24 hours"
      : `${window.days} days, ${window.sinceDay} to ${window.untilDay}`;
  const width = Math.max(
    0,
    ...[
      ...spend.providers.map((provider) => provider.provider),
      ...spend.models.map((model) => model.model),
      ...spend.periods.map((period) => period.start),
    ].map((label) => label.length),
  );
  return [
    `Spend · ${range} (${window.timeZone}) · API estimate`,
    `  ${formatUsd(spend.costUsd)} · ${formatTokens(spend.totalTokens)} tokens · ${formatCount(spend.sessions)} sessions${
      spend.unpricedShare > 0 ? ` · ${formatPercent(spend.unpricedShare)} unpriced` : ""
    }`,
    "  By provider",
    ...spend.providers.map(
      (provider) =>
        `    ${provider.provider.padEnd(width)}  ${amount(provider.costUsd, provider.totalTokens)}  ${formatCount(provider.sessions)} sessions`,
    ),
    "  By model",
    ...spend.models.map(
      (model) => `    ${model.model.padEnd(width)}  ${amount(model.costUsd, model.totalTokens)}`,
    ),
    window.days === 1 ? "  By hour" : "  By day",
    ...spend.periods.map(
      (period) => `    ${period.start.padEnd(width)}  ${formatUsd(period.costUsd).padStart(11)}`,
    ),
    ...formatNotices(spend.notices),
  ].join("\n");
};

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const usageClient = { label: "t3 usage cli", name: "t3-usage-cli" };

const usageLimitsCommand = Command.make("limits", {
  ...projectLocationFlags,
  refresh: Flag.Boolean("refresh").pipe(
    Flag.withDescription("Re-read every provider before printing. Slower."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show each provider's remaining subscription limits and when they reset.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.usage.limits")(function* (tools) {
        const limits = yield* tools.call(
          "t3_usage_limits",
          { refresh: flags.refresh },
          OrchestratorMcpUsageLimitsResult,
        );
        if (flags.json) {
          return yield* printJson(limits);
        }
        yield* Console.log(formatLimits(limits));
      }),
      usageClient,
    ).pipe(reportThreadErrors),
  ),
);

const usageSpendCommand = Command.make("spend", {
  ...projectLocationFlags,
  days: Flag.ChoiceWithValue("days", [
    ["1", 1],
    ["7", 7],
    ["30", 30],
    ["90", 90],
  ] as const).pipe(
    Flag.withDescription("Window in days, as on the Usage tab. 1 shows the past 24 hours."),
    Flag.withDefault(30),
  ),
  refresh: Flag.Boolean("refresh").pipe(
    Flag.withDescription("Wait for sources that are still loading. Slower."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the Usage tab's token and dollar spend for this environment, with days in the server's time zone.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.usage.spend")(function* (tools) {
        const spend = yield* tools.call(
          "t3_usage_spend",
          { days: flags.days, refresh: flags.refresh },
          OrchestratorMcpUsageSpendResult,
        );
        yield* flags.json ? printJson(spend) : Console.log(formatSpend(spend));
      }),
      usageClient,
    ).pipe(reportThreadErrors),
  ),
);

export const usageCommand = Command.make("usage").pipe(
  Command.withDescription(
    "Show what the Usage tab shows, from the running server: limits or spend.",
  ),
  Command.withSubcommands([usageLimitsCommand, usageSpendCommand]),
);
