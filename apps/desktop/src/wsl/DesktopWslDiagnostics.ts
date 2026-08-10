import type { DesktopWslDiagnosticRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export class DesktopWslDiagnostics extends Context.Service<
  DesktopWslDiagnostics,
  {
    readonly current: Effect.Effect<Option.Option<DesktopWslDiagnosticRecord>>;
    readonly record: (
      diagnostic: Omit<DesktopWslDiagnosticRecord, "occurredAt"> & { readonly occurredAt?: string },
    ) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/desktop/wsl/DesktopWslDiagnostics") {}

export const layer = Layer.effect(
  DesktopWslDiagnostics,
  Effect.gen(function* () {
    const ref = yield* Ref.make(Option.none<DesktopWslDiagnosticRecord>());
    return DesktopWslDiagnostics.of({
      current: Ref.get(ref),
      record: (diagnostic) =>
        Ref.set(
          ref,
          Option.some({
            ...diagnostic,
            occurredAt: diagnostic.occurredAt ?? new Date().toISOString(),
          }),
        ),
      clear: Ref.set(ref, Option.none()),
    });
  }),
);
