import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import { waitForOperation } from "./internal.ts";

const MAX_NAME_LENGTH = 63;

export type ChannelState = eventarc.ChannelStateEnum | (string & {});

export type ChannelProps = {
  /**
   * Channel id (the `{channel}` segment of
   * `projects/{project}/locations/{location}/channels/{channel}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63
   * characters. Immutable — changing it replaces the channel.
   */
  channelId?: string;
  /**
   * Eventarc location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the channel. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Event provider associated with the channel (an Eventarc SaaS
   * partner). Format
   * `projects/{project}/locations/{location}/providers/{providerId}` or
   * the `{providerId}` segment. The provider is granted permission to
   * publish events on the channel. Omit for a Google channel with no
   * third-party partner. Immutable — changing it replaces the channel.
   */
  provider?: string;
  /**
   * Customer-managed Cloud KMS key used to encrypt/decrypt event data,
   * as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  cryptoKeyName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Channel = Resource<
  "GCP.Eventarc.Channel",
  ChannelProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/channels/{channel}`. */
    name: string;
    /** Channel id (last path segment). */
    channelId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Event provider resource name, if any. */
    provider: string | undefined;
    /** Customer-managed KMS key, if any. */
    cryptoKeyName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /**
     * Pub/Sub topic Eventarc manages as the channel transport
     * (`projects/{project}/topics/{topic}`).
     */
    pubsubTopic: string | undefined;
    /** Channel lifecycle state (`PENDING`, `ACTIVE`, `INACTIVE`, …). */
    state: ChannelState | undefined;
    /**
     * Activation token the provider uses to register the channel. Present
     * while the channel is `PENDING`.
     */
    activationToken: string | undefined;
    /** Server-assigned UUID4, stable until delete. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Whether the channel satisfies physical zone separation. */
    satisfiesPzs: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * An Eventarc channel representing a subscriber's intent to receive
 * events from an event provider. Published events are delivered over
 * the transport Eventarc associates with the channel.
 *
 * `channelId`, `location`, and `provider` are identity — changing any
 * of them replaces the channel. Labels and `cryptoKeyName` update in
 * place. A Google channel (no third-party `provider`) is valid; SaaS
 * partner channels stay `PENDING` until the partner activates them.
 *
 * ### Creating a Channel
 * **Example:** Google channel
 * ```typescript
 * const channel = yield* GCP.Eventarc.Channel("events", {
 *   location: "us-central1",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Third-party provider channel
 * ```typescript
 * const channel = yield* GCP.Eventarc.Channel("datadog", {
 *   channelId: "datadog-events",
 *   location: "us-central1",
 *   provider:
 *     "projects/my-project/locations/us-central1/providers/datadog",
 * });
 * ```
 *
 * ### Updating a Channel
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical channel and patches it in place.
 *
 * **Example:** Change labels and CMEK
 * ```typescript
 * const channel = yield* GCP.Eventarc.Channel("events", {
 *   location: "us-central1",
 *   cryptoKeyName:
 *     "projects/my-project/locations/us-central1/keyRings/keys/cryptoKeys/events",
 *   labels: { env: "prod", role: "events" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const Channel = Resource<Channel>("GCP.Eventarc.Channel");

export class ChannelNotResolved extends Data.TaggedError(
  "GCP.Eventarc.ChannelNotResolved",
)<{
  name: string;
}> {}

export class ChannelStillExists extends Data.TaggedError(
  "GCP.Eventarc.ChannelStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "channel";
};

const resourceName = (project: string, location: string, channelId: string) =>
  `projects/${project}/locations/${location}/channels/${channelId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const channelsAt = parts.lastIndexOf("channels");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    channelId:
      channelsAt >= 0 && parts[channelsAt + 1]
        ? parts[channelsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, channelId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (channelId !== undefined) return rfc1035(channelId);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const compact = <T extends Record<string, unknown>>(value: T): T => {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== "") next[key] = entry;
  }
  return next as T;
};

const providerKey = (
  provider: string | undefined,
  project: string,
  location: string,
) => {
  if (provider === undefined || provider.length === 0) return "";
  if (provider.includes("/")) return provider;
  return `projects/${project}/locations/${location}/providers/${provider}`;
};

const cryptoKeyKey = (name: string | undefined) =>
  name === undefined || name.length === 0 ? "" : name;

const toAttrs = (
  channel: eventarc.Channel,
  project: string,
  region: string,
) => {
  const name = channel.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    channelId: parsed.channelId,
    project: parsed.project || project,
    location: parsed.location,
    provider: channel.provider,
    cryptoKeyName: channel.cryptoKeyName,
    labels: userLabels(channel.labels),
    pubsubTopic: channel.pubsubTopic,
    state: channel.state,
    activationToken: channel.activationToken,
    uid: channel.uid,
    createTime: channel.createTime,
    updateTime: channel.updateTime,
    satisfiesPzs: channel.satisfiesPzs,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsChannels({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((channel) =>
      channel
        ? Effect.succeed(channel)
        : Effect.fail(new ChannelNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Eventarc.ChannelNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((channel) =>
      channel === undefined
        ? Effect.void
        : Effect.fail(new ChannelStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Eventarc.ChannelStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ChannelProvider = () =>
  Provider.succeed(Channel, {
    stables: [
      "name",
      "channelId",
      "project",
      "location",
      "uid",
      "createTime",
      "provider",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.channelId ?? output?.channelId;
      const nextId = news.channelId ? rfc1035(news.channelId) : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const project = output?.project ?? "";
      const previousProvider = providerKey(
        olds?.provider ?? output?.provider,
        project,
        previousLocation,
      );
      const nextProvider =
        news.provider !== undefined
          ? providerKey(news.provider, project, nextLocation)
          : previousProvider;

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousProvider !== nextProvider;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const channelId = yield* toId(id, olds?.channelId, output?.channelId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, channelId);
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
        return yield* eventarc.listProjectsLocationsChannels
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.channels ?? [])),
            Stream.filter((channel) =>
              Object.keys(channel.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((channel) => toAttrs(channel, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const channelId = yield* toId(id, news.channelId, output?.channelId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, channelId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredProvider = news.provider
        ? providerKey(news.provider, env.project, location)
        : undefined;
      const desiredCryptoKey =
        news.cryptoKeyName && news.cryptoKeyName.length > 0
          ? news.cryptoKeyName
          : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsChannels({
            parent: `projects/${env.project}/locations/${location}`,
            channelId,
            body: compact({
              name,
              labels: desiredLabels,
              provider: desiredProvider,
              cryptoKeyName: desiredCryptoKey,
            }),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ChannelNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const cryptoKeyChanged =
        cryptoKeyKey(current.cryptoKeyName) !== cryptoKeyKey(desiredCryptoKey);

      if (labelsChanged || cryptoKeyChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          cryptoKeyChanged ? "cryptoKeyName" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* eventarc.patchProjectsLocationsChannels({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            cryptoKeyName: desiredCryptoKey,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* eventarc
        .deleteProjectsLocationsChannels({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
