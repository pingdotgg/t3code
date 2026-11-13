import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as ExitRuntime from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Tracer from "effect/Tracer";
import { OtlpResource, OtlpTracer, OtlpSerialization } from "effect/observability";

import { makeAsyncRotatingFileSink } from "./logging.ts";
import type { EffectTraceRecord } from "./observability.ts";
import { redactExitCredentials, redactUrlCredentials, spanToTraceRecord } from "./observability.ts";

export class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;
  private readonly delegate: Tracer.Span;
  private readonly push: (record: EffectTraceRecord) => void;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    // Cached lookup fibers retain parent spans. Traces need success status, not result payloads.
    const traceExit = ExitRuntime.isSuccess(exit) ? ExitRuntime.void : exit;
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit: traceExit,
    };
    this.delegate.end(endTime, redactExitCredentials(traceExit));

    if (this.sampled) {
      this.push(spanToTraceRecord(this));
    }
  }

  attribute(key: string, value: unknown): void {
    const recorded =
      (key === "url.full" || key === "url.query") && typeof value === "string"
        ? redactUrlCredentials(value)
        : value;
    this.attributes.set(key, recorded);
    this.delegate.attribute(key, recorded);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const cause = attributes?.["effect.cause"];
    const nextAttributes =
      typeof cause === "string"
        ? { ...attributes, "effect.cause": redactUrlCredentials(cause) }
        : (attributes ?? {});
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

