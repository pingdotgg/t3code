import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

let delegate: Tracer.Tracer | null = null;

/**
 * Points the installed tracer at the exporter `configureClientTracing` just built,
 * or at nothing while no exporter is configured.
 */
export function setDelegate(next: Tracer.Tracer | null): void {
  delegate = next;
}

export function hasDelegate(): boolean {
  return delegate !== null;
}

/**
 * Installed once when the client runtime is built, before any exporter exists, so
 * client spans keep flowing to whatever exporter is configured later on.
 */
export const layer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return delegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);
