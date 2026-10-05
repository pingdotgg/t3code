import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type ConversationMedium = "MEDIUM_UNSPECIFIED" | "PHONE_CALL" | "CHAT";

export type GcsSource = {
  /** Cloud Storage URI of conversation audio. */
  audioUri?: string;
  /** Cloud Storage URI of the conversation transcript. Immutable. */
  transcriptUri?: string;
};

export type ConversationDataSource = {
  /** Cloud Storage audio and/or transcript. */
  gcsSource?: GcsSource;
  /** Cloud Storage URI of conversation metadata. */
  metadataUri?: string;
};

export type CallMetadata = {
  /** Audio channel that contains the customer. */
  customerChannel?: number;
  /** Audio channel that contains the agent. */
  agentChannel?: number;
};

export type ConversationProps = {
  /**
   * Conversation id (the `{conversation}` segment of
   * `projects/{project}/locations/{location}/conversations/{conversation}`).
   * If omitted, a unique id is generated. Must match `^[a-z0-9-]{4,64}$`.
   * Immutable — changing it replaces the conversation.
   */
  conversationId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * conversation. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Conversation medium. Immutable — changing it replaces the
   * conversation.
   * @default "CHAT"
   */
  medium?: ConversationMedium | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * At most 100 labels, 256 characters per entry.
   */
  labels?: Record<string, string>;
  /** Opaque id of the human agent who handled the conversation. */
  agentId?: string;
  /** BCP-47 language code. */
  languageCode?: string;
  /** RFC3339 conversation start time. */
  startTime?: string;
  /**
   * RFC3339 expiry. After this time the conversation and its analyses
   * are deleted.
   */
  expireTime?: string;
  /**
   * Input-only TTL used to compute `expireTime` (e.g. `"86400s"`).
   */
  ttl?: string;
  /** Audio and transcript source. */
  dataSource?: ConversationDataSource;
  /** Call-specific channel metadata. */
  callMetadata?: CallMetadata;
  /** Telephony-system JSON metadata. */
  metadataJson?: string;
  /** Obfuscated end-user id. */
  obfuscatedUserId?: string;
  /**
   * Delete analyses together with the conversation.
   * @default true
   */
  forceDestroy?: boolean;
};

export type Conversation = Resource<
  "GCP.ContactCenterInsights.Conversation",
  ConversationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/conversations/{conversation}`. */
    name: string;
    /** Conversation id (last path segment). */
    conversationId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Conversation medium. */
    medium: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Agent id. */
    agentId: string | undefined;
    /** Language code. */
    languageCode: string | undefined;
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 expiry. */
    expireTime: string | undefined;
    /** Data source. */
    dataSource: ConversationDataSource | undefined;
    /** Call metadata. */
    callMetadata: CallMetadata | undefined;
    /** Duration of the conversation. */
    duration: string | undefined;
    /** Number of turns. */
    turnCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights conversation (chat or phone call).
 *
 * `create` does not transcribe or redact audio — use `conversations.upload`
 * for that. Location, id, and medium are immutable. Labels, agent id,
 * language, and expiry update in place.
 *
 * ### Creating a Conversation
 * **Example:** Chat conversation with labels
 * ```typescript
 * const conversation = yield* GCP.ContactCenterInsights.Conversation(
 *   "Chat",
 *   {
 *     medium: "CHAT",
 *     languageCode: "en-US",
 *     agentId: "agent-1",
 *     labels: { env: "test" },
 *   },
 * );
 * ```
 *
 * **Example:** Transcript from Cloud Storage
 * ```typescript
 * const conversation = yield* GCP.ContactCenterInsights.Conversation(
 *   "Chat",
 *   {
 *     medium: "CHAT",
 *     dataSource: {
 *       gcsSource: { transcriptUri: "gs://bucket/transcript.json" },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const Conversation = Resource<Conversation>(
  "GCP.ContactCenterInsights.Conversation",
);

export class ConversationNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.ConversationNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_MEDIUM = "CHAT";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceName = (
  project: string,
  location: string,
  conversationId: string,
) => `${locationParent(project, location)}/conversations/${conversationId}`;

const dataSourceOf = (
  source:
    | cci.GoogleCloudContactcenterinsightsV1ConversationDataSource
    | undefined,
): ConversationDataSource | undefined => {
  if (source === undefined) return undefined;
  return {
    gcsSource: source.gcsSource
      ? {
          audioUri: source.gcsSource.audioUri,
          transcriptUri: source.gcsSource.transcriptUri,
        }
      : undefined,
    metadataUri: source.metadataUri,
  };
};

const callMetadataOf = (
  metadata:
    | cci.GoogleCloudContactcenterinsightsV1ConversationCallMetadata
    | undefined,
): CallMetadata | undefined => {
  if (metadata === undefined) return undefined;
  return {
    customerChannel: metadata.customerChannel,
    agentChannel: metadata.agentChannel,
  };
};

const toAttrs = (
  conversation: cci.GoogleCloudContactcenterinsightsV1Conversation,
  project: string,
) => {
  const name = conversation.name ?? "";
  return {
    name,
    conversationId: lastSegment(name),
    location: locationOf(name),
    project,
    medium: conversation.medium,
    labels: userLabels(conversation.labels),
    agentId: conversation.agentId,
    languageCode: conversation.languageCode,
    startTime: conversation.startTime,
    expireTime: conversation.expireTime,
    dataSource: dataSourceOf(conversation.dataSource),
    callMetadata: callMetadataOf(conversation.callMetadata),
    duration: conversation.duration,
    turnCount: conversation.turnCount,
    createTime: conversation.createTime,
    updateTime: conversation.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsConversations({ name, view: "BASIC" })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsConversations
    .pages({ parent, pageSize: 100, view: "BASIC" })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.conversations ?? [])),
      Stream.filter((conversation) =>
        Object.keys(conversation.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((conversation) => toAttrs(conversation, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ConversationProvider = () =>
  Provider.succeed(Conversation, {
    stables: [
      "name",
      "conversationId",
      "location",
      "project",
      "medium",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.conversationId ?? output?.conversationId;
      if (
        previousId !== undefined &&
        news.conversationId !== undefined &&
        news.conversationId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousMedium = olds?.medium ?? output?.medium;
      const nextMedium = news.medium ?? DEFAULT_MEDIUM;
      if (previousMedium !== undefined && previousMedium !== nextMedium) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const conversationId = yield* toResourceId(
        id,
        olds?.conversationId,
        output?.conversationId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, conversationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = locationParent(env.project, location);
      const conversationId = yield* toResourceId(
        id,
        news.conversationId,
        output?.conversationId,
      );
      const name = resourceName(env.project, location, conversationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const medium = news.medium ?? DEFAULT_MEDIUM;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsConversations({
            parent,
            conversationId,
            body: {
              medium,
              labels: desiredLabels,
              agentId: news.agentId,
              languageCode: news.languageCode,
              startTime: news.startTime,
              expireTime: news.expireTime,
              ttl: news.ttl,
              dataSource: news.dataSource,
              callMetadata: news.callMetadata,
              metadataJson: news.metadataJson,
              obfuscatedUserId: news.obfuscatedUserId,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ConversationNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const agentChanged = !sameText(current.agentId, news.agentId);
      const languageChanged = !sameText(
        current.languageCode,
        news.languageCode,
      );
      // Insights assigns a start time when none is given; only a
      // caller-supplied one can be updated.
      const startChanged =
        news.startTime !== undefined &&
        !sameText(current.startTime, news.startTime);
      const expireChanged =
        news.expireTime !== undefined &&
        !sameText(current.expireTime, news.expireTime);
      const callChanged =
        news.callMetadata !== undefined &&
        ((current.callMetadata?.customerChannel ?? undefined) !==
          news.callMetadata.customerChannel ||
          (current.callMetadata?.agentChannel ?? undefined) !==
            news.callMetadata.agentChannel);

      if (
        labelsChanged ||
        agentChanged ||
        languageChanged ||
        startChanged ||
        expireChanged ||
        callChanged
      ) {
        current = yield* cci.patchProjectsLocationsConversations({
          name: currentName,
          updateMask: updateMaskOf(
            labelsChanged ? "labels" : undefined,
            agentChanged ? "agent_id" : undefined,
            languageChanged ? "language_code" : undefined,
            startChanged ? "start_time" : undefined,
            expireChanged ? "expire_time" : undefined,
            callChanged ? "call_metadata" : undefined,
          ),
          body: {
            name: currentName,
            labels: desiredLabels,
            agentId: news.agentId,
            languageCode: news.languageCode,
            startTime: news.startTime,
            expireTime: news.expireTime,
            callMetadata: news.callMetadata,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      yield* cci
        .deleteProjectsLocationsConversations({
          name: output.name,
          force: olds?.forceDestroy !== false,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
