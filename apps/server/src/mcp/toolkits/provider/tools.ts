import {
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ServerProviderAuthStatus,
  ServerProviderState,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const MAX_USAGE_ROWS = 100;

const UsageLimits = Schema.Struct({
  checkedAt: Schema.String,
  windows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      label: Schema.String,
      usedPercent: Schema.Number,
      resetsAt: Schema.NullOr(Schema.String),
    }),
  ),
  resetCredits: Schema.NullOr(Schema.Number),
  /** Why windows are missing: "unsupported" (API key accounts) or "probeFailed". */
  unavailable: Schema.NullOr(Schema.String),
});
const ProviderSnapshot = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      driver: Schema.String,
      displayName: Schema.NullOr(Schema.String),
      enabled: Schema.Boolean,
      installed: Schema.Boolean,
      available: Schema.Boolean,
      version: Schema.NullOr(Schema.String),
      latestVersion: Schema.NullOr(Schema.String),
      status: ServerProviderState,
      message: Schema.NullOr(Schema.String),
      checkedAt: Schema.String,
      auth: Schema.Struct({
        status: ServerProviderAuthStatus,
        type: Schema.NullOr(Schema.String),
        label: Schema.NullOr(Schema.String),
      }),
      usageLimits: Schema.NullOr(UsageLimits),
    }),
  ),
  /** Pooled accounts from configured quota hubs. These accounts cannot run turns here. */
  usageLimitSources: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      checkedAt: Schema.String,
      error: Schema.NullOr(Schema.String),
      accounts: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          driver: Schema.String,
          plan: Schema.NullOr(Schema.String),
          usageLimits: UsageLimits,
        }),
      ),
    }),
  ),
});
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderRegistry.ProviderRegistry,
    UsageLimitSources.UsageLimitSources,
    UsageService.UsageService,
  ],
};

const ProviderStatusTool = Tool.make("t3_provider_status", {
  ...shared,
  description: `Read each provider instance's health as the Settings providers page shows it: enabled, installed, version and latest version, status, auth state, and subscription rate-limit windows (usedPercent, resetsAt) so you can pick a provider with quota. Models are in orchestrator_capabilities. Snapshots come from the server's periodic checks (see checkedAt); t3_provider_refresh re-probes. Pass instanceId for one instance. Pass usage {sinceDay, untilDay (YYYY-MM-DD, inclusive), timeZone (IANA)} to add token and API-equivalent cost totals per provider and model from local transcripts, at most ${MAX_USAGE_ROWS} rows by cost. Needs a full-access/default caller, since provider messages can carry configured URLs and paths.`,
  parameters: Schema.Struct({
    instanceId: Schema.optional(ProviderInstanceId),
    usage: Schema.optional(
      Schema.Struct({
        sinceDay: UsageSummaryInput.fields.sinceDay,
        untilDay: UsageSummaryInput.fields.untilDay,
        timeZone: UsageSummaryInput.fields.timeZone,
      }),
    ),
  }),
  success: Schema.Struct({
    ...ProviderSnapshot.fields,
    usage: Schema.optional(
      Schema.Struct({
        sinceDay: Schema.String,
        untilDay: Schema.String,
        timeZone: Schema.String,
        pricing: Schema.String,
        models: Schema.Array(
          Schema.Struct({
            provider: Schema.String,
            model: Schema.String,
            uncachedInputTokens: Schema.Number,
            cachedInputTokens: Schema.Number,
            cacheCreationTokens: Schema.Number,
            outputTokens: Schema.Number,
            costUsd: Schema.Number,
            records: Schema.Number,
          }),
        ),
        truncated: Schema.Boolean,
        sources: Schema.Array(
          Schema.Struct({
            provider: Schema.String,
            status: Schema.String,
            message: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Title, "Read provider status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ProviderRefreshTool = Tool.make("t3_provider_refresh", {
  ...shared,
  description:
    "Re-probe provider instances now (install, version, auth, rate limits) and return the same snapshot as t3_provider_status. Omit instanceId to refresh every instance and the quota hubs. Runs the provider CLIs, so it requires a live full-access/default calling thread or a full-access client. Sign-in and sign-out stay in the Settings UI.",
  parameters: Schema.Struct({ instanceId: Schema.optional(ProviderInstanceId) }),
  success: ProviderSnapshot,
})
  .annotate(Tool.Title, "Refresh providers")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ProviderToolkit = Toolkit.make(ProviderStatusTool, ProviderRefreshTool);
