import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @effect-diagnostics nodeBuiltinImport:off -- Standalone filesystem packaging at the MCP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { AgentSkill, AgentSkillResources, MAX_SKILL_RESOURCE_BYTES } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { APP_NAME } from "@t3tools/shared/branding";

const decodeResources = Schema.decodeUnknownSync(AgentSkillResources);

/** Import only real files from a skill folder; never follow links outside the bundle. */
export async function packSkillResources(directory: string) {
  const root = await NodeFSP.realpath(directory);
  const resources: Array<{ path: string; contentBase64: string; executable: boolean }> = [];
  async function walk(relative: string) {
    const entries = await NodeFSP.readdir(NodePath.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", ".DS_Store", "node_modules", "__pycache__"].includes(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === "SKILL.md") continue;
      const file = NodePath.join(root, name);
      const stat = await NodeFSP.lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Skill resource is a symlink: ${name}`);
      if (stat.isDirectory()) {
        await walk(name);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Skill resource is not a regular file: ${name}`);
      if (stat.size > MAX_SKILL_RESOURCE_BYTES)
        throw new Error(`Skill resource exceeds 1 MiB: ${name}`);
      resources.push({
        path: name,
        contentBase64: (await NodeFSP.readFile(file)).toString("base64"),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  }
  await walk("");
  return decodeResources(resources);
}

export const SkillImportManifest = Schema.Struct({
  environmentId: Schema.String,
  skills: Schema.Array(Schema.Struct({ skillId: Schema.String, directory: Schema.String })),
});

export function removeResourceWorkaround(content: string, directory: string) {
  return content.replace(
    /\n## Supporting resources in T3\r?\n([\s\S]*?)(?=\n#{1,2} |$)/,
    (section, body: string) => {
      if (
        !body.includes(`original skill directory: \`${directory}\``) ||
        !body.includes("T3 syncs this text, not those files.")
      ) {
        throw new Error(
          "Unrecognized supporting-resources workaround; retain it for manual review.",
        );
      }
      return "\n";
    },
  );
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const readLibrary = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(AgentSkill) }));

/** Two-phase migration: prove persisted resources before removing the local-path workaround. */
export async function migrateSkillResources(
  manifest: typeof SkillImportManifest.Type,
  call: CallTool,
) {
  const packed = await Promise.all(
    manifest.skills.map(async (entry) => ({
      ...entry,
      resources: await packSkillResources(entry.directory),
    })),
  );
  const read = async () =>
    readLibrary(await call("t3_list_skills", { environmentId: manifest.environmentId })).items;
  const initial = await read();
  // Preflight every identity and workaround before mutating any skill. Never create duplicates.
  for (const entry of packed) {
    const skill = initial.find((item) => item.skillId === entry.skillId);
    if (!skill) throw new Error(`Skill not found: ${entry.skillId}`);
    removeResourceWorkaround(skill.content, entry.directory);
  }
  for (const entry of packed) {
    await call("t3_update_skill", {
      environmentId: manifest.environmentId,
      skillId: entry.skillId,
      patch: { resources: entry.resources },
    });
    const stored = (await read()).find((item) => item.skillId === entry.skillId);
    if (!stored || JSON.stringify(stored.resources) !== JSON.stringify(entry.resources)) {
      throw new Error(
        `Resources were not retained for ${entry.skillId}; update all ${APP_NAME} clients and servers. Workaround retained.`,
      );
    }
    const content = removeResourceWorkaround(stored.content, entry.directory);
    if (content !== stored.content) {
      await call("t3_update_skill", {
        environmentId: manifest.environmentId,
        skillId: entry.skillId,
        patch: { content },
      });
      const verified = (await read()).find((item) => item.skillId === entry.skillId);
      if (
        !verified ||
        verified.content !== content ||
        JSON.stringify(verified.resources) !== JSON.stringify(entry.resources)
      )
        throw new Error(`Migration read-back failed for ${entry.skillId}.`);
    }
  }
  return packed.map((entry) => ({ skillId: entry.skillId, files: entry.resources.length }));
}

const decodeBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Unknown }));
const decodeSync = Schema.decodeUnknownSync(
  Schema.Struct({
    sync: Schema.optionalKey(
      Schema.Struct({
        failedEnvironmentIds: Schema.Array(Schema.String),
        // Older servers report only the ids.
        failures: Schema.optionalKey(
          Schema.Array(Schema.Struct({ environmentId: Schema.String, reason: Schema.String })),
        ),
      }),
    ),
  }),
);

/** Decode the gateway's versioned MCP envelope, including its structured/text transports. */
export async function callSkillImportTool(
  client: Pick<Client, "callTool">,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`MCP ${name} failed: ${JSON.stringify(result.content)}`);
  const blocks = decodeBlocks(result.content);
  const text = blocks.find((part) => part.type === "text")?.text;
  const envelope = result.structuredContent ?? (text === undefined ? undefined : decodeJson(text));
  const { data } = decodeEnvelope(envelope);
  const syncResult = decodeSync(data);
  const sync = syncResult.sync;
  if (sync?.failedEnvironmentIds.length) {
    const failed =
      sync.failures?.map(({ environmentId, reason }) => `${environmentId} (${reason})`) ??
      sync.failedEnvironmentIds;
    throw new Error(
      `Skill replication failed on ${failed.join(", ")}. Update/reconnect those environments and retry; workaround retained.`,
    );
  }
  return data;
}
