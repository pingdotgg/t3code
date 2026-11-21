import type { ProviderInstanceId } from "@t3tools/contracts";
import type {
  ProviderUsageInstance,
  ProviderUsageReader,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";

const ZAI_GLM_AGENT_ID = "glm-acp-agent";

/** inputTokens includes cache reads and writes; outputTokens includes reasoning. */
export interface ZaiGlmUsageTurn {
  readonly providerTurnId: string;
  readonly providerThreadId: string;
  readonly completedAtMs: number;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export class ZaiUsageHistoryReadError extends Schema.TaggedError<ZaiUsageHistoryReadError>()(
  "ZaiUsageHistoryReadError",
  { requestedInstanceCount: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read recorded Z.ai GLM turn usage.";
  }
}

// The tag lives in the package so the driver's reader can depend on it; the SQL
// layer lives in the server app, which owns the state database.
export class ZaiUsageHistory extends Context.Service<
  ZaiUsageHistory,
  {
    readonly readGlmTurns: (input: {
      readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
      readonly sinceMs: number;
    }) => Effect.Effect<ReadonlyArray<ZaiGlmUsageTurn>, ZaiUsageHistoryReadError>;
    readonly databasePath: string;
  }
>()("@t3tools/provider-acp-registry/server/usage/ZaiUsageHistory") {}

const glmInstanceIds = (instances: ReadonlyArray<ProviderUsageInstance<AcpRegistrySettings>>) =>
  instances.flatMap((instance) =>
    instance.config !== undefined &&
    instance.config.source !== "local" &&
    instance.config.agentId.trim() === ZAI_GLM_AGENT_ID
      ? [instance.instanceId]
      : [],
  );

export const zaiUsageReader: ProviderUsageReader<AcpRegistrySettings, ZaiUsageHistory> = {
  kind: "scan",
  provider: "zai",
  scan: Effect.fn("zaiUsageReader.scan")(function* ({
    instances,
    windowStartMs,
    retentionCutoffMs,
  }) {
    const instanceIds = glmInstanceIds(instances);
    if (instanceIds.length === 0) return [];
    const history = yield* ZaiUsageHistory;
    const turns = yield* history
      .readGlmTurns({
        instanceIds,
        sinceMs: Math.max(windowStartMs, retentionCutoffMs),
      })
      .pipe(
        Effect.catchTags({
          ZaiUsageHistoryReadError: () => Effect.succeed(null),
        }),
      );
    if (turns === null) {
      return [
        {
          dir: history.databasePath,
          files: [],
          status: "failed",
          message: "Z.ai GLM history could not be read from this environment.",
        },
      ];
    }
    const records: ReadonlyArray<UsageRecord> = turns.map((turn) => ({
      provider: "zai",
      timestampMs: turn.completedAtMs,
      model: turn.model,
      rateModel: `zai/${turn.model.toLowerCase()}`,
      sessionId: turn.providerThreadId,
      totals: {
        uncachedInputTokens: Math.max(
          0,
          turn.inputTokens - turn.cachedInputTokens - turn.cacheCreationTokens,
        ),
        cachedInputTokens: turn.cachedInputTokens,
        cacheCreationTokens: turn.cacheCreationTokens,
        outputTokens: turn.outputTokens,
        reasoningTokens: turn.reasoningTokens,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: turn.providerTurnId,
    }));
    return [{ dir: history.databasePath, files: [{ path: history.databasePath, records }] }];
  }),
};
