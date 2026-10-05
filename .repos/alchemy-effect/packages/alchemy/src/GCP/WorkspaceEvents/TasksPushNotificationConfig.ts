import * as we from "@distilled.cloud/gcp/workspaceevents_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configIdOf,
  getConfig,
  jsonEqual,
  MAX_CONFIG_ID_LENGTH,
  parentOfConfig,
  toConfigName,
  toPhysicalId,
  toTaskName,
} from "./internal.ts";

export type AuthenticationInfo = {
  /** Supported authentication schemes (`Basic`, `Bearer`, …). */
  schemes?: string[];
  /** Optional credentials sent with the notification. */
  credentials?: string;
};

export type PushNotificationConfig = {
  /** HTTPS URL that receives task updates. */
  url?: string;
  /** Authentication attached to each notification. */
  authentication?: AuthenticationInfo;
  /** Client token unique for this task or session. */
  token?: string;
  /** Client-assigned identifier for this push configuration. */
  id?: string;
};

export type TasksPushNotificationConfigProps = {
  /**
   * Parent task (`tasks/{task}` or `{task}`). Immutable — changing it
   * replaces the config.
   */
  task: string;
  /**
   * Config id (the `{config}` segment of
   * `tasks/{task}/pushNotificationConfigs/{config}`). If omitted, a
   * unique RFC1035 name is generated. Immutable — changing it replaces
   * the config.
   */
  configId?: string;
  /**
   * HTTPS URL that receives task updates.
   */
  url: string;
  /**
   * Authentication attached to each notification.
   */
  authentication?: AuthenticationInfo;
  /**
   * Client token unique for this task or session, sent with every
   * notification as given.
   */
  token?: string;
  /**
   * Optional tenant path parameter (experimental).
   */
  tenant?: string;
};

export type TasksPushNotificationConfig = Resource<
  "GCP.WorkspaceEvents.TasksPushNotificationConfig",
  TasksPushNotificationConfigProps,
  {
    /** Full resource name `tasks/{task}/pushNotificationConfigs/{config}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Parent task resource name. */
    task: string;
    /** Project id used when the config was reconciled. */
    project: string;
    /** HTTPS URL that receives task updates. */
    url: string | undefined;
    /** Authentication attached to each notification. */
    authentication: AuthenticationInfo | undefined;
    /** Client token. */
    token: string | undefined;
    /** Client-assigned identifier. */
    notificationId: string | undefined;
    /** Optional tenant. */
    tenant: string | undefined;
  },
  never,
  Providers
>;

/**
 * A push-notification config for a Workspace Events / A2A task.
 *
 * The API has no labels field and the token is sent to the receiver, so
 * Alchemy writes no ownership marker: it tracks the config by name (a
 * generated config id embeds the stack, stage, and logical id). Task and config id
 * are identity — changing either replaces the config. There is no patch
 * method; changing the URL, token, or authentication replaces the
 * config. Creating a config requires an existing task.
 *
 * ### Creating a Config
 * **Example:** HTTPS webhook for a task
 * ```typescript
 * const config = yield* GCP.WorkspaceEvents.TasksPushNotificationConfig(
 *   "Updates",
 *   {
 *     task: "tasks/TASK_ID",
 *     url: "https://example.com/workspace-events",
 *   },
 * );
 * ```
 *
 * **Example:** Bearer authentication
 * ```typescript
 * const config = yield* GCP.WorkspaceEvents.TasksPushNotificationConfig(
 *   "Updates",
 *   {
 *     task: "tasks/TASK_ID",
 *     url: "https://example.com/workspace-events",
 *     authentication: { schemes: ["Bearer"], credentials: "token" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category WorkspaceEvents
 */
export const TasksPushNotificationConfig =
  Resource<TasksPushNotificationConfig>(
    "GCP.WorkspaceEvents.TasksPushNotificationConfig",
  );

export class TasksPushNotificationConfigNotResolved extends Data.TaggedError(
  "GCP.WorkspaceEvents.TasksPushNotificationConfigNotResolved",
)<{
  name: string;
}> {}

const authOf = (
  auth: we.AuthenticationInfo | undefined,
): AuthenticationInfo | undefined => {
  if (auth === undefined) return undefined;
  return {
    schemes: auth.schemes,
    credentials: auth.credentials,
  };
};

const toAttrs = (
  config: we.TaskPushNotificationConfig,
  project: string,
  tenant: string | undefined,
) => {
  const name = config.name ?? "";
  const push = config.pushNotificationConfig;
  return {
    name,
    configId: configIdOf(name),
    task: parentOfConfig(name),
    project,
    url: push?.url,
    authentication: authOf(push?.authentication),
    token: push?.token,
    notificationId: push?.id,
    tenant,
  };
};

export const TasksPushNotificationConfigProvider = () =>
  Provider.succeed(TasksPushNotificationConfig, {
    stables: ["name", "configId", "task", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousTask = olds?.task ?? output?.task;
      const nextTask = toTaskName(news.task);
      const previousId = olds?.configId ?? output?.configId;
      const identityChanged =
        (previousTask !== undefined && toTaskName(previousTask) !== nextTask) ||
        (previousId !== undefined &&
          news.configId !== undefined &&
          news.configId !== previousId);
      const previousUrl = olds?.url ?? output?.url;
      const previousToken = olds?.token ?? output?.token;
      const previousAuth = olds?.authentication ?? output?.authentication;
      const payloadChanged =
        (previousUrl !== undefined && news.url !== previousUrl) ||
        (news.token !== undefined &&
          previousToken !== undefined &&
          news.token !== previousToken) ||
        (news.authentication !== undefined &&
          previousAuth !== undefined &&
          !jsonEqual(news.authentication, previousAuth));
      if (!identityChanged && !payloadChanged) return undefined;
      const samePhysical =
        previousTask !== undefined &&
        toTaskName(previousTask) === nextTask &&
        previousId !== undefined &&
        (news.configId === undefined || news.configId === previousId);
      return {
        action: "replace" as const,
        deleteFirst: samePhysical,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const task = toTaskName(olds?.task ?? output?.task ?? "");
      const configId = yield* toPhysicalId(
        id,
        olds?.configId,
        output?.configId,
        "config",
        MAX_CONFIG_ID_LENGTH,
      );
      const name = output?.name ?? toConfigName(task, configId);
      const existing = yield* getConfig(name, olds?.tenant ?? output?.tenant);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        olds?.tenant ?? output?.tenant,
      );
      // Only an explicit config id found without state is ambiguous.
      return output === undefined && olds?.configId !== undefined
        ? Unowned(attrs)
        : attrs;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const task = toTaskName(news.task);
      const configId = yield* toPhysicalId(
        id,
        news.configId,
        output?.configId,
        "config",
        MAX_CONFIG_ID_LENGTH,
      );
      const name = output?.name ?? toConfigName(task, configId);
      const token = news.token;

      let current = yield* getConfig(name, news.tenant);

      if (current === undefined) {
        const created = yield* we
          .createTasksPushNotificationConfigs({
            parent: task,
            configId,
            tenant: news.tenant,
            body: {
              name,
              pushNotificationConfig: {
                url: news.url,
                authentication: news.authentication,
                token,
                id: configId,
              },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => getConfig(name, news.tenant)),
          );
        current = created ?? (yield* getConfig(name, news.tenant));
      }

      if (current === undefined) {
        return yield* new TasksPushNotificationConfigNotResolved({ name });
      }

      return toAttrs(current, env.project, news.tenant);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name || toConfigName(output.task, output.configId);
      if (name.length === 0) return;
      yield* we
        .deleteTasksPushNotificationConfigs({
          name,
          tenant: output.tenant,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
