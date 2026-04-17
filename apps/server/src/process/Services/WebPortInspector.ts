import { Context, Schema } from "effect";
import type { Effect } from "effect";

export const DEFAULT_WEB_PORT_PROBE_TTL_MS = 10_000;

export type TerminalWebPortInspector = (
  port: number,
) => Effect.Effect<boolean, WebPortInspectionError>;

export class WebPortInspectionError extends Schema.TaggedErrorClass<WebPortInspectionError>()(
  "WebPortInspectionError",
  {
    port: Schema.Int,
    host: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Web port probe failed for ${this.host}:${this.port}: ${this.detail}`;
  }
}

export interface WebPortInspectorShape {
  readonly inspect: (port: number) => Effect.Effect<boolean, WebPortInspectionError>;
}

export class WebPortInspector extends Context.Service<WebPortInspector, WebPortInspectorShape>()(
  "t3/process/Services/WebPortInspector",
) {}
