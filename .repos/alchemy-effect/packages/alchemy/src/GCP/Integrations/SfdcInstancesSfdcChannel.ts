import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  findSfdcChannelByDescription,
  listOwnedSfdcChannels,
  parseResourceName,
} from "./internal.ts";
import {
  encodeOwnership,
  expandSfdcInstance,
  hasOwnershipMarker,
  isDeleted,
  lastSegment,
  locationOf,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  withProjectId,
  replaceOnIdentity,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type SfdcInstancesSfdcChannelProps = {
  /**
   * Parent SFDC instance resource name
   * `projects/{project}/locations/{location}/sfdcInstances/{sfdcInstance}`
   * or a bare instance id (combined with `location`). Immutable —
   * changing it replaces the channel.
   */
  sfdcInstance: string;
  /**
   * Channel id (the `{sfdcChannel}` segment). Server-assigned on create
   * when omitted. Immutable — changing it replaces the channel.
   */
  sfdcChannelId?: string;
  /**
   * Location used when `sfdcInstance` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Client-level unique alias for the channel.
   */
  displayName?: string;
  /**
   * Human-readable description. Channels have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  description?: string;
  /**
   * Salesforce channel topic assigned when the channel is opened (CDC
   * or Platform Event).
   */
  channelTopic: string;
};

export type SfdcInstancesSfdcChannel = Resource<
  "GCP.Integrations.SfdcInstancesSfdcChannel",
  SfdcInstancesSfdcChannelProps,
  {
    /** Full resource name `.../sfdcInstances/{instance}/sfdcChannels/{channel}`. */
    name: string;
    /** Channel id (last path segment). */
    sfdcChannelId: string;
    /** Parent SFDC instance resource name. */
    sfdcInstance: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-selected alias. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Salesforce channel topic. */
    channelTopic: string | undefined;
    /** Whether any published integration references this channel. */
    isActive: boolean;
    /** Last Salesforce message replay id. */
    lastReplayId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Salesforce CDC or Platform Event channel under an Application
 * Integration SFDC instance.
 *
 * Channels have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Parent instance and id are identity —
 * changing them replaces the channel. Display name, description, and
 * channel topic update in place.
 *
 * ### Creating an SFDC Channel
 * **Example:** Platform Event channel
 * ```typescript
 * const channel = yield* GCP.Integrations.SfdcInstancesSfdcChannel("Events", {
 *   sfdcInstance: instance.name,
 *   displayName: "account-events",
 *   channelTopic: "/event/AlchemyTest__e",
 * });
 * ```
 *
 * ### Updating an SFDC Channel
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename the alias
 * ```typescript
 * const channel = yield* GCP.Integrations.SfdcInstancesSfdcChannel("Events", {
 *   sfdcInstance: instance.name,
 *   displayName: "account-events-v2",
 *   channelTopic: "/event/AlchemyTest__e",
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const SfdcInstancesSfdcChannel = Resource<SfdcInstancesSfdcChannel>(
  "GCP.Integrations.SfdcInstancesSfdcChannel",
);

export class SfdcInstancesSfdcChannelNotResolved extends Data.TaggedError(
  "GCP.Integrations.SfdcInstancesSfdcChannelNotResolved",
)<{
  name: string;
}> {}

const resourceName = (sfdcInstance: string, sfdcChannelId: string) =>
  `${sfdcInstance}/sfdcChannels/${sfdcChannelId}`;

const toAttrs = (
  channel: integrations.GoogleCloudIntegrationsV1alphaSfdcChannel,
  project: string,
  region: string,
  instanceHint?: string,
) => {
  const name = withProjectId(channel.name ?? "", project);
  const parsed = parseResourceName(name, "sfdcChannels", region);
  return {
    name,
    sfdcChannelId: lastSegment(name),
    sfdcInstance: name.includes("/sfdcChannels/")
      ? parsed.sfdcInstance
      : (instanceHint ?? parsed.parent),
    location: locationOf(name, region),
    project,
    displayName: channel.displayName,
    description: parseOwnership(channel.description).text,
    channelTopic: channel.channelTopic,
    isActive: channel.isActive === true,
    lastReplayId: channel.lastReplayId,
    createTime: channel.createTime,
    updateTime: channel.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations.getProjectsLocationsSfdcInstancesSfdcChannels({ name }).pipe(
        Effect.map((channel) => (isDeleted(channel) ? undefined : channel)),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

export const SfdcInstancesSfdcChannelProvider = () =>
  Provider.succeed(SfdcInstancesSfdcChannel, {
    stables: [
      "name",
      "sfdcChannelId",
      "sfdcInstance",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousInstance = olds?.sfdcInstance ?? output?.sfdcInstance;
      const instanceChanged =
        previousInstance !== undefined &&
        lastSegment(news.sfdcInstance) !== lastSegment(previousInstance);
      const previousId = olds?.sfdcChannelId ?? output?.sfdcChannelId;
      const idChanged =
        previousId !== undefined &&
        news.sfdcChannelId !== undefined &&
        news.sfdcChannelId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(news.location, env.region) !==
          normalizeLocation(previousLocation, env.region);
      return replaceOnIdentity(instanceChanged || idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const sfdcInstance = olds?.sfdcInstance
        ? expandSfdcInstance(olds.sfdcInstance, env.project, location)
        : output?.sfdcInstance;
      const sfdcChannelId = yield* toResourceId(
        id,
        olds?.sfdcChannelId,
        output?.sfdcChannelId,
      );
      const name =
        output?.name ??
        (sfdcInstance !== undefined
          ? resourceName(sfdcInstance, sfdcChannelId)
          : "");
      let existing = yield* getByName(name);
      if (
        existing === undefined &&
        sfdcInstance !== undefined &&
        output?.name === undefined
      ) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findSfdcChannelByDescription(
          sfdcInstance,
          encodeOwnership(ownership, olds?.description),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, sfdcInstance);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedSfdcChannels(env.project, env.region);
        return items
          .filter((channel) => hasOwnershipMarker(channel.description))
          .map((channel) => toAttrs(channel, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const sfdcInstance = expandSfdcInstance(
        news.sfdcInstance,
        env.project,
        location,
      );
      const sfdcChannelId = yield* toResourceId(
        id,
        news.sfdcChannelId,
        output?.sfdcChannelId,
      );
      const name = output?.name ?? resourceName(sfdcInstance, sfdcChannelId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? sfdcChannelId;
      const body: integrations.GoogleCloudIntegrationsV1alphaSfdcChannel = {
        displayName,
        description,
        channelTopic: news.channelTopic,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findSfdcChannelByDescription(
          sfdcInstance,
          description,
        );
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsSfdcInstancesSfdcChannels({
            parent: sfdcInstance,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findSfdcChannelByDescription(sfdcInstance, description),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SfdcInstancesSfdcChannelNotResolved({ name });
      }

      const currentName = withProjectId(current.name ?? name, env.project);
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const topicChanged = !sameText(current.channelTopic, news.channelTopic);

      if (displayChanged || descriptionChanged || topicChanged) {
        current =
          yield* integrations.patchProjectsLocationsSfdcInstancesSfdcChannels({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              topicChanged ? "channelTopic" : undefined,
            ),
            body: { ...body, name: currentName },
          });
      }

      return toAttrs(current, env.project, env.region, sfdcInstance);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsSfdcInstancesSfdcChannels({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
