import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpProviderUsageResult,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as ProviderUsage from "../../../usage/ProviderUsage.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const decodeResult = Schema.decodeUnknownEffect(OrchestratorMcpProviderUsageResult);

it.effect("provider_usage answers a read-only client outside any thread", () =>
  Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    const [call] = yield* toolkit
      .handle("provider_usage", { environmentId: undefined })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(call?.isFailure).toBe(false);
    const result = yield* decodeResult(call?.result);
    expect(
      result.providers.map((provider) => [provider.providerInstanceId, provider.available]),
    ).toEqual([["claude", true]]);
    expect(result.sources).toEqual([]);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:usage"),
              requestNamespace: "client:usage",
              thread: undefined,
              client: { sessionId: "session:usage", label: "Grok Bot", access: "read-only" },
              capabilities: new Set<"orchestration">(),
              issuedAt: 0,
            }),
            ProviderUsage.layer.pipe(
              Layer.provide(
                Layer.merge(
                  ProviderRegistryMock.layer([
                    {
                      instanceId: ProviderInstanceId.make("claude"),
                      driver: ProviderDriverKind.make("claudeAgent"),
                      enabled: true,
                      installed: true,
                      version: null,
                      status: "ready",
                      auth: { status: "authenticated", label: "Claude Max" },
                      checkedAt: "2026-09-03T12:00:00.000Z",
                      models: [],
                      slashCommands: [],
                      skills: [],
                      usageLimits: {
                        checkedAt: "2026-09-03T12:00:00.000Z",
                        windows: [
                          { id: "five_hour", kind: "session", label: "5h", usedPercent: 12 },
                        ],
                      },
                    },
                  ]),
                  Layer.mock(UsageLimitSources.UsageLimitSources)({
                    current: Effect.succeed([]),
                    refresh: Effect.void,
                  }),
                ),
              ),
            ),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
            Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
            Layer.mock(PeerForwarding.PeerForwarding)({}),
            Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
            Layer.mock(PeerLinks.PeerLinks)({}),
          ),
        ),
      ),
    ),
  ),
);
