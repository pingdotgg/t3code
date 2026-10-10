import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_DISPLAY_NAME_LENGTH = 512;

export type NotificationChannelProps = {
  /**
   * Channel type. Must match a `NotificationChannelDescriptor.type`
   * (`email`, `webhook_tokenauth`, `pubsub`, `slack`, …). Immutable —
   * changing it replaces the channel.
   */
  type: string;
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id. Limited to 512 Unicode
   * characters.
   */
  displayName?: string;
  /**
   * Human-readable description. Limited to 1024 Unicode characters.
   */
  description?: string;
  /**
   * Type-specific configuration (for example `email_address` for `email`,
   * `url` for `webhook_tokenauth`). Not used for Alchemy ownership —
   * see `userLabels`.
   */
  labels?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  userLabels?: Record<string, string>;
  /**
   * Whether notifications are forwarded to this channel.
   * @default true
   */
  enabled?: boolean;
};

export type NotificationChannel = Resource<
  "GCP.Monitoring.NotificationChannel",
  NotificationChannelProps,
  {
    /** Full resource name `projects/{project}/notificationChannels/{channel}`. */
    name: string;
    /** Server-assigned channel id (last path segment). */
    notificationChannelId: string;
    /** Project id. */
    project: string;
    /** Channel type (`email`, `webhook_tokenauth`, …). */
    type: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** Type-specific configuration labels. */
    labels: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    userLabels: Record<string, string>;
    /** Whether notifications are forwarded to this channel. */
    enabled: boolean;
    /** Verification status (`UNVERIFIED`, `VERIFIED`, or unset). */
    verificationStatus: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring notification channel — email, webhook, Pub/Sub, or
 * another supported delivery type.
 *
 * Channel ids are assigned by the API. Alchemy stamps ownership into
 * `userLabels` so `list` / `pnpm nuke:gcp` can find them. Changing `type`
 * replaces the channel. Display name, description, labels, user labels,
 * and enabled update in place.
 *
 * ### Creating a Channel
 * **Example:** Email channel
 * ```typescript
 * const channel = yield* GCP.Monitoring.NotificationChannel("Alerts", {
 *   type: "email",
 *   labels: { email_address: "alerts@example.com" },
 * });
 * ```
 *
 * **Example:** Webhook channel with user labels
 * ```typescript
 * const channel = yield* GCP.Monitoring.NotificationChannel("Hooks", {
 *   type: "webhook_tokenauth",
 *   displayName: "incident webhook",
 *   labels: { url: "https://example.com/hooks/alerts" },
 *   userLabels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Channel
 * **Example:** Disable delivery without deleting the channel
 * ```typescript
 * const channel = yield* GCP.Monitoring.NotificationChannel("Alerts", {
 *   type: "email",
 *   labels: { email_address: "alerts@example.com" },
 *   enabled: false,
 * });
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const NotificationChannel = Resource<NotificationChannel>(
  "GCP.Monitoring.NotificationChannel",
);

export class NotificationChannelNotResolved extends Data.TaggedError(
  "GCP.Monitoring.NotificationChannelNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const parentOf = (project: string) => `projects/${project}`;

const userFacingLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const channelLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(labels);

const recordsEqual = (
  left: Record<string, string>,
  right: Record<string, string>,
) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
};

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      displayName ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_DISPLAY_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const toAttrs = (channel: monitoring.NotificationChannel, project: string) => {
  const name = channel.name ?? "";
  return {
    name,
    notificationChannelId: lastSegment(name),
    project,
    type: channel.type ?? "",
    displayName: channel.displayName,
    description: channel.description,
    labels: channelLabels(channel.labels),
    userLabels: userFacingLabels(channel.userLabels),
    enabled: channel.enabled !== false,
    verificationStatus: channel.verificationStatus,
  };
};

const getByName = (name: string) =>
  monitoring
    .getProjectsNotificationChannels({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  monitoring.listProjectsNotificationChannels
    .pages({
      name: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.notificationChannels ?? []),
      ),
      Stream.filter((channel) =>
        Object.keys(channel.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((channel) => toAttrs(channel, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (project: string, id: string) =>
  Effect.gen(function* () {
    const owned = yield* monitoring.listProjectsNotificationChannels
      .pages({
        name: parentOf(project),
        pageSize: 1000,
      })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.notificationChannels ?? []),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
    for (const channel of owned) {
      if (yield* hasAlchemyLabels(id, tagRecord(channel.userLabels))) {
        return channel;
      }
    }
    return undefined;
  });

const observe = (project: string, id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    return yield* findOwned(project, id);
  });

export const NotificationChannelProvider = () =>
  Provider.succeed(NotificationChannel, {
    stables: ["name", "notificationChannelId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.type ?? output?.type;
      if (previous !== undefined && news.type !== previous) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* observe(env.project, id, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.userLabels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredUserLabels = {
        ...toLabels(news.userLabels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredLabels = news.labels ?? {};
      const desiredEnabled = news.enabled !== false;
      const desiredDescription = news.description ?? "";

      let current = yield* observe(env.project, id, output?.name);
      if (current !== undefined && (current.type ?? "") !== news.type) {
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* monitoring
          .createProjectsNotificationChannels({
            name: parentOf(env.project),
            body: {
              type: news.type,
              displayName,
              description: news.description,
              labels: desiredLabels,
              userLabels: desiredUserLabels,
              enabled: desiredEnabled,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(env.project, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NotificationChannelNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const observedUserLabels = tagRecord(current.userLabels);
      const { upsert, removed } = diffLabels(
        observedUserLabels,
        desiredUserLabels,
      );
      const userLabelsChanged = upsert.length > 0 || removed.length > 0;
      const labelsChanged = !recordsEqual(
        channelLabels(current.labels),
        desiredLabels,
      );
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const enabledChanged = (current.enabled !== false) !== desiredEnabled;

      const updateMask = [
        displayNameChanged ? "display_name" : undefined,
        descriptionChanged ? "description" : undefined,
        labelsChanged ? "labels" : undefined,
        userLabelsChanged ? "user_labels" : undefined,
        enabledChanged ? "enabled" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* monitoring.patchProjectsNotificationChannels({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            type: news.type,
            displayName,
            description: news.description ?? "",
            labels: desiredLabels,
            userLabels: desiredUserLabels,
            enabled: desiredEnabled,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteProjectsNotificationChannels({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
