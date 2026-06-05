/**
 * ExternalIntegrationRepository - Persistence for team-app links and receipts.
 *
 * Keeps the server-native cutover model intentionally small: external
 * conversations point at T3 threads, inbound events are deduped, assistant
 * artifacts are linked back to threads, and outbound deliveries are claimed
 * exactly once.
 *
 * @module ExternalIntegrationRepository
 */
import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ExternalIntegrationRepositoryError } from "../Errors.ts";

export const ExternalThreadSource = Schema.Literals(["slack", "support_email"]);
export type ExternalThreadSource = typeof ExternalThreadSource.Type;

export const ExternalEventSource = Schema.Literals(["slack", "support_email", "github"]);
export type ExternalEventSource = typeof ExternalEventSource.Type;

export const ExternalArtifactKind = Schema.Literals(["github_pr"]);
export type ExternalArtifactKind = typeof ExternalArtifactKind.Type;

export const ExternalReceiptStatus = Schema.Literals([
  "received",
  "processing",
  "completed",
  "failed",
  "skipped",
]);
export type ExternalReceiptStatus = typeof ExternalReceiptStatus.Type;

export const ExternalThreadLink = Schema.Struct({
  source: ExternalThreadSource,
  externalThreadId: Schema.String,
  t3ThreadId: ThreadId,
  projectId: ProjectId,
  primaryExternalMessageId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  muted: Schema.Boolean,
  metadata: Schema.Unknown,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalThreadLink = typeof ExternalThreadLink.Type;

export const ExternalEventReceipt = Schema.Struct({
  source: ExternalEventSource,
  eventId: Schema.String,
  status: ExternalReceiptStatus,
  metadata: Schema.Unknown,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalEventReceipt = typeof ExternalEventReceipt.Type;

export const ExternalArtifactLink = Schema.Struct({
  kind: ExternalArtifactKind,
  externalId: Schema.String,
  t3ThreadId: ThreadId,
  url: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalArtifactLink = typeof ExternalArtifactLink.Type;

export const ExternalDeliveryReceipt = Schema.Struct({
  source: ExternalEventSource,
  deliveryKey: Schema.String,
  status: ExternalReceiptStatus,
  externalMessageId: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalDeliveryReceipt = typeof ExternalDeliveryReceipt.Type;

export interface ExternalIntegrationRepositoryShape {
  readonly upsertThreadLink: (
    link: ExternalThreadLink,
  ) => Effect.Effect<void, ExternalIntegrationRepositoryError>;

  readonly getThreadLink: (input: {
    readonly source: ExternalThreadSource;
    readonly externalThreadId: string;
  }) => Effect.Effect<Option.Option<ExternalThreadLink>, ExternalIntegrationRepositoryError>;

  readonly listThreadLinksByThread: (
    t3ThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ExternalThreadLink>, ExternalIntegrationRepositoryError>;

  readonly setThreadMuted: (input: {
    readonly source: ExternalThreadSource;
    readonly externalThreadId: string;
    readonly muted: boolean;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ExternalIntegrationRepositoryError>;

  readonly upsertEventReceipt: (
    receipt: ExternalEventReceipt,
  ) => Effect.Effect<void, ExternalIntegrationRepositoryError>;

  readonly getEventReceipt: (input: {
    readonly source: ExternalEventSource;
    readonly eventId: string;
  }) => Effect.Effect<Option.Option<ExternalEventReceipt>, ExternalIntegrationRepositoryError>;

  readonly upsertArtifactLink: (
    artifact: ExternalArtifactLink,
  ) => Effect.Effect<void, ExternalIntegrationRepositoryError>;

  readonly getArtifactLink: (input: {
    readonly kind: ExternalArtifactKind;
    readonly externalId: string;
  }) => Effect.Effect<Option.Option<ExternalArtifactLink>, ExternalIntegrationRepositoryError>;

  readonly upsertDeliveryReceipt: (
    receipt: ExternalDeliveryReceipt,
  ) => Effect.Effect<void, ExternalIntegrationRepositoryError>;

  readonly getDeliveryReceipt: (input: {
    readonly source: ExternalEventSource;
    readonly deliveryKey: string;
  }) => Effect.Effect<Option.Option<ExternalDeliveryReceipt>, ExternalIntegrationRepositoryError>;
}

export class ExternalIntegrationRepository extends Context.Service<
  ExternalIntegrationRepository,
  ExternalIntegrationRepositoryShape
>()("t3/persistence/Services/ExternalIntegrations/ExternalIntegrationRepository") {}
