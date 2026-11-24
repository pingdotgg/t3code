import {
  ForkRoleId,
  OrchestratorMcpFailure,
  type ForkRole,
  type ForkRolesListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../os-jank.ts";
import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";
import * as ServerSettings from "../serverSettings.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const isForkRoleId = Schema.is(ForkRoleId);

export interface ParsedRoleFile {
  readonly name?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly brief: string;
}

export function parseRoleFile(contents: string): ParsedRoleFile {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { brief: contents.trim() };
  const brief = contents.slice(match[0].length).trim();
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { brief };
  }
  if (typeof parsed !== "object" || parsed === null) return { brief };
  const record = parsed as Record<string, unknown>;
  const field = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
  };
  return { ...field("name"), ...field("icon"), ...field("color"), brief };
}

export interface ForkRolesShape {
  readonly list: Effect.Effect<ForkRolesListResult>;
  /** The role file's body, or undefined when roles are off, the file is missing, or the body is empty. */
  readonly readBrief: (roleId: string) => Effect.Effect<string | undefined>;
}

/** Fork: role briefs in the `forkRolesDirectory` folder, read fresh on every call. Off unless provided. */
export class ForkRoles extends Context.Reference<ForkRolesShape>("t3/orchestration-v2/ForkRoles", {
  defaultValue: () => ({
    list: Effect.succeed({ directory: null, roles: [] }),
    readBrief: () => Effect.undefined,
  }),
}) {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const directory = serverSettings.getSettings.pipe(
    Effect.flatMap((settings) =>
      settings.forkRolesDirectory === ""
        ? Effect.succeed(null)
        : expandHomePath(settings.forkRolesDirectory).pipe(
            Effect.map((dir) => path.resolve(dir)),
            Effect.provideService(Path.Path, path),
          ),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("roles: settings read failed", { cause }).pipe(Effect.as(null)),
    ),
  );

  const rolePath = (dir: string, roleId: string) => {
    const file = path.resolve(dir, `${roleId}.md`);
    return path.dirname(file) === dir ? file : null;
  };

  const list: ForkRolesShape["list"] = Effect.gen(function* () {
    const dir = yield* directory;
    if (dir === null) return { directory: null, roles: [] };
    const entries = yield* fileSystem
      .readDirectory(dir)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("roles: directory unreadable", { path: dir, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
    if (entries === null) return { directory: null, roles: [] };
    const roles: Array<ForkRole> = [];
    for (const entry of entries.toSorted()) {
      if (!entry.endsWith(".md")) continue;
      const id = entry.slice(0, -".md".length);
      if (!isForkRoleId(id)) continue;
      const file = path.join(dir, entry);
      const contents = yield* fileSystem.readFileString(file).pipe(Effect.option);
      if (contents._tag === "None") continue;
      const { name, icon, color } = parseRoleFile(contents.value);
      roles.push({
        id,
        name: name ?? id,
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
        path: file,
      });
    }
    return { directory: dir, roles };
  });

  const readBrief: ForkRolesShape["readBrief"] = Effect.fn("ForkRoles.readBrief")(function* (
    roleId: string,
  ) {
    const dir = yield* directory;
    if (dir === null) return undefined;
    const file = isForkRoleId(roleId) ? rolePath(dir, roleId) : null;
    if (file === null) {
      yield* Effect.logWarning("roles: invalid role id", { roleId, path: dir });
      return undefined;
    }
    const contents = yield* fileSystem.readFileString(file).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("roles: role file missing or unreadable", {
          roleId,
          path: file,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );
    const brief = contents === undefined ? "" : parseRoleFile(contents).brief;
    return brief === "" ? undefined : brief;
  });

  return ForkRoles.of({ list, readBrief });
});

export const layer = Layer.effect(ForkRoles, make);

/** The role `t3_thread_organize` sets, once its file is confirmed to exist. */
export const forkRoleToSet = Effect.fn("ForkRoles.roleToSet")(function* (input: {
  readonly roleId?: ForkRoleId | undefined;
}) {
  const { directory, roles } = yield* (yield* ForkRoles).list;
  const invalid = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });
  if (directory === null) {
    return yield* invalid("No roles directory is set. Set it in Settings before assigning a role.");
  }
  const available = `Available roles: ${roles.map((role) => role.id).join(", ") || "none"}.`;
  if (input.roleId === undefined) return yield* invalid(`set_role requires roleId. ${available}`);
  if (!roles.some((role) => role.id === input.roleId)) {
    return yield* invalid(`No role file ${input.roleId}.md in ${directory}. ${available}`);
  }
  return input.roleId;
});

/** The `<role>` block a role thread's agent gets at session start, or undefined when it has no brief. */
export const forkRoleInstructions = Effect.fn("ForkRoles.instructions")(function* (
  roles: ForkRolesShape,
  roleId: string | null | undefined,
) {
  if (!roleId) return undefined;
  const brief = yield* roles.readBrief(roleId);
  if (brief === undefined) return undefined;
  return `<role id="${roleId}">\nThis thread holds a standing role. Its brief, from ${roleId}.md:\n\n${brief}\n</role>`;
});

/** Codex `turn/start` entries for the role block, split at line breaks to fit the per-entry cap. */
export function forkRoleCodexContext(roleInstructions: string | undefined) {
  if (!roleInstructions) return undefined;
  const chunks: Array<string> = [];
  let current = "";
  let bytes = 0;
  for (const char of roleInstructions) {
    const size = Buffer.byteLength(char);
    if (bytes + size > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      const cut = current.lastIndexOf("\n");
      chunks.push(cut > 0 ? current.slice(0, cut) : current);
      current = cut > 0 ? current.slice(cut + 1) : "";
      bytes = Buffer.byteLength(current);
    }
    current += char;
    bytes += size;
  }
  chunks.push(current);
  return Object.fromEntries(
    chunks.map((value, index) => [
      `t3_code_role_${String(index + 1).padStart(2, "0")}`,
      { kind: "application" as const, value },
    ]),
  );
}
