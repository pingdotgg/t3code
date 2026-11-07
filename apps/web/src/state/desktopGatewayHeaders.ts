import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

class DesktopGatewayHeadersLoadError extends Schema.TaggedError<DesktopGatewayHeadersLoadError>()(
  "DesktopGatewayHeadersLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load desktop gateway headers.";
  }
}

const loadDesktopGatewayHeaders = Effect.fn("loadDesktopGatewayHeaders")(function* () {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge) return [];
  return yield* Effect.tryPromise({
    try: () => bridge.getGatewayHeaders(),
    catch: (cause) => new DesktopGatewayHeadersLoadError({ cause }),
  });
});

export const desktopGatewayHeadersStateAtom = Atom.make(loadDesktopGatewayHeaders()).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:gateway-headers"),
);

export function refreshDesktopGatewayHeadersState(): void {
  appAtomRegistry.refresh(desktopGatewayHeadersStateAtom);
}
