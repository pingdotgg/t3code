/**
 * The actions enabled plugins offer, and running one.
 *
 * Actions come from the manifest of each enabled installation, so listing
 * them never starts a plugin. Each listed action carries an id naming the
 * installation's registration (`<installationId>:<generation>:<name>`). An
 * invoke with an id from an earlier registration is refused as `stale`, and
 * the catalogue's own generation check refuses one that races a re-enable,
 * so a click never reaches a plugin the list did not show. The list is
 * bounded per environment (see `PluginActionsSnapshot`), and only listed
 * actions run.
 *
 * Running an action calls the plugin's `action:<name>` handler with the
 * resolved target (see pluginApi.ts) under a deadline. Interrupting the
 * caller (a client that goes away) cancels the call.
 */
import {
  PLUGIN_ACTION_MESSAGE_MAX_LENGTH,
  PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT,
  PLUGIN_ACTIONS_MAX_PER_PLUGIN,
  PLUGIN_ACTIONS_SNAPSHOT_MAX_BYTES,
  PluginActionError,
  PluginActionId,
  PluginInstallationId,
  pluginInstallationStatus,
  type PluginAction,
  type PluginActionInvokeInput,
  type PluginActionInvokeResult,
  type PluginActionsSnapshot,
  type PluginActionTarget,
  type PluginCatalogError,
  type PluginCatalogSnapshot,
  type PluginInstallation,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { PluginCatalog } from "./PluginCatalog.ts";
import type { PluginInvokeError } from "./PluginSupervisor.ts";

const PLUGIN_ACTION_TIMEOUT: Duration.Input = "30 seconds";

/** What an action handler receives as `input.target`: the target the user picked, resolved. */
type PluginActionTargetContext =
  | { readonly kind: "environment" }
  | { readonly kind: "project"; readonly projectId: string; readonly workspaceRoot: string }
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly projectId: string;
      /** The thread's worktree, or its project's workspace root. */
      readonly cwd: string;
      readonly branch: string | null;
    };

/** Looks a target up in this environment's projects and threads; none when it does not exist here. */
const resolvePluginActionTargetFrom =
  <ThreadError, ProjectError>(lookups: {
    readonly getThreadShell: (threadId: ThreadId) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly worktreePath: string | null;
        readonly branch: string | null;
      } | null,
      ThreadError
    >;
    readonly getProjectShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<{ readonly workspaceRoot: string }>, ProjectError>;
  }) =>
  (
    target: PluginActionTarget,
  ): Effect.Effect<Option.Option<PluginActionTargetContext>, PluginActionError> =>
    Effect.gen(function* () {
      switch (target._tag) {
        case "environment":
          return Option.some({ kind: "environment" as const });
        case "project": {
          const project = yield* lookups.getProjectShell(target.projectId);
          return Option.map(project, (shell) => ({
            kind: "project" as const,
            projectId: target.projectId,
            workspaceRoot: shell.workspaceRoot,
          }));
        }
        case "thread": {
          const thread = yield* lookups.getThreadShell(target.threadId);
          if (thread === null) return Option.none();
          const project = yield* lookups.getProjectShell(thread.projectId);
          if (Option.isNone(project)) return Option.none();
          return Option.some({
            kind: "thread" as const,
            threadId: target.threadId,
            projectId: thread.projectId,
            cwd: thread.worktreePath ?? project.value.workspaceRoot,
            branch: thread.branch,
          });
        }
      }
    }).pipe(
      Effect.mapError(() => actionError("unavailable", "Could not look up the action's target.")),
    );

export class PluginActions extends Context.Service<
  PluginActions,
  {
    /** The current actions now, then a new list whenever it changes. */
    readonly subscribe: Stream.Stream<PluginActionsSnapshot>;
    readonly invoke: (
      input: PluginActionInvokeInput,
    ) => Effect.Effect<PluginActionInvokeResult, PluginActionError>;
  }
>()("t3/plugins/PluginActions") {}

const pluginActionHandlerName = (name: string) => `action:${name}`;

const actionId = (installationId: string, generation: number, name: string) =>
  PluginActionId.make(`${installationId}:${generation}:${name}`);

const decodeInstallationId = Schema.decodeUnknownOption(PluginInstallationId);

/** The parts of an id this server issued; undefined for anything else. */
const parseActionId = (id: PluginActionId) => {
  const parts = id.split(":");
  const name = parts.pop();
  const generationText = parts.pop();
  if (name === undefined || generationText === undefined || !/^[0-9]+$/.test(generationText))
    return undefined;
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) return undefined;
  const segment = parts.join(":");
  const installationId = decodeInstallationId(segment);
  if (Option.isNone(installationId) || installationId.value !== segment) return undefined;
  return { installationId: installationId.value, generation, name };
};

/** The actions one installation offers on its own: enabled and able to run now. */
const installationActions = (installation: PluginInstallation): ReadonlyArray<PluginAction> => {
  const { manifest } = installation;
  if (manifest === null || pluginInstallationStatus(installation) !== "enabled") return [];
  if (!manifest.capabilities.includes("actions")) return [];
  // These wait for someone to resume them; an action could only fail.
  const state = installation.hostState?._tag;
  if (state === "quarantined" || state === "incompatible") return [];
  return (manifest.actions ?? []).slice(0, PLUGIN_ACTIONS_MAX_PER_PLUGIN).map((declaration) => ({
    id: actionId(installation.installationId, installation.generation, declaration.name),
    pluginId: manifest.id,
    pluginName: manifest.name,
    name: declaration.name,
    title: declaration.title,
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    target: declaration.target,
    placements: declaration.placements,
  }));
};

// Room for the frame around the actions: `{"actions":[`, `]`, and `omitted`.
const SNAPSHOT_ENVELOPE_BYTES = 128;
const ACTIONS_MAX_BYTES = PLUGIN_ACTIONS_SNAPSHOT_MAX_BYTES - SNAPSHOT_ENVELOPE_BYTES;

/** Each action's JSON plus its separator. */
const encodedBytes = (actions: ReadonlyArray<PluginAction>) =>
  actions.reduce((total, action) => total + Buffer.byteLength(JSON.stringify(action)) + 1, 0);

/**
 * The actions a catalogue snapshot offers. Plugins are taken whole, in
 * catalogue order, until one would pass the environment's action or byte
 * bound; it and every later plugin are counted in `omitted` instead.
 */
export const pluginActionsFromCatalog = (
  snapshot: PluginCatalogSnapshot,
): PluginActionsSnapshot => {
  const actions: Array<PluginAction> = [];
  let bytes = 0;
  const omitted = { plugins: 0, actions: 0 };
  for (const installation of snapshot.installations) {
    const offered = installationActions(installation);
    if (offered.length === 0) continue;
    if (omitted.plugins === 0) {
      const size = encodedBytes(offered);
      if (
        actions.length + offered.length <= PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT &&
        bytes + size <= ACTIONS_MAX_BYTES
      ) {
        actions.push(...offered);
        bytes += size;
        continue;
      }
    }
    omitted.plugins += 1;
    omitted.actions += offered.length;
  }
  return omitted.plugins === 0 ? { actions } : { actions, omitted };
};

const actionError = (reason: string, message: string) =>
  new PluginActionError({ reason, message: bound(message) });

/** At most the message bound, without splitting a surrogate pair. */
const bound = (text: string) => {
  const characters = Array.from(text);
  return characters.length <= PLUGIN_ACTION_MESSAGE_MAX_LENGTH
    ? text
    : `${characters.slice(0, PLUGIN_ACTION_MESSAGE_MAX_LENGTH - 1).join("")}…`;
};

/** A plugin's `{ message }`, if it returned one. */
const resultMessage = (value: Schema.Json): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = (value as { readonly [key: string]: Schema.Json })["message"];
  if (typeof message !== "string" || message.trim() === "") return null;
  return bound(message.trim());
};

const fromInvokeError = (
  error: PluginCatalogError | PluginInvokeError,
  title: string,
): PluginActionError => {
  switch (error._tag) {
    case "PluginCatalogError":
      return error.reason === "generation-changed"
        ? actionError("stale", "The plugin was enabled again since this action was listed.")
        : error.reason === "not-found"
          ? actionError("not-found", "That plugin is no longer installed.")
          : actionError("unavailable", error.message);
    case "PluginTimeoutError":
      return actionError("timeout", `${title} did not finish in time.`);
    case "PluginBusyError":
      return actionError("busy", `${title} could not start: the plugin is busy.`);
    case "PluginStoppedError":
      return actionError("stopped", "The plugin was disabled while the action ran.");
    case "PluginCallFailedError":
      return actionError("failed", error.reason);
    default:
      return actionError("unavailable", error.message);
  }
};

export const make = Effect.fn("PluginActions.make")(function* () {
  const catalog = yield* PluginCatalog;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const resolveTarget = resolvePluginActionTargetFrom({
    getThreadShell: threads.getThreadShell,
    getProjectShell: projects.getShell,
  });

  const invoke = Effect.fn("PluginActions.invoke")(function* (input: PluginActionInvokeInput) {
    const parsed = parseActionId(input.actionId);
    if (parsed === undefined)
      return yield* actionError("not-found", "That action is not available here.");
    const snapshot = yield* catalog.list;
    const installation = snapshot.installations.find(
      (candidate) => candidate.installationId === parsed.installationId,
    );
    if (installation === undefined)
      return yield* actionError("not-found", "That plugin is no longer installed.");
    if (installation.generation !== parsed.generation)
      return yield* actionError(
        "stale",
        "The plugin was enabled again since this action was listed.",
      );
    // Only what the list offers runs, so an action left out by the bounds cannot.
    const action = pluginActionsFromCatalog(snapshot).actions.find(
      (candidate) => candidate.id === input.actionId,
    );
    if (action === undefined)
      return yield* installationActions(installation).some(
        (candidate) => candidate.name === parsed.name,
      )
        ? actionError(
            "not-found",
            "That action is not offered: this environment's plugins declare more actions than it shows.",
          )
        : actionError("not-found", "That action is not available now.");
    if (action.target !== input.target._tag)
      return yield* actionError("target-mismatch", `${action.title} runs on a ${action.target}.`);
    const target = yield* resolveTarget(input.target);
    if (Option.isNone(target))
      return yield* actionError("target-not-found", `That ${action.target} does not exist here.`);
    const value = yield* catalog
      .invoke(
        installation.installationId,
        pluginActionHandlerName(action.name),
        { action: action.name, target: target.value },
        { generation: parsed.generation, timeout: PLUGIN_ACTION_TIMEOUT },
      )
      .pipe(Effect.mapError((error) => fromInvokeError(error, action.title)));
    return { message: resultMessage(value) };
  });

  return PluginActions.of({
    // Process state changes reach the catalogue too; most leave the list as it was.
    subscribe: catalog.subscribe.pipe(Stream.map(pluginActionsFromCatalog), Stream.changes),
    invoke,
  });
});

export const layer = Layer.effect(PluginActions, make());
