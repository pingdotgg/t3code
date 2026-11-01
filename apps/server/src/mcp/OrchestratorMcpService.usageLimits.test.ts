import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const checkedAt = "2026-10-31T09:00:00.000Z";
const weekly = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 73,
  resetsAt: "2026-11-01T00:00:00.000Z",
} as const;

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly usageLimits?: ServerProvider["usageLimits"];
  readonly enabled?: boolean;
  readonly email?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  displayName:
    input.driver === "codex" ? "Codex" : input.driver === "claude" ? "Claude" : input.driver,
  enabled: input.enabled ?? true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated", ...(input.email ? { email: input.email } : {}) },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  ...(input.usageLimits === undefined ? {} : { usageLimits: input.usageLimits }),
});

const sources = [
  {
    id: UsageLimitSourceId.make("proxy"),
    kind: "cliproxy",
    label: "CLI Proxy",
    checkedAt,
    accounts: [
      {
        id: "muse-account",
        driver: ProviderDriverKind.make("muse"),
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 41 }] },
      },
    ],
  },
  {
    id: UsageLimitSourceId.make("unavailable-proxy"),
    kind: "cliproxy",
    label: "Backup Proxy",
    checkedAt,
    accounts: [],
    error: "management-secret-sentinel",
  },
] as const satisfies ReadonlyArray<UsageLimitSourceSnapshot>;

const dependencies = (
  providers: ReadonlyArray<ServerProvider>,
  snapshots: ReadonlyArray<UsageLimitSourceSnapshot> = sources,
) =>
  Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(RemoteDelegation.RemoteDelegation)({}),
    Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed(snapshots) }),
  );

const scope = (capabilities: ReadonlySet<"orchestration">): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-usage-limits"),
  requestNamespace: "provider-session-usage-limits",
  thread: undefined,
  client: { sessionId: "read-only-client", label: "Agent", access: "read-only" },
  capabilities,
  issuedAt: 1,
});

it.effect("aggregates provider drivers, preserves probe timestamps and hides credentials", () =>
  Effect.gen(function* () {
    const providers = [
      provider({
        instanceId: "codex",
        driver: "codex",
        usageLimits: {
          checkedAt,
          windows: [weekly],
          credentialFingerprint: "credential-fingerprint-sentinel",
          unavailable: { reason: "probeFailed", message: "raw provider response" },
        },
      }),
      provider({
        instanceId: "claude",
        driver: "claude",
        usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      }),
      provider({ instanceId: "grok", driver: "grok" }),
    ];
    const layer = OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers)));
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(layer),
    );

    const result = yield* service.usageLimits(scope(new Set(["orchestration"])));

    expect(result.providers.map((account) => account.driver)).toEqual([
      "codex",
      "claude",
      "grok",
      "muse",
    ]);
    expect(result.providers.find((account) => account.driver === "codex")?.limits).toEqual({
      checkedAt,
      windows: [weekly],
      unavailable: { reason: "probeFailed" },
    });
    expect(result.providers.find((account) => account.driver === "muse")?.limits).toEqual({
      checkedAt,
      windows: [{ ...weekly, usedPercent: 41 }],
    });
    expect(result.notices).toContain("Claude [claude]: usage limits are not supported.");
    expect(result.notices).toContain("Codex [codex]: usage limits could not be refreshed.");
    expect(result.notices).toContain("Backup Proxy: unable to read provider usage limits.");
    expect(JSON.stringify(result)).not.toContain("credential-fingerprint-sentinel");
    expect(JSON.stringify(result)).not.toContain("management-secret-sentinel");
    expect(JSON.stringify(result)).not.toContain("raw provider response");
  }),
);

it.effect("requires orchestration scope before reading provider usage", () =>
  Effect.gen(function* () {
    const layer = OrchestratorMcpService.layer.pipe(Layer.provide(dependencies([])));
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(layer),
    );
    const error = yield* service.usageLimits(scope(new Set())).pipe(Effect.flip);

    expect(error.code).toBe("capability_denied");
  }),
);

it.effect("deduplicates native instances and proxy accounts sharing the same login", () =>
  Effect.gen(function* () {
    const email = "shared@example.com";
    const providers = [
      provider({
        instanceId: "primary",
        driver: "codex",
        email,
        usageLimits: { checkedAt, windows: [weekly] },
      }),
      provider({
        instanceId: "stale",
        driver: "codex",
        email,
        usageLimits: {
          checkedAt: "2026-10-30T09:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
    ];
    const snapshots = [
      {
        ...sources[0],
        accounts: [
          {
            id: "shared",
            driver: ProviderDriverKind.make("codex"),
            email,
            usageLimits: { checkedAt, windows: [weekly] },
          },
        ],
      },
    ];
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(
        OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers, snapshots))),
      ),
    );
    const result = yield* service.usageLimits(scope(new Set(["orchestration"])));
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.providerInstanceId).toBe("primary");
    expect(result.providers[0]?.limits.windows).toEqual([weekly]);
    expect(result.notices).toEqual([]);
  }),
);

it.effect(
  "omits disabled instances and distinguishes pending snapshots from unsupported drivers",
  () =>
    Effect.gen(function* () {
      const providers = [
        provider({
          instanceId: "disabled",
          driver: "codex",
          enabled: false,
          usageLimits: { checkedAt, windows: [weekly] },
        }),
        provider({ instanceId: "pending", driver: "grok" }),
      ];
      const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(Layer.provide(dependencies(providers, []))),
        ),
      );
      const result = yield* service.usageLimits(scope(new Set(["orchestration"])));
      expect(result.providers.map((account) => account.id)).toEqual(["pending"]);
      expect(result.providers[0]?.limits).toEqual({ checkedAt, windows: [] });
      expect(result.notices).toEqual(["grok [pending]: no usage limits reported yet."]);
    }),
);
