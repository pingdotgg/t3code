import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

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
