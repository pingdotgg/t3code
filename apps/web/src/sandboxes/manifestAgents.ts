import type { AgentctlSandboxManifest } from "@t3tools/contracts";

/** The manifests in one folder: an `agent.yaml` and its `agent.<variant>.yaml` siblings. */
export interface ManifestAgent {
  directory: string;
  /** The folder relative to its repository, without the `agents/` most repositories use. */
  label: string;
  /** The base manifest's `metadata.name`, shown beside the label where it says more. */
  agentName: string | null;
  /** In discovery order, so the base manifest comes first. */
  manifests: ReadonlyArray<AgentctlSandboxManifest>;
}

export interface ManifestRepository {
  path: string;
  name: string;
  agents: ReadonlyArray<ManifestAgent>;
}

function segments(path: string) {
  return path.split(/[\\/]/).filter((segment) => segment !== "");
}

function agentLabel(manifest: AgentctlSandboxManifest) {
  const relative = segments(manifest.directory).slice(segments(manifest.repository).length);
  const trimmed = relative[0] === "agents" ? relative.slice(1) : relative;
  return trimmed.length > 0
    ? trimmed.join("/")
    : (manifest.agentName ?? relative.at(-1) ?? segments(manifest.directory).at(-1) ?? "agent");
}

/** The manifest's file as its repository names it, such as `agents/dev/agent.mine.yaml`. */
export function manifestRelativePath(manifest: AgentctlSandboxManifest) {
  return segments(manifest.path).slice(segments(manifest.repository).length).join("/");
}

/** Groups discovered manifests by repository, then folder, keeping discovery's order. */
export function groupManifests(
  manifests: ReadonlyArray<AgentctlSandboxManifest>,
): ManifestRepository[] {
  const repositories = new Map<string, { path: string; name: string; agents: ManifestAgent[] }>();
  const agents = new Map<string, { manifests: AgentctlSandboxManifest[] }>();
  for (const manifest of manifests) {
    const existing = agents.get(manifest.directory);
    if (existing) {
      existing.manifests.push(manifest);
      continue;
    }
    let repository = repositories.get(manifest.repository);
    if (!repository) {
      repository = {
        path: manifest.repository,
        name: segments(manifest.repository).at(-1) ?? manifest.repository,
        agents: [],
      };
      repositories.set(manifest.repository, repository);
    }
    const agent = {
      directory: manifest.directory,
      label: agentLabel(manifest),
      agentName: manifest.agentName,
      manifests: [manifest],
    };
    agents.set(manifest.directory, agent);
    repository.agents.push(agent);
  }
  return [...repositories.values()];
}

function queryTerms(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Keeps the agents that match every word of the query in their repository, folder, name or
 * variants, so "altinn nested" finds the agent with a nested variant in the altinn repository.
 */
export function filterManifestRepositories(
  repositories: ReadonlyArray<ManifestRepository>,
  query: string,
): ManifestRepository[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [...repositories];
  return repositories.flatMap((repository) => {
    const agents = repository.agents.filter((agent) => {
      const haystack = [
        repository.name,
        agent.label,
        agent.agentName ?? "",
        ...agent.manifests.map((manifest) => manifest.variant ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return agents.length > 0 ? [{ ...repository, agents }] : [];
  });
}

/**
 * The manifest to select when an agent is picked: a variant the search named, else the variant
 * already selected, so `mine` stays `mine` across repositories, else the base manifest.
 */
export function pickAgentManifest(
  agent: ManifestAgent,
  query: string,
  currentVariant: string | null,
): AgentctlSandboxManifest | null {
  const byVariant = (variant: string | null) =>
    agent.manifests.find((manifest) => manifest.variant === variant);
  const named = queryTerms(query)
    .map((term) => agent.manifests.find((manifest) => manifest.variant?.toLowerCase() === term))
    .find((manifest) => manifest !== undefined);
  return named ?? byVariant(currentVariant) ?? byVariant(null) ?? agent.manifests[0] ?? null;
}
