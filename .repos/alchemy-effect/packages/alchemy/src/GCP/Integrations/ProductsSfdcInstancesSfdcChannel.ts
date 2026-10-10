import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PRODUCT,
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  normalizeLocation,
  normalizeProduct,
  ownedByAlchemy,
  parseOwnership,
  productOf,
  productParent,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type ProductsSfdcInstancesSfdcChannelProps = {
  /**
   * Parent Salesforce instance resource name
   * `projects/{project}/locations/{location}/products/{product}/sfdcInstances/{sfdcInstance}`.
   * Immutable — changing it replaces the channel.
   */
  sfdcInstance: string;
  /**
   * Channel id (the `{sfdcChannel}` segment). Server-assigned on create.
   * Immutable — changing it replaces the channel.
   */
  sfdcChannelId?: string;
  /**
   * Location used when `sfdcInstance` is a bare id. Immutable —
   * changing it replaces the channel.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Product id used when `sfdcInstance` is a bare id. Immutable —
   * changing it replaces the channel.
   * @default "IP"
   */
  product?: string;
  /**
   * Unique display name / alias.
   */
  displayName?: string;
  /**
   * Human-readable description. Salesforce channels have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Salesforce channel topic once the channel is opened.
   */
  channelTopic: string;
};

export type ProductsSfdcInstancesSfdcChannel = Resource<
  "GCP.Integrations.ProductsSfdcInstancesSfdcChannel",
  ProductsSfdcInstancesSfdcChannelProps,
  {
    /** Full resource name. */
    name: string;
    /** Channel id (last path segment). */
    sfdcChannelId: string;
    /** Parent Salesforce instance resource name. */
    sfdcInstance: string;
    /** Location id. */
    location: string;
    /** Product id. */
    product: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Salesforce channel topic. */
    channelTopic: string | undefined;
    /** Whether any published integration references this channel. */
    isActive: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A product-scoped Salesforce CDC or Platform Event channel
 * (`.../sfdcInstances/{sfdcInstance}/sfdcChannels/{sfdcChannel}`).
 *
 * Channels have no labels field — Alchemy stamps ownership into the
 * description. Parent instance and id are immutable. Display name,
 * description, and topic update in place.
 *
 * ### Creating a Salesforce Channel
 * **Example:** Platform event topic
 * ```typescript
 * const channel = yield* GCP.Integrations.ProductsSfdcInstancesSfdcChannel("Orders", {
 *   sfdcInstance: sfdc.name,
 *   displayName: "orders",
 *   channelTopic: "/event/AlchemyOrder__e",
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const ProductsSfdcInstancesSfdcChannel =
  Resource<ProductsSfdcInstancesSfdcChannel>(
    "GCP.Integrations.ProductsSfdcInstancesSfdcChannel",
  );

export class ProductsSfdcInstancesSfdcChannelNotResolved extends Data.TaggedError(
  "GCP.Integrations.ProductsSfdcInstancesSfdcChannelNotResolved",
)<{
  name: string;
}> {}

const expandInstance = (
  value: string,
  project: string,
  location: string,
  product: string,
) =>
  value.includes("/sfdcInstances/")
    ? value
    : `${productParent(project, location, product)}/sfdcInstances/${value}`;

const resourceName = (sfdcInstance: string, sfdcChannelId: string) =>
  `${sfdcInstance}/sfdcChannels/${sfdcChannelId}`;

const toAttrs = (
  channel: integrations.GoogleCloudIntegrationsV1alphaSfdcChannel,
  project: string,
  region: string,
  sfdcInstance: string,
) => {
  const name = channel.name ?? "";
  const parsed = parseOwnership(channel.description);
  return {
    name,
    sfdcChannelId: lastSegment(name),
    sfdcInstance,
    location: locationOf(name, region),
    product: productOf(name),
    project,
    displayName: channel.displayName,
    description: parsed.text,
    channelTopic: channel.channelTopic,
    isActive: channel.isActive === true,
    createTime: channel.createTime,
    updateTime: channel.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsProductsSfdcInstancesSfdcChannels({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  integrations.listProjectsLocationsProductsSfdcInstancesSfdcChannels
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sfdcChannels ?? [])),
      Stream.filter((channel) => hasOwnershipMarker(channel.description)),
      Stream.map((channel) => toAttrs(channel, project, region, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  integrations.listProjectsLocationsProductsSfdcInstancesSfdcChannels
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sfdcChannels ?? [])),
      Stream.filterEffect((channel) => ownedByAlchemy(id, channel.description)),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const listOwnedChannels = (
  project: string,
  location: string,
  product: string,
) =>
  Effect.gen(function* () {
    const parent = productParent(project, location, product);
    const instances =
      yield* integrations.listProjectsLocationsProductsSfdcInstances
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.sfdcInstances ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
    const nested = yield* Effect.forEach(
      instances,
      (instance) =>
        instance.name
          ? listAt(instance.name, project, location)
          : Effect.succeed([] as ReturnType<typeof toAttrs>[]),
      { concurrency: 4 },
    );
    return nested.flat();
  });

export const ProductsSfdcInstancesSfdcChannelProvider = () =>
  Provider.succeed(ProductsSfdcInstancesSfdcChannel, {
    stables: [
      "name",
      "sfdcChannelId",
      "sfdcInstance",
      "location",
      "product",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousInstance = olds?.sfdcInstance ?? output?.sfdcInstance;
      if (
        previousInstance !== undefined &&
        news.sfdcInstance !== previousInstance &&
        !news.sfdcInstance.endsWith(`/${lastSegment(previousInstance)}`)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.sfdcChannelId ?? output?.sfdcChannelId;
      if (
        previousId !== undefined &&
        news.sfdcChannelId !== undefined &&
        news.sfdcChannelId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(olds?.product ?? output?.product);
      const sfdcInstance = expandInstance(
        olds?.sfdcInstance ?? output?.sfdcInstance ?? "",
        env.project,
        location,
        product,
      );
      const sfdcChannelId = yield* toResourceId(
        id,
        olds?.sfdcChannelId,
        output?.sfdcChannelId,
      );
      const name = output?.name ?? resourceName(sfdcInstance, sfdcChannelId);
      let existing = yield* getByName(name);
      if (existing === undefined && sfdcInstance.length > 0) {
        existing = yield* findOwned(sfdcInstance, id);
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
        return yield* listOwnedChannels(
          env.project,
          env.region,
          DEFAULT_PRODUCT,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(
        news.product ?? output?.product ?? DEFAULT_PRODUCT,
      );
      const sfdcInstance = expandInstance(
        news.sfdcInstance,
        env.project,
        location,
        product,
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

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findOwned(sfdcInstance, id);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsProductsSfdcInstancesSfdcChannels({
            parent: sfdcInstance,
            body: {
              displayName,
              description,
              channelTopic: news.channelTopic,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(sfdcInstance, id)));
        current = created ?? (yield* findOwned(sfdcInstance, id));
      }

      if (current === undefined) {
        return yield* new ProductsSfdcInstancesSfdcChannelNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const topicChanged = !sameText(current.channelTopic, news.channelTopic);

      if (displayChanged || descriptionChanged || topicChanged) {
        current =
          yield* integrations.patchProjectsLocationsProductsSfdcInstancesSfdcChannels(
            {
              name: currentName,
              updateMask: updateMaskOf(
                displayChanged ? "display_name" : undefined,
                descriptionChanged ? "description" : undefined,
                topicChanged ? "channel_topic" : undefined,
              ),
              body: {
                name: currentName,
                displayName,
                description,
                channelTopic: news.channelTopic,
              },
            },
          );
      }

      return toAttrs(current, env.project, env.region, sfdcInstance);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsProductsSfdcInstancesSfdcChannels({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
