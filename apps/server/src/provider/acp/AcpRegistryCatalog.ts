/**
 * Resolve the ACP catalog: featured one-click agents plus the live ACP registry.
 *
 * Featured rows always win on id collision. Live registry entries that only
 * ship platform binaries (no npx/uvx) are listed as unsupported so T3 never
 * downloads remote executables.
 *
 * @module provider/acp/AcpRegistryCatalog
 */
import {
  ACP_FEATURED_AGENTS,
  ACP_REGISTRY_INDEX_URL,
  AcpRegistryIndex,
  defaultLaunchForFeaturedAgent,
  featuredAgentById,
  type AcpRegistryCatalogEntry,
  type AcpRegistryIndexAgent,
  type AcpRegistryListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const decodeIndex = Schema.decodeUnknownEffect(AcpRegistryIndex);

function featuredEntry(agent: (typeof ACP_FEATURED_AGENTS)[number]): AcpRegistryCatalogEntry {
  const launch = defaultLaunchForFeaturedAgent(agent) ?? null;
  return {
    id: agent.id,
    label: agent.label,
    description: agent.description,
    featured: true,
    ...(agent.docsUrl ? { docsUrl: agent.docsUrl } : {}),
    installHint: agent.installHint,
    iconKey: agent.iconKey,
    distributionType: launch ? (agent.local ? "local" : agent.npx ? "npx" : "uvx") : "unsupported",
    launch,
  };
}

function registryEntry(agent: AcpRegistryIndexAgent): AcpRegistryCatalogEntry {
  const featured = featuredAgentById(agent.id);
  if (featured) {
    return {
      ...featuredEntry(featured),
      ...(agent.version ? { version: agent.version } : {}),
      ...(agent.icon ? { iconUrl: agent.icon } : {}),
      ...(agent.website || agent.repository
        ? { docsUrl: featured.docsUrl ?? agent.website ?? agent.repository }
        : {}),
    };
  }

  if (agent.distribution.npx) {
    return {
      id: agent.id,
      label: agent.name,
      description: agent.description?.trim() || agent.name,
      featured: false,
      ...(agent.website || agent.repository ? { docsUrl: agent.website ?? agent.repository } : {}),
      installHint: `npx -y ${agent.distribution.npx.package}`,
      iconKey: "acpRegistry",
      ...(agent.icon ? { iconUrl: agent.icon } : {}),
      ...(agent.version ? { version: agent.version } : {}),
      distributionType: "npx",
      launch: {
        command: "npx",
        args: ["-y", agent.distribution.npx.package, ...(agent.distribution.npx.args ?? [])],
      },
    };
  }

  if (agent.distribution.uvx) {
    return {
      id: agent.id,
      label: agent.name,
      description: agent.description?.trim() || agent.name,
      featured: false,
      ...(agent.website || agent.repository ? { docsUrl: agent.website ?? agent.repository } : {}),
      installHint: `uvx ${agent.distribution.uvx.package}`,
      iconKey: "acpRegistry",
      ...(agent.icon ? { iconUrl: agent.icon } : {}),
      ...(agent.version ? { version: agent.version } : {}),
      distributionType: "uvx",
      launch: {
        command: "uvx",
        args: [agent.distribution.uvx.package, ...(agent.distribution.uvx.args ?? [])],
      },
    };
  }

  return {
    id: agent.id,
    label: agent.name,
    description: agent.description?.trim() || agent.name,
    featured: false,
    ...(agent.website || agent.repository ? { docsUrl: agent.website ?? agent.repository } : {}),
    installHint: "Install this agent's CLI locally, then add a custom ACP instance.",
    iconKey: "acpRegistry",
    ...(agent.icon ? { iconUrl: agent.icon } : {}),
    ...(agent.version ? { version: agent.version } : {}),
    distributionType: "unsupported",
    launch: null,
  };
}

export function featuredCatalogEntries(): ReadonlyArray<AcpRegistryCatalogEntry> {
  return ACP_FEATURED_AGENTS.map(featuredEntry);
}

export function catalogEntryFromRegistryAgent(
  agent: AcpRegistryIndexAgent,
): AcpRegistryCatalogEntry {
  return registryEntry(agent);
}

export function mergeAcpRegistryCatalog(
  featured: ReadonlyArray<AcpRegistryCatalogEntry>,
  index: AcpRegistryIndex | null | undefined,
): AcpRegistryListResult {
  if (!index) {
    return { agents: featured };
  }

  const featuredIds = new Set(featured.map((agent) => agent.id));
  const enrichedFeatured = featured.map((entry) => {
    const remote = index.agents.find((agent) => agent.id === entry.id);
    return remote ? catalogEntryFromRegistryAgent(remote) : entry;
  });
  const extra = index.agents
    .filter((agent) => !featuredIds.has(agent.id))
    .map(catalogEntryFromRegistryAgent);

  return {
    registryVersion: index.version,
    agents: [...enrichedFeatured, ...extra],
  };
}

export const listAcpRegistryCatalog = Effect.fn("listAcpRegistryCatalog")(function* () {
  const featured = featuredCatalogEntries();
  const httpClient = yield* HttpClient.HttpClient;
  const remote = yield* httpClient.execute(HttpClientRequest.get(ACP_REGISTRY_INDEX_URL)).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeIndex),
    Effect.timeout("8 seconds"),
    Effect.option,
  );

  return mergeAcpRegistryCatalog(featured, remote._tag === "Some" ? remote.value : null);
});
