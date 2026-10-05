import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  collectPages,
  expandResource,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  toPhysicalId,
  userLabels,
  retryOnTransient,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "channelConnections";

export type ChannelConnectionProps = {
  /**
   * Channel connection id (the `{channelConnection}` segment of
   * `projects/{project}/locations/{location}/channelConnections/{channelConnection}`).
   * If omitted, a unique name is generated. Must match
   * `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63 characters. Immutable —
   * changing it replaces the connection.
   */
  channelConnectionId?: string;
  /**
   * Eventarc location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the connection. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Subscriber Channel this connection binds, as
   * `projects/{project}/locations/{location}/channels/{channel}` or the
   * `{channel}` segment. Created in the provider project; the channel
   * lives in the subscriber project. Immutable — changing it replaces
   * the connection.
   */
  channel: string;
  /**
   * Activation token from the subscriber Channel. Input only — used
   * during create to bind the channel to this provider project, then
   * discarded. Omit when the API no longer requires it.
   */
  activationToken?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The ChannelConnection API has no update method, so changing labels
   * replaces the connection.
   */
  labels?: Record<string, string>;
};

export type ChannelConnection = Resource<
  "GCP.Eventarc.ChannelConnection",
  ChannelConnectionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/channelConnections/{channelConnection}`. */
    name: string;
    /** Channel connection id (last path segment). */
    channelConnectionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Bound subscriber Channel resource name. */
    channel: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-assigned UUID4, stable until delete. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Eventarc ChannelConnection that binds a third-party event provider
 * to a subscriber Channel. Created in the provider project using the
 * subscriber Channel's activation token.
 *
 * There is no patch API — `channelConnectionId`, `location`, `channel`,
 * and labels are all identity. Changing any of them replaces the
 * connection.
 *
 * ### Creating a ChannelConnection
 * **Example:** Bind a subscriber channel
 * ```typescript
 * const connection = yield* GCP.Eventarc.ChannelConnection("Partner", {
 *   location: "us-central1",
 *   channel:
 *     "projects/subscriber/locations/us-central1/channels/datadog",
 *   activationToken: channel.activationToken,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const ChannelConnection = Resource<ChannelConnection>(
  "GCP.Eventarc.ChannelConnection",
);

const toAttrs = (
  connection: eventarc.ChannelConnection,
  project: string,
  region: string,
) => {
  const name = connection.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    channelConnectionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    channel: connection.channel,
    labels: userLabels(connection.labels),
    uid: connection.uid,
    createTime: connection.createTime,
    updateTime: connection.updateTime,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsChannelConnections({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ChannelConnectionProvider = () =>
  Provider.succeed(ChannelConnection, {
    stables: [
      "name",
      "channelConnectionId",
      "project",
      "location",
      "channel",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.channelConnectionId ?? output?.channelConnectionId;
      const nextId = news.channelConnectionId
        ? rfc1035(news.channelConnectionId, "channel-connection")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousChannel = olds?.channel ?? output?.channel ?? "";
      const nextChannel = news.channel;
      const previousLabels = toLabels(olds?.labels ?? output?.labels);
      const nextLabels = toLabels(news.labels);
      const { upsert, removed } = diffLabels(previousLabels, nextLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const identityChanged =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousChannel.length > 0 && previousChannel !== nextChannel);
      if (!identityChanged && !labelsChanged) return undefined;
      const samePhysical =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId === nextId &&
        previousLocation === nextLocation;
      return {
        action: "replace" as const,
        deleteFirst: samePhysical,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const channelConnectionId = yield* toPhysicalId(
        id,
        olds?.channelConnectionId,
        output?.channelConnectionId,
        "channel-connection",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, channelConnectionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          eventarc.listProjectsLocationsChannelConnections.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.channelConnections,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const channelConnectionId = yield* toPhysicalId(
        id,
        news.channelConnectionId,
        output?.channelConnectionId,
        "channel-connection",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        channelConnectionId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const channel = expandResource(
        news.channel,
        env.project,
        location,
        "channels",
      );

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsChannelConnections({
            parent: parentOf(env.project, location),
            channelConnectionId,
            body: compact({
              name,
              channel,
              activationToken: news.activationToken,
              labels: desiredLabels,
            }),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryOnTransient(
        Effect.gen(function* () {
          const existing = yield* getByName(output.name);
          if (existing === undefined) return;
          const operation = yield* eventarc
            .deleteProjectsLocationsChannelConnections({
              name: output.name,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
          if (operation !== undefined) {
            yield* waitForOperation(operation, { notFoundOk: true });
          }
        }),
      ).pipe(
        Effect.catchTag("GCP.OperationFailed", (error) =>
          getByName(output.name).pipe(
            Effect.flatMap((current) =>
              current === undefined ? Effect.void : Effect.fail(error),
            ),
          ),
        ),
      );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
