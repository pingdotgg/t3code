import type { DesktopBridge, DesktopTailscaleStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

function getDesktopTailscaleBridge(): Pick<DesktopBridge, "getTailscaleStatus"> | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

const readDesktopTailscaleStatus = Effect.suspend(() => {
  const bridge = getDesktopTailscaleBridge();
  return bridge === undefined
    ? Effect.succeed(null)
    : Effect.tryPromise(() => bridge.getTailscaleStatus()).pipe(
        Effect.orElseSucceed((): DesktopTailscaleStatus | null => null),
      );
}).pipe(Effect.withSpan("desktopTailscale.read"));

/**
 * This device's Tailscale, read through the desktop app once per connection
 * attempt and only while mounted. Null outside the desktop app or on failure.
 */
export const desktopTailscaleStatusAtom = Atom.family((_attempt: number) =>
  Atom.make(readDesktopTailscaleStatus).pipe(Atom.withLabel("desktop:tailscale-status")),
);

/** For a diagnosis that does not need this device's Tailscale, so nothing is read. */
export const noDesktopTailscaleStatusAtom = Atom.make(
  AsyncResult.success<DesktopTailscaleStatus | null>(null),
).pipe(Atom.withLabel("desktop:tailscale-status:none"));
