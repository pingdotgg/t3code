import {
  AcpRegistryIndex,
  type AcpRegistryAgent,
  type AcpRegistryListResult,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AcpRegistryClient,
  AcpRegistryClientError,
  type AcpRegistryClientShape,
} from "../Services/AcpRegistryClient.ts";

function toLaunchSpec(agent: AcpRegistryAgent) {
  if (agent.distribution.npx) {
    return {
      supported: true as const,
      distributionType: "npx" as const,
      launch: {
        command: "npx",
        args: ["-y", agent.distribution.npx.package, ...(agent.distribution.npx.args ?? [])],
      },
    };
  }
  if (agent.distribution.uvx) {
    return {
      supported: true as const,
      distributionType: "uvx" as const,
      launch: {
        command: "uvx",
        args: [agent.distribution.uvx.package, ...(agent.distribution.uvx.args ?? [])],
      },
    };
  }
  return {
    supported: false as const,
    distributionType: "binaryUnsupported" as const,
    launch: null,
  };
}

const makeAcpRegistryClient = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;

  const listAgents: AcpRegistryClientShape["listAgents"] = settings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new AcpRegistryClientError({
          detail: cause.message,
          cause,
        }),
    ),
    Effect.flatMap((serverSettings) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(serverSettings.providers.acp.registryUrl);
          if (!response.ok) {
            throw new Error(`Registry request failed with status ${response.status}`);
          }
          return response.json();
        },
        catch: (cause) =>
          new AcpRegistryClientError({
            detail: cause instanceof Error ? cause.message : "Failed to fetch ACP registry",
            ...(cause !== undefined ? { cause } : {}),
          }),
      }),
    ),
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(AcpRegistryIndex)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryClientError({
              detail: "Registry response did not match the ACP registry schema.",
              cause,
            }),
        ),
      ),
    ),
    Effect.map(
      (registry): AcpRegistryListResult => ({
        registryVersion: registry.version,
        agents: registry.agents
          .map((agent) => {
            const resolved = toLaunchSpec(agent);
            return {
              agent,
              supported: resolved.supported,
              distributionType: resolved.distributionType,
              launch: resolved.launch,
            };
          })
          .toSorted((left, right) => left.agent.name.localeCompare(right.agent.name)),
      }),
    ),
  );

  return {
    listAgents,
  } satisfies AcpRegistryClientShape;
});

export const AcpRegistryClientLive = Layer.effect(AcpRegistryClient, makeAcpRegistryClient);
