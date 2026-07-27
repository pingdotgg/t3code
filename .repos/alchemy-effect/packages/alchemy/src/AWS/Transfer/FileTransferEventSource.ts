import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Transfer Family delivers to EventBridge for
 * server file-transfer events. Fields not shared by every event kind are
 * optional (the schema grows over time).
 */
export interface FileTransferEventDetail {
  /** The user that performed the transfer. */
  username?: string;
  /** The ID of the server the transfer went through (e.g. `s-…`). */
  "server-id"?: string;
  /** Session identifier of the client connection. */
  "session-id"?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Transfer Family EventBridge event delivered to the handler. */
export type FileTransferEvent = EventRecord<FileTransferEventDetail>;

/** Which Transfer Family server notifications to subscribe to. */
export type FileTransferEventKind =
  | "file-upload-completed"
  | "file-upload-failed"
  | "file-download-completed"
  | "file-download-failed";

/** File-transfer protocols whose server events to subscribe to. */
export type FileTransferEventProtocol = "SFTP" | "FTP" | "FTPS";

const KIND_SUFFIXES: Record<FileTransferEventKind, string> = {
  "file-upload-completed": "Server File Upload Completed",
  "file-upload-failed": "Server File Upload Failed",
  "file-download-completed": "Server File Download Completed",
  "file-download-failed": "Server File Download Failed",
};

export interface FileTransferEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "TransferFileTransferEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: upload/download completions and
   * failures on the account's Transfer Family servers.
   * @default ["file-upload-completed"]
   */
  kinds?: readonly FileTransferEventKind[];
  /**
   * Which protocols' server events to subscribe to.
   * @default ["SFTP", "FTP", "FTPS"]
   */
  protocols?: readonly FileTransferEventProtocol[];
  /**
   * Restrict to events about specific servers. Matched as a prefix against
   * the event's top-level `resources` (the server ARN).
   */
  serverArns?: readonly string[];
}

/**
 * Event source connecting AWS Transfer Family notifications to the hosting
 * compute. Transfer Family publishes file upload/download completions and
 * failures on its servers to the account's default EventBridge bus (source
 * `aws.transfer`); this subscribes the host Function to those events so it
 * can react the moment a partner drops a file on the SFTP endpoint.
 *
 * Transfer Family publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming File-Transfer Events
 * @example Process Every Uploaded File
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default IngestFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Transfer.consumeFileTransferEvents(
 *       { kinds: ["file-upload-completed"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail.username} uploaded a file on ${event.detail["server-id"]}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeFileTransferEvents = <StreamReq = never, Req = never>(
  props: FileTransferEventSourceProps,
  process: (
    events: Stream.Stream<FileTransferEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => {
  const kinds = props.kinds ?? (["file-upload-completed"] as const);
  const protocols = props.protocols ?? (["SFTP", "FTP", "FTPS"] as const);
  return consumeBusEvents(
    props.id ?? "TransferFileTransferEvents",
    {
      source: ["aws.transfer"],
      "detail-type": protocols.flatMap((protocol) =>
        kinds.map((kind) => `${protocol} ${KIND_SUFFIXES[kind]}`),
      ),
      ...(props.serverArns !== undefined
        ? { resources: props.serverArns.map((arn) => ({ prefix: arn })) }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
};
