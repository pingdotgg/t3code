import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon Transcribe delivers to EventBridge when a
 * batch transcription job finishes (`Transcribe Job State Change`, statuses
 * `COMPLETED` and `FAILED` only — Transcribe does not emit intermediate
 * states).
 */
export interface TranscriptionJobEventDetail {
  /** The transcription job's name. */
  TranscriptionJobName?: string;
  /** The terminal status: `COMPLETED` or `FAILED`. */
  TranscriptionJobStatus?: string;
  /** Why the job failed — only present on `FAILED` events. */
  FailureReason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Transcribe job EventBridge event delivered to the handler. */
export type TranscriptionJobEvent = EventRecord<TranscriptionJobEventDetail>;

/**
 * The `detail` payload for `Call Analytics Job State Change` events.
 */
export interface CallAnalyticsJobEventDetail {
  /** The Call Analytics job's name. */
  JobName?: string;
  /** The terminal status: `COMPLETED` or `FAILED`. */
  JobStatus?: string;
  /** Why the job failed — only present on `FAILED` events. */
  FailureReason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Call Analytics job EventBridge event delivered to the handler. */
export type CallAnalyticsJobEvent = EventRecord<CallAnalyticsJobEventDetail>;

/**
 * The `detail` payload for `Medical Scribe Job State Change` events.
 */
export interface MedicalScribeJobEventDetail {
  /** The Medical Scribe job's name. */
  MedicalScribeJobName?: string;
  /** The terminal status: `COMPLETED` or `FAILED`. */
  MedicalScribeJobStatus?: string;
  /** Why the job failed — only present on `FAILED` events. */
  FailureReason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Medical Scribe job EventBridge event delivered to the handler. */
export type MedicalScribeJobEvent = EventRecord<MedicalScribeJobEventDetail>;

/**
 * The `detail` payload for `Vocabulary State Change` events (custom
 * vocabulary processing finished).
 */
export interface VocabularyEventDetail {
  /** The custom vocabulary's name. */
  VocabularyName?: string;
  /** The terminal state: `READY` or `FAILED`. */
  VocabularyState?: string;
  /** Why processing failed — only present on `FAILED` events. */
  FailureReason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A vocabulary EventBridge event delivered to the handler. */
export type VocabularyEvent = EventRecord<VocabularyEventDetail>;

/**
 * The `detail` payload for `Language Model State Change` events (custom
 * language model training finished).
 */
export interface LanguageModelEventDetail {
  /** The custom language model's name. */
  ModelName?: string;
  /** The terminal status: `COMPLETED` or `FAILED`. */
  ModelStatus?: string;
  /** Why training failed — only present on `FAILED` events. */
  FailureReason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A language model EventBridge event delivered to the handler. */
export type LanguageModelEvent = EventRecord<LanguageModelEventDetail>;

export interface TranscriptionJobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "TranscribeJobEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.TranscriptionJobStatus` values
   * (e.g. `["COMPLETED"]`).
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting Amazon Transcribe batch job completions to the
 * hosting compute. Transcribe publishes a `Transcribe Job State Change`
 * event (source `aws.transcribe`) to the account's default EventBridge bus
 * when a batch transcription job reaches `COMPLETED` or `FAILED`; this
 * subscribes the host Function to those events so it can chain
 * post-transcription processing without polling {@link GetTranscriptionJob}.
 *
 * Transcribe publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Job Events
 * @example React To Finished Transcriptions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default TranscriptReactor.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Transcribe.consumeTranscriptionJobEvents(
 *       { statuses: ["COMPLETED", "FAILED"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.TranscriptionJobStatus === "FAILED"
 *             ? Effect.log(`job ${event.detail.TranscriptionJobName} failed: ${event.detail.FailureReason}`)
 *             : Effect.log(`job ${event.detail.TranscriptionJobName} complete`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeTranscriptionJobEvents = <StreamReq = never, Req = never>(
  props: TranscriptionJobEventSourceProps,
  process: (
    events: Stream.Stream<TranscriptionJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "TranscribeJobEvents",
    {
      source: ["aws.transcribe"],
      "detail-type": ["Transcribe Job State Change"],
      ...(props.statuses
        ? { detail: { TranscriptionJobStatus: [...props.statuses] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );

export interface CallAnalyticsJobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "TranscribeCallAnalyticsJobEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.JobStatus` values.
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source for Amazon Transcribe `Call Analytics Job State Change`
 * events (source `aws.transcribe`) — fires when a Call Analytics job
 * reaches `COMPLETED` or `FAILED`.
 *
 * @section Consuming Job Events
 * @example React To Finished Call Analytics Jobs
 * ```typescript
 * yield* AWS.Transcribe.consumeCallAnalyticsJobEvents(
 *   { statuses: ["COMPLETED"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`call ${event.detail.JobName} analyzed`),
 *     ),
 * );
 * ```
 */
export const consumeCallAnalyticsJobEvents = <StreamReq = never, Req = never>(
  props: CallAnalyticsJobEventSourceProps,
  process: (
    events: Stream.Stream<CallAnalyticsJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "TranscribeCallAnalyticsJobEvents",
    {
      source: ["aws.transcribe"],
      "detail-type": ["Call Analytics Job State Change"],
      ...(props.statuses ? { detail: { JobStatus: [...props.statuses] } } : {}),
    },
    { description: props.description, state: props.state },
    process,
  );

export interface MedicalScribeJobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "TranscribeMedicalScribeJobEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.MedicalScribeJobStatus` values.
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source for AWS HealthScribe `Medical Scribe Job State Change`
 * events (source `aws.transcribe`) — fires when a Medical Scribe job
 * reaches `COMPLETED` or `FAILED`.
 *
 * @section Consuming Job Events
 * @example React To Finished Medical Scribe Jobs
 * ```typescript
 * yield* AWS.Transcribe.consumeMedicalScribeJobEvents(
 *   { statuses: ["COMPLETED"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`visit ${event.detail.MedicalScribeJobName} summarized`),
 *     ),
 * );
 * ```
 */
export const consumeMedicalScribeJobEvents = <StreamReq = never, Req = never>(
  props: MedicalScribeJobEventSourceProps,
  process: (
    events: Stream.Stream<MedicalScribeJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "TranscribeMedicalScribeJobEvents",
    {
      source: ["aws.transcribe"],
      "detail-type": ["Medical Scribe Job State Change"],
      ...(props.statuses
        ? { detail: { MedicalScribeJobStatus: [...props.statuses] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );

export interface VocabularyEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "TranscribeVocabularyEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.VocabularyState` values
   * (e.g. `["READY"]`).
   * @default all states
   */
  states?: readonly string[];
}

/**
 * Event source for Amazon Transcribe `Vocabulary State Change` events
 * (source `aws.transcribe`) — fires when custom vocabulary processing
 * reaches `READY` or `FAILED`, so runtime-created vocabularies (e.g.
 * per-tenant via {@link CreateVocabulary}) can be used the moment they are
 * ready.
 *
 * @section Consuming Job Events
 * @example React To Ready Vocabularies
 * ```typescript
 * yield* AWS.Transcribe.consumeVocabularyEvents(
 *   { states: ["READY"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`vocabulary ${event.detail.VocabularyName} ready`),
 *     ),
 * );
 * ```
 */
export const consumeVocabularyEvents = <StreamReq = never, Req = never>(
  props: VocabularyEventSourceProps,
  process: (
    events: Stream.Stream<VocabularyEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "TranscribeVocabularyEvents",
    {
      source: ["aws.transcribe"],
      "detail-type": ["Vocabulary State Change"],
      ...(props.states
        ? { detail: { VocabularyState: [...props.states] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );

export interface LanguageModelEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "TranscribeLanguageModelEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.ModelStatus` values.
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source for Amazon Transcribe `Language Model State Change` events
 * (source `aws.transcribe`) — fires when custom language model training
 * (started with {@link CreateLanguageModel}) reaches `COMPLETED` or
 * `FAILED`.
 *
 * @section Consuming Job Events
 * @example React To Trained Language Models
 * ```typescript
 * yield* AWS.Transcribe.consumeLanguageModelEvents(
 *   { statuses: ["COMPLETED"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`model ${event.detail.ModelName} trained`),
 *     ),
 * );
 * ```
 */
export const consumeLanguageModelEvents = <StreamReq = never, Req = never>(
  props: LanguageModelEventSourceProps,
  process: (
    events: Stream.Stream<LanguageModelEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "TranscribeLanguageModelEvents",
    {
      source: ["aws.transcribe"],
      "detail-type": ["Language Model State Change"],
      ...(props.statuses
        ? { detail: { ModelStatus: [...props.statuses] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
