import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Graph, GraphEdge, GraphNode } from "../shared/types.ts";

/**
 * Reads the architecture out of Alchemy's local state for one stage:
 * every resource is a node, every binding a host holds is an edge labelled
 * with what it granted, and output references (`downstream`) fill in the
 * rest. Nothing here is hand-drawn, so the diagram cannot disagree with
 * what was deployed.
 */

interface StateRow {
  logicalId: string;
  fqn?: string;
  resourceType: string;
  providerMode?: string;
  downstream?: string[];
  attr?: Record<string, unknown>;
  bindings?: { sid: string; data: Record<string, unknown> }[];
}

const KINDS: Record<string, { kind: string; provider: GraphNode["provider"]; tier: number }> = {
  "Cloudflare.Website": { kind: "Vite Website", provider: "cloudflare", tier: 0 },
  "Cloudflare.Worker": { kind: "Worker", provider: "cloudflare", tier: 1 },
  "Cloudflare.D1Database": { kind: "D1 Database", provider: "cloudflare", tier: 2 },
  "Cloudflare.D1.Database": { kind: "D1 Database", provider: "cloudflare", tier: 2 },
  "Cloudflare.Queues.Queue": { kind: "Queue", provider: "cloudflare", tier: 2 },
  "Cloudflare.Hyperdrive": { kind: "Hyperdrive", provider: "cloudflare", tier: 2 },
  "Neon.Project": { kind: "Neon Postgres", provider: "neon", tier: 3 },
  "Axiom.Dataset": { kind: "Axiom Dataset", provider: "axiom", tier: 3 },
  "Axiom.ApiToken": { kind: "Ingest Token", provider: "axiom", tier: 3 },
  "Axiom.Dashboard": { kind: "Axiom Dashboard", provider: "axiom", tier: 4 },
};

/** A binding's data, rendered as the grant shown in the diagram. */
const describeGrant = (data: Record<string, unknown>): { label: string; grant: string } => {
  const bindings = (data.bindings as Record<string, unknown>[] | undefined) ?? [];
  const first = bindings[0];
  if (!first) {
    const keys = Object.keys(data).join(", ");
    return { label: keys || "binding", grant: keys };
  }
  const type = String(first.type);
  const label =
    {
      d1: "D1 binding",
      queue: "queue producer",
      durable_object_namespace: "Durable Object namespace",
      hyperdrive: "Hyperdrive binding",
      plain_text: "env var",
      secret_text: "secret",
    }[type] ?? type;
  // Physical ids differ per stage; show the shape of the grant.
  const shown = Object.fromEntries(
    Object.entries(first).filter(([key]) => !/id$|Id$|queueName|databaseName/.test(key)),
  );
  const extra = bindings.length > 1 ? ` + ${bindings.length - 1} more` : "";
  const body = Object.entries(shown)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
  return { label, grant: `{ ${body} }${extra}` };
};

export const readGraph = async (stateDir: string, stage: string): Promise<Graph> => {
  const dir = path.join(stateDir, stage);
  const files = (await readdir(dir).catch(() => [] as string[])).filter(
    (file) => file.endsWith(".json") && !file.startsWith("__"),
  );
  const rows: StateRow[] = [];
  for (const file of files) {
    const row = JSON.parse(await readFile(path.join(dir, file), "utf8")) as StateRow;
    if (row.resourceType) rows.push(row);
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const idOf = (row: StateRow) => row.logicalId;
  const addEdge = (edge: Omit<GraphEdge, "id">) => {
    const id = `${edge.from}->${edge.to}`;
    if (!edges.has(id)) edges.set(id, { id, ...edge });
  };

  for (const row of rows) {
    if (row.resourceType === "Cloudflare.Queues.Consumer") continue;
    const known = KINDS[row.resourceType];
    // Website.Vite is a Worker serving the built site; the demo names it "Web".
    const isWebsite = row.resourceType === "Cloudflare.Worker" && row.logicalId === "Web";
    const meta = isWebsite
      ? KINDS["Cloudflare.Website"]!
      : (known ?? {
          kind: row.resourceType.split(".").pop()!,
          provider: "other" as const,
          tier: 2,
        });
    nodes.set(idOf(row), {
      id: idOf(row),
      kind: meta.kind,
      provider: meta.provider,
      location: row.providerMode === "local" ? "local" : "cloud",
      tier: meta.tier,
    });
  }

  for (const row of rows) {
    const host = idOf(row);
    for (const binding of row.bindings ?? []) {
      const { label, grant } = describeGrant(binding.data);
      const types = ((binding.data.bindings as { type?: string; className?: string }[]) ?? []).map(
        (b) => b.type,
      );
      if (types.includes("durable_object_namespace")) {
        // Durable Object classes live inside the Worker's script: draw them as their own node.
        const node = nodes.get(host);
        nodes.set(binding.sid, {
          id: binding.sid,
          kind: "Durable Object",
          provider: "cloudflare",
          location: node?.location ?? "cloud",
          tier: 2,
        });
      }
      if (types.includes("plain_text") && binding.sid.startsWith("VITE_")) {
        const target = rows.find(
          (r) => r.downstream?.includes(host) && r.resourceType === "Cloudflare.Worker",
        );
        if (target)
          addEdge({ from: host, to: idOf(target), kind: "reference", label: binding.sid, grant });
        continue;
      }
      if (nodes.has(binding.sid)) {
        addEdge({ from: host, to: binding.sid, kind: "binding", label, grant });
      }
    }
    if (row.resourceType === "Cloudflare.Queues.Consumer") {
      const worker = row.fqn?.split("/")[0];
      const queue = rows.find(
        (r) =>
          r.resourceType === "Cloudflare.Queues.Queue" && r.downstream?.includes(row.fqn ?? ""),
      );
      if (worker && queue) {
        addEdge({
          from: idOf(queue),
          to: worker,
          kind: "consumer",
          label: "consumer",
          grant: "delivers message batches",
        });
      }
    }
  }

  // Output references not already covered by a binding (e.g. Neon → Hyperdrive origin, Axiom → Worker telemetry).
  for (const row of rows) {
    if (!nodes.has(idOf(row))) continue;
    for (const down of row.downstream ?? []) {
      if (down.includes("/") || !nodes.has(down)) continue;
      const user = nodes.get(down)!;
      if (user.kind === "Vite Website") continue;
      if (edges.has(`${down}->${idOf(row)}`) || edges.has(`${idOf(row)}->${down}`)) continue;
      const label =
        row.resourceType === "Axiom.ApiToken"
          ? "ingest token (secret)"
          : row.resourceType === "Axiom.Dataset"
            ? "OTLP export"
            : row.resourceType === "Neon.Project"
              ? "origin"
              : "reference";
      addEdge({ from: down, to: idOf(row), kind: "reference", label });
    }
  }

  // Dashboards query the trace dataset.
  for (const dashboard of rows.filter((r) => r.resourceType === "Axiom.Dashboard")) {
    const traces = rows.find(
      (r) => r.resourceType === "Axiom.Dataset" && String(r.attr?.kind ?? "").includes("traces"),
    );
    if (traces)
      addEdge({ from: idOf(dashboard), to: idOf(traces), kind: "reference", label: "queries" });
  }

  return { stage, nodes: [...nodes.values()], edges: [...edges.values()] };
};
