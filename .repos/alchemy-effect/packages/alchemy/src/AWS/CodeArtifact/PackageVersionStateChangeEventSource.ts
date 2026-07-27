import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * A package version state, as reported in the EventBridge event detail.
 */
export type PackageVersionState =
  | "Unfinished"
  | "Published"
  | "Unlisted"
  | "Archived"
  | "Disposed"
  | "Deleted";

/**
 * The `detail` payload CodeArtifact delivers to EventBridge on every package
 * version change (`CodeArtifact Package Version State Change`).
 */
export interface PackageVersionStateChangeDetail {
  /** Name of the domain containing the repository. */
  domainName: string;
  /** AWS account ID that owns the domain. */
  domainOwner?: string;
  /** Name of the repository the package version changed in. */
  repositoryName: string;
  /** Package format (`npm`, `pypi`, `maven`, `nuget`, `generic`, …). */
  packageFormat: string;
  /** Namespace of the package, for formats that support one. */
  packageNamespace?: string;
  /** Name of the package. */
  packageName: string;
  /** Version of the package that changed. */
  packageVersion: string;
  /** The state the package version is now in. */
  packageVersionState: PackageVersionState;
  /** Revision of the package version after the change. */
  packageVersionRevision?: string;
  /** What changed on the version (assets added/removed, status, metadata). */
  changes?: {
    assetsAdded?: number;
    assetsRemoved?: number;
    assetsUpdated?: number;
    metadataUpdated?: boolean;
    statusChanged?: boolean;
  };
  /** Whether the version was `Created`, `Updated`, or `Deleted`. */
  operationType?: "Created" | "Updated" | "Deleted";
  /** Monotonic sequence number of changes to this package version. */
  sequenceNumber?: number;
  /** Deduplication id — identical for retried deliveries of one change. */
  eventDeduplicationId?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/**
 * A CodeArtifact package version state change EventBridge event delivered to
 * the handler.
 */
export type PackageVersionStateChangeEvent =
  EventRecord<PackageVersionStateChangeDetail>;

export interface PackageVersionStateChangesProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CodeArtifactPackageVersionStateChanges"
   */
  id?: string;
  /**
   * Only deliver events for these domains (by name).
   * @default all domains
   */
  domains?: string[];
  /**
   * Only deliver events for these repositories (by name).
   * @default all repositories
   */
  repositories?: string[];
  /**
   * Only deliver events for these package formats (e.g. `["npm"]`).
   * @default all formats
   */
  formats?: string[];
  /**
   * Only deliver transitions into these states (e.g. `["Published"]`).
   * @default all states
   */
  states?: PackageVersionState[];
}

/**
 * Event source connecting CodeArtifact package version changes to the hosting
 * compute. CodeArtifact publishes an event to the account's default
 * EventBridge bus (source `aws.codeartifact`, detail-type `CodeArtifact
 * Package Version State Change`) every time a package version is created,
 * changes state (published, archived, disposed, …), or is deleted — including
 * versions ingested from upstream and external connections; this subscribes
 * the host Function to those events so it can react without polling.
 *
 * CodeArtifact publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Package Version Events
 * @example React to Published Versions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ReleaseBot.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CodeArtifact.consumePackageVersionStateChanges(
 *       { states: ["Published"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail.packageName}@${event.detail.packageVersion} → ${event.detail.packageVersionState}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumePackageVersionStateChanges = <
  StreamReq = never,
  Req = never,
>(
  props: PackageVersionStateChangesProps,
  process: (
    events: Stream.Stream<PackageVersionStateChangeEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CodeArtifactPackageVersionStateChanges",
    {
      source: ["aws.codeartifact"],
      "detail-type": ["CodeArtifact Package Version State Change"],
      ...(props.domains || props.repositories || props.formats || props.states
        ? {
            detail: {
              ...(props.domains ? { domainName: [...props.domains] } : {}),
              ...(props.repositories
                ? { repositoryName: [...props.repositories] }
                : {}),
              ...(props.formats ? { packageFormat: [...props.formats] } : {}),
              ...(props.states
                ? { packageVersionState: [...props.states] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
