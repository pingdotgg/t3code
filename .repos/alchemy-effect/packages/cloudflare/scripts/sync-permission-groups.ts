/**
 * Regenerate `src/ApiToken/PermissionGroups.ts` from Cloudflare's live
 * permission-group catalog.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm -C packages/cloudflare sync:permission-groups
 *   pnpm -C packages/cloudflare sync:permission-groups --input groups.json   # from a saved listing
 *
 * Run weekly by `.github/workflows/sync-cloudflare-permission-groups.yml`.
 *
 * The sync never drops a name, so a regenerated catalog can't break a config
 * that type-checks today:
 *
 *   - a group Cloudflare renamed keeps its former name as an alias on the
 *     same id;
 *   - a group the listing no longer returns is retained. The listing is
 *     filtered by what the account can see, so absence doesn't mean retired.
 */
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { PERMISSION_GROUPS } from "../src/ApiToken/PermissionGroups.ts";

interface Group {
  id: string;
  name: string;
  description: string;
  scopes: readonly string[];
}

const CATALOG = "src/ApiToken/PermissionGroups.ts";

const fetchGroups = Effect.gen(function* () {
  const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const groups = yield* accounts.listTokensPermissionGroups({ accountId });
  return groups.map((group): Group => ({
    id: group.id ?? "",
    name: group.name ?? "",
    description: group.description ?? "",
    scopes: group.scopes ?? [],
  }));
}).pipe(Effect.provide(Layer.mergeAll(Credentials.fromEnv(), FetchHttpClient.layer)));

const readGroups = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return JSON.parse(yield* fs.readFileString(file)) as Group[];
});

/** Live groups first, then the previous catalog's names the listing lacks. */
const merge = (live: Group[], previous: readonly Group[]) => {
  const key = (group: Group) => `${group.id}\0${group.name}`;
  const seen = new Set<string>();
  const unique = (group: Group) => !seen.has(key(group)) && !!seen.add(key(group));
  const liveById = new Map(live.map((group) => [group.id, group]));

  const groups = live.filter(unique);
  const unlisted = previous.filter((group) => !liveById.has(group.id)).filter(unique);
  const renamed = previous
    .filter((group) => liveById.has(group.id))
    .filter(unique)
    // Keep the old name, but describe the group as Cloudflare does today.
    .map((group) => ({ ...liveById.get(group.id)!, name: group.name }));
  return { groups, unlisted, renamed };
};

const entry = (group: Group) =>
  `  {
    id: ${JSON.stringify(group.id)},
    name: ${JSON.stringify(group.name)},
    description: ${JSON.stringify(group.description)},
    scopes: ${JSON.stringify(group.scopes)},
  },`;

const section = (comment: string, groups: Group[]) =>
  groups.length === 0 ? [] : [comment, ...groups.map(entry)];

const render = ({ groups, unlisted, renamed }: ReturnType<typeof merge>) => `/**
 * Static catalog of Cloudflare API token permission groups, copied from the
 * upstream \`alchemy\` repo so we can offer typed permission-group names without
 * a network round-trip on every token create/update.
 *
 * Refreshed from \`GET /accounts/{account_id}/tokens/permission_groups\`.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */

export interface PermissionGroup {
  id: string;
  name: string;
  description: string;
  scopes: readonly string[];
}

export const PERMISSION_GROUPS = [
${[
  ...groups.map(entry),
  ...section(
    "  // No longer listed by Cloudflare's permission-groups API; kept so existing\n  // configs that reference them keep resolving.",
    unlisted,
  ),
  ...section(
    "  // Former names of groups Cloudflare has since renamed, kept so existing\n  // configs that reference them by name keep resolving.",
    renamed,
  ),
].join("\n")}
] as const;

export type PermissionGroupName = (typeof PERMISSION_GROUPS)[number]["name"];

/**
 * Lookup map from permission-group name to the first matching permission group.
 *
 * Some Cloudflare names appear twice (e.g. account-scope and zone-scope variants
 * sharing a label). We keep the first occurrence; callers that need a specific
 * scope should pass \`{ id }\` directly instead of using the name shorthand.
 */
export const PERMISSION_GROUPS_BY_NAME: Record<PermissionGroupName, PermissionGroup> = (() => {
  const map = {} as Record<PermissionGroupName, PermissionGroup>;
  for (const group of PERMISSION_GROUPS) {
    if (!(group.name in map)) {
      map[group.name as PermissionGroupName] = group;
    }
  }
  return map;
})();
`;

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inputIndex = process.argv.indexOf("--input");
  const live =
    inputIndex === -1 ? yield* fetchGroups : yield* readGroups(process.argv[inputIndex + 1]!);
  if (live.length === 0) {
    return yield* Effect.die("Cloudflare returned no permission groups; refusing to sync.");
  }

  const merged = merge(live, PERMISSION_GROUPS);
  const file = path.join(import.meta.dirname, "..", CATALOG);
  yield* fs.writeFileString(file, render(merged));
  const spawner = yield* ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make("pnpm", ["exec", "oxfmt", file]));
  if (exitCode !== 0) {
    return yield* Effect.die(`oxfmt exited with code ${exitCode}`);
  }
  yield* Effect.log(
    `${CATALOG}: ${merged.groups.length} listed, ${merged.unlisted.length} unlisted, ${merged.renamed.length} renamed`,
  );
});

main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
