#!/usr/bin/env node
// @effect-diagnostics globalFetch:off nodeBuiltinImport:off - Standalone registry sync script runs directly in Node.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REGISTRY_JSON_PATH = NodePath.join(
  REPO_ROOT,
  "packages/contracts/src/registry/registry.json",
);
const ICON_DIR = NodePath.join(REPO_ROOT, "packages/contracts/src/registry/icons");
const DEFAULT_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const EXCLUDED_AGENT_IDS = new Set<string>();

interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  [key: string]: unknown;
}

interface RegistryDocument {
  version: string;
  agents: RegistryAgent[];
}

interface CliArgs {
  registryUrl: string;
  skipIcons: boolean;
}

const USAGE = "Usage: sync-acp-registry [--registry-url <url>] [--skip-icons]";

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: CliArgs = { registryUrl: DEFAULT_REGISTRY_URL, skipIcons: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--registry-url") {
      const value = argv[++i];
      if (!value) throw new Error("--registry-url requires a value");
      args.registryUrl = value;
    } else if (arg === "--skip-icons") {
      args.skipIcons = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function fetchRegistry(url: string): Promise<RegistryDocument> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status} ${response.statusText}) — ${url}`);
  }
  const payload = (await response.json()) as RegistryDocument;
  if (!Array.isArray(payload.agents)) {
    throw new Error("Registry payload did not contain an `agents` array");
  }
  return payload;
}

const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/i;

function safeIconPath(agentId: string): string {
  if (!SAFE_AGENT_ID.test(agentId)) {
    throw new Error(`Unsafe agent id: ${agentId}`);
  }
  const target = NodePath.join(ICON_DIR, `${agentId}.svg`);
  const resolved = NodePath.resolve(target);
  const root = NodePath.resolve(ICON_DIR);
  if (
    resolved !== NodePath.join(root, `${agentId}.svg`) ||
    !resolved.startsWith(`${root}${NodePath.sep}`)
  ) {
    throw new Error(`Icon path escapes ICON_DIR: ${agentId}`);
  }
  return resolved;
}

async function downloadIcon(agent: RegistryAgent): Promise<boolean> {
  if (typeof agent.icon !== "string" || agent.icon.length === 0) return false;
  const response = await fetch(agent.icon);
  if (!response.ok) return false;
  const text = await response.text();
  if (!text.trimStart().startsWith("<")) return false;
  await NodeFSP.writeFile(safeIconPath(agent.id), text, "utf8");
  return true;
}

async function pruneStaleIcons(wantedIds: ReadonlySet<string>): Promise<void> {
  const wanted = new Set(Array.from(wantedIds, (id) => `${id}.svg`));
  const existing = await NodeFSP.readdir(ICON_DIR).catch(() => [] as string[]);
  await Promise.all(
    existing
      .filter((entry) => !wanted.has(entry))
      .map((entry) => NodeFSP.rm(NodePath.join(ICON_DIR, entry), { force: true })),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  await NodeFSP.mkdir(ICON_DIR, { recursive: true });

  process.stdout.write(`Fetching ${args.registryUrl}\n`);
  const upstream = await fetchRegistry(args.registryUrl);

  const filtered = upstream.agents
    .filter((agent) => !EXCLUDED_AGENT_IDS.has(agent.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const excludedIds = upstream.agents
    .filter((agent) => EXCLUDED_AGENT_IDS.has(agent.id))
    .map((agent) => agent.id);

  const snapshot: RegistryDocument = { version: upstream.version, agents: filtered };
  await NodeFSP.writeFile(REGISTRY_JSON_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  await pruneStaleIcons(new Set(filtered.map((agent) => agent.id)));

  let iconOk = 0;
  let iconMissing = 0;
  if (!args.skipIcons) {
    process.stdout.write(`Downloading ${filtered.length} icons…\n`);
    const results = await Promise.all(
      filtered.map((agent) => downloadIcon(agent).catch(() => false)),
    );
    results.forEach((ok, index) => {
      if (ok) {
        iconOk += 1;
        return;
      }
      iconMissing += 1;
      process.stderr.write(`  ! icon missing for ${filtered[index]!.id}\n`);
    });
  }

  process.stdout.write(
    [
      `Synced ACP registry v${upstream.version}`,
      `  agents bundled : ${filtered.length}`,
      `  agents excluded: ${excludedIds.length} (${excludedIds.join(", ") || "—"})`,
      `  icons          : ${args.skipIcons ? "skipped" : `${iconOk} ok, ${iconMissing} missing`}`,
      `  output         : ${NodePath.relative(REPO_ROOT, REGISTRY_JSON_PATH)}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
