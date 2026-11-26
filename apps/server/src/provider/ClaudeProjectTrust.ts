import {
  type ClaudeProjectCommand,
  ClaudeProjectTrustError,
  managedPolicyDeniedMessage,
  ProjectId,
  type WorkspaceClaudeProjectTrustResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { claudeLocalSettingsDirectory } from "./Drivers/ClaudeHome.ts";

/** What a session of an untrusted project opens with in place of its folder's configuration. */
export interface ClaudeUntrustedSessionConfig {
  /**
   * Claude Code's `projectConfigRoot`: a folder T3 Code wrote that holds the folder's deny and
   * ask rules and links to its commands, skills, agents and files, and nothing that runs by itself.
   */
  readonly projectConfigRoot: string;
  /** The line the thread shows about what was left out. */
  readonly notice: string;
}

/**
 * Whether a person trusts a project's Claude Code settings. Below Full access an untrusted
 * project's sessions leave out what its folder makes Claude Code run by itself: hooks, helper
 * commands, `.mcp.json` servers and `env`. Read side only; `ClaudeProjectTrustWrites` records it.
 */
export class ClaudeProjectTrust extends Context.Service<
  ClaudeProjectTrust,
  {
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
    }) => Effect.Effect<WorkspaceClaudeProjectTrustResult, ClaudeProjectTrustError>;
    /**
     * For a session about to open in `cwd`. Null opens it on the folder as it is. `session` names
     * the one process that reads the answer's folder at a time; the folder is kept for the scope.
     */
    readonly forSession: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
      readonly session: string;
      readonly fullAccess: boolean;
    }) => Effect.Effect<ClaudeUntrustedSessionConfig | null, ClaudeProjectTrustError, Scope.Scope>;
    /**
     * For Claude Code started in `cwd` outside a session, to list its commands or generate text:
     * no permission mode there, so trust and policy alone decide. Null runs it on the folder;
     * else its `projectConfigRoot`, kept for the scope. A folder of no project is not trusted.
     */
    readonly forFolder: (input: {
      readonly cwd: string;
      readonly projectId?: ProjectId | null | undefined;
    }) => Effect.Effect<string | null, ClaudeProjectTrustError, Scope.Scope>;
  }
>()("t3/provider/ClaudeProjectTrust") {}

export const failed = (detail: string) => (cause: unknown) =>
  new ClaudeProjectTrustError({ detail, cause });

const LEFT_OUT =
  "This session runs without the project's hooks, helper commands, MCP servers and environment variables.";
const UNTRUSTED_NOTICE = `This project's Claude Code settings are not trusted. ${LEFT_OUT} Trust the project in this thread or in the project's settings; that applies from the next session on.`;

type Settings = Readonly<Record<string, unknown>>;

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const text = (value: unknown) => (typeof value === "string" ? value : encodeJson(value));

const hookDetail = (hook: unknown) => {
  if (Predicate.isObject(hook)) {
    for (const key of ["command", "url", "prompt"] as const) {
      const value = hook[key];
      if (typeof value === "string") return value;
    }
  }
  return encodeJson(hook);
};

/** Every hook a settings file's `hooks` holds. A shape Claude Code may not know is shown as it is written. */
const listHooks = (
  source: ClaudeProjectCommand["source"],
  hooks: unknown,
): ReadonlyArray<ClaudeProjectCommand> => {
  if (hooks === undefined || hooks === null) return [];
  if (!Predicate.isObject(hooks)) {
    return [{ kind: "hook", source, event: "", detail: encodeJson(hooks) }];
  }
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : [groups]).flatMap(
      (group): ReadonlyArray<ClaudeProjectCommand> => {
        if (!Predicate.isObject(group) || !Array.isArray(group.hooks)) {
          return [{ kind: "hook", source, event, detail: encodeJson(group) }];
        }
        const matcher =
          typeof group.matcher === "string" && group.matcher.length > 0
            ? { matcher: group.matcher }
            : {};
        return group.hooks.map((hook) => ({
          kind: "hook" as const,
          source,
          event,
          ...matcher,
          detail: hookDetail(hook),
        }));
      },
    ),
  );
};

/**
 * Settings that name a command Claude Code runs by itself to fetch credentials or headers. A
 * project's own `env` can select the provider or exporter that makes Claude Code run one.
 */
const HELPER_KEYS = [
  "apiKeyHelper",
  "proxyAuthHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
] as const;

const entries = (value: unknown) => (Predicate.isObject(value) ? Object.entries(value) : []);

/** What a settings file makes Claude Code run or set by itself. */
const listSettings = (
  source: "project" | "local",
  settings: Settings | undefined,
): ReadonlyArray<ClaudeProjectCommand> =>
  settings === undefined
    ? []
    : [
        ...listHooks(source, settings.hooks),
        ...HELPER_KEYS.flatMap((key): ReadonlyArray<ClaudeProjectCommand> => {
          const value = settings[key];
          return value === undefined || value === null
            ? []
            : [{ kind: "helper", source, event: key, detail: text(value) }];
        }),
        // A variable such as `BASH_ENV` names a script every shell the session starts runs.
        ...entries(settings.env).map(([name, value]) => ({
          kind: "env" as const,
          source,
          event: name,
          detail: text(value),
        })),
      ];

const listMcpServers = (config: Settings | undefined): ReadonlyArray<ClaudeProjectCommand> =>
  entries(config?.mcpServers).map(([name, server]) => ({
    kind: "mcp",
    source: "mcp",
    event: name,
    detail:
      Predicate.isObject(server) && typeof server.command === "string"
        ? [server.command, ...(Array.isArray(server.args) ? server.args.map(text) : [])].join(" ")
        : Predicate.isObject(server) && typeof server.url === "string"
          ? server.url
          : encodeJson(server),
  }));

/** The rules of a settings file that only restrict: the ones an untrusted session keeps. */
const rules = (settings: Settings, key: "deny" | "ask"): ReadonlyArray<unknown> => {
  const permissions = settings.permissions;
  const list = Predicate.isObject(permissions) ? permissions[key] : undefined;
  return Array.isArray(list) ? list : [];
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const offBy = ManagedPolicy.deniedBy(managedPolicy, "claudeProjectHooks");

  const findTrust = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: Schema.Struct({ projectId: ProjectId }),
    execute: (projectId) => sql`
      SELECT project_id AS "projectId" FROM claude_trusted_projects
      WHERE project_id = ${projectId}
    `,
  });
  const statusOf = (projectId: ProjectId) =>
    offBy !== undefined
      ? Effect.succeed("off" as const)
      : findTrust(projectId).pipe(
          Effect.map((row) => (Option.isSome(row) ? ("trusted" as const) : ("untrusted" as const))),
          Effect.mapError(failed("Could not read whether the project is trusted.")),
        );

  // The key is the one `orchestration_v2_projection_threads_worktree_path_key_idx` holds, so the
  // lookup never scans; the exact comparison after it keeps a folder that differs in case out.
  const findFolderProjects = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ projectId: ProjectId }),
    execute: (folder) => sql`
      SELECT project_id AS "projectId" FROM projection_projects
      WHERE deleted_at IS NULL AND workspace_root = ${folder}
      UNION
      SELECT project_id AS "projectId" FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND CASE WHEN json_valid(payload_json)
          THEN lower(rtrim(replace(trim(json_extract(payload_json, '$.worktreePath')), '\\', '/'), '/'))
        END = lower(rtrim(replace(trim(${folder}), '\\', '/'), '/'))
        AND json_extract(payload_json, '$.worktreePath') = ${folder}
    `,
  });
  /** Whether every project `cwd` is the folder or a thread worktree of is trusted. */
  const folderIsTrusted = Effect.fn("ClaudeProjectTrust.folderIsTrusted")(function* (
    cwd: string,
    projectId: ProjectId | null | undefined,
  ) {
    if (offBy !== undefined) return false;
    const projects =
      projectId === null || projectId === undefined
        ? (yield* findFolderProjects(path.resolve(cwd)).pipe(
            Effect.mapError(failed("Could not read which project the folder belongs to.")),
          )).map((row) => row.projectId)
        : [projectId];
    if (projects.length === 0) return false;
    const statuses = yield* Effect.forEach(projects, statusOf);
    return statuses.every((status) => status === "trusted");
  });

  // A file Claude Code cannot read as settings gives it nothing to run either, so it counts as absent.
  const readJson = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((contents) => Option.getOrUndefined(decodeSettings(contents))),
      Effect.orElseSucceed(() => undefined),
    );

  /** The files Claude Code reads for a session in `cwd` that can make it run something. */
  const readFolder = Effect.fn("ClaudeProjectTrust.readFolder")(function* (cwd: string) {
    const localDirectory = yield* claudeLocalSettingsDirectory(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const readLocal = (directory: string) =>
      readJson(path.join(directory, ".claude", "settings.local.json"));
    const project = yield* readJson(path.join(cwd, ".claude", "settings.json"));
    // In a worktree Claude Code reads the main checkout's local file, and one left in cwd under it.
    const worktreeLocal = localDirectory === cwd ? undefined : yield* readLocal(cwd);
    const local = yield* readLocal(localDirectory);
    return {
      settings: [project, worktreeLocal, local].filter((file) => file !== undefined),
      commands: [
        ...listSettings("project", project),
        ...listSettings("local", worktreeLocal),
        ...listSettings("local", local),
        ...listMcpServers(yield* readJson(path.join(cwd, ".mcp.json"))),
      ],
    };
  });

  const configRoots = path.join(stateDir, "claude-project-config");
  const unprepared = failed("Could not prepare the Claude Code settings for the session.");

  /** Fills `root`, the folder Claude Code reads project configuration from in place of `cwd`. */
  const writeConfigRoot = Effect.fn("ClaudeProjectTrust.writeConfigRoot")(function* (
    cwd: string,
    root: string,
    settings: ReadonlyArray<Settings>,
  ) {
    yield* fileSystem.makeDirectory(path.join(root, ".claude"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(root, ".claude", "settings.json"),
      encodeJson({
        permissions: {
          deny: settings.flatMap((file) => rules(file, "deny")),
          ask: settings.flatMap((file) => rules(file, "ask")),
        },
      }),
    );
    const listed = (directory: string) =>
      fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    // Commands, skills, agents and rules files. Where links are not allowed, as on Windows
    // without developer mode, the session reads a copy taken now.
    yield* Effect.forEach(
      (yield* listed(path.join(cwd, ".claude"))).filter(
        (entry) => entry !== "settings.json" && entry !== "settings.local.json",
      ),
      (entry) => {
        const from = path.join(cwd, ".claude", entry);
        const to = path.join(root, ".claude", entry);
        return fileSystem
          .symlink(from, to)
          .pipe(Effect.catch(() => fileSystem.copy(from, to, { overwrite: true })));
      },
      { discard: true },
    );
    // Claude Code runs the user's own hooks in this folder and names it in `CLAUDE_PROJECT_DIR`,
    // so the project's files are linked in for the paths those hooks use. Not `.git`: Git run
    // here would take the links for the project's files. Not `.mcp.json`: its servers stay off.
    yield* Effect.forEach(
      (yield* listed(cwd)).filter(
        (entry) => entry !== ".claude" && entry !== ".git" && entry !== ".mcp.json",
      ),
      (entry) =>
        fileSystem.symlink(path.join(cwd, entry), path.join(root, entry)).pipe(Effect.ignore),
      { discard: true },
    );
    return root;
  }, Effect.mapError(unprepared));

  /** A folder of its own under the state directory, removed when the scope closes. */
  const scopedConfigRoot = (prefix: string) =>
    Effect.acquireRelease(
      fileSystem
        .makeDirectory(configRoots, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.makeTempDirectory({ directory: configRoots, prefix })),
          Effect.mapError(unprepared),
        ),
      (root) => fileSystem.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
    );

  return ClaudeProjectTrust.of({
    read: Effect.fn("ClaudeProjectTrust.read")(function* ({ projectId, cwd }) {
      return {
        status: yield* statusOf(projectId),
        commands: (yield* readFolder(cwd)).commands,
      };
    }),
    forSession: Effect.fn("ClaudeProjectTrust.forSession")(function* ({
      projectId,
      cwd,
      session,
      fullAccess,
    }) {
      // Full access is decided first: it needs no answer from the database.
      if (fullAccess && offBy === undefined) return null;
      if ((yield* statusOf(projectId)) === "trusted") return null;
      const folder = yield* readFolder(cwd);
      // A folder with nothing to leave out is opened as it is, so the user's own hooks run in it.
      if (folder.commands.length === 0) return null;
      // One folder per start, so no process reads what another wrote there. An earlier start of
      // the same session has ended or is being replaced, so what it left is removed here.
      const prefix = `${Hex.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(session)),
      ).slice(0, 32)}-`;
      yield* fileSystem.readDirectory(configRoots).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.flatMap(
          Effect.forEach(
            (entry) =>
              entry.startsWith(prefix)
                ? fileSystem.remove(path.join(configRoots, entry), { recursive: true, force: true })
                : Effect.void,
            { discard: true },
          ),
        ),
        Effect.mapError(unprepared),
      );
      return {
        projectConfigRoot: yield* writeConfigRoot(
          cwd,
          yield* scopedConfigRoot(prefix),
          folder.settings,
        ),
        notice:
          offBy === undefined
            ? UNTRUSTED_NOTICE
            : `${managedPolicyDeniedMessage(offBy, "trusting a project's Claude Code settings")} ${LEFT_OUT}`,
      };
    }),
    forFolder: Effect.fn("ClaudeProjectTrust.forFolder")(function* ({ cwd, projectId }) {
      const folder = yield* readFolder(cwd);
      if (folder.commands.length === 0) return null;
      if (yield* folderIsTrusted(cwd, projectId)) return null;
      return yield* writeConfigRoot(cwd, yield* scopedConfigRoot("folder-"), folder.settings);
    }),
  });
});

export const layer = Layer.effect(ClaudeProjectTrust, make);

/** For code that opens Claude sessions where every project counts as trusted, as in tests. */
export const layerTrusted = Layer.mock(ClaudeProjectTrust)({
  forSession: () => Effect.succeed(null),
  forFolder: () => Effect.succeed(null),
});
