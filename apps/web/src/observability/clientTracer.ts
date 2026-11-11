import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

import { randomUUID } from "../lib/utils";

/** `service.instance.id` for this page load, shared by every resource the UI exports. */
export const serviceInstanceId = randomUUID();

let delegate: Tracer.Tracer | null = null;

export function setDelegate(next: Tracer.Tracer | null): void {
  delegate = next;
}

export function hasDelegate(): boolean {
  return delegate !== null;
}

// Install before exporters exist so spans reach whichever exporter is configured later.
export const layer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return delegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);
