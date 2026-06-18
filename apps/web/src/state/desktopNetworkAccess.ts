import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_NETWORK_ACCESS_STALE_TIME_MS = 30_000;

type DesktopNetworkAccessBridge = Pick<
  DesktopBridge,
  "getAdvertisedEndpoints" | "getServerExposureState"
>;

export interface DesktopNetworkAccessSnapshot {
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly serverExposureState: DesktopServerExposureState;
}

class DesktopNetworkAccessError extends Schema.TaggedErrorClass<DesktopNetworkAccessError>()(
  "DesktopNetworkAccessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function getDesktopNetworkAccessBridge(): DesktopNetworkAccessBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopNetworkAccessStateAtom(
  getBridge: () => DesktopNetworkAccessBridge | undefined,
) {
  const loadDesktopNetworkAccess = Effect.fn("loadDesktopNetworkAccess")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopNetworkAccessError({
        message: "Desktop network access is unavailable.",
      });
    }
    return yield* Effect.tryPromise({
      try: async (): Promise<DesktopNetworkAccessSnapshot> => {
        const [serverExposureState, advertisedEndpoints] = await Promise.all([
          bridge.getServerExposureState(),
          bridge.getAdvertisedEndpoints(),
        ]);
        return { advertisedEndpoints, serverExposureState };
      },
      catch: (cause) =>
        new DesktopNetworkAccessError({
          message:
            cause instanceof Error ? cause.message : "Failed to load desktop network access.",
          cause,
        }),
    });
  });

  return Atom.make(loadDesktopNetworkAccess()).pipe(
    Atom.swr({
      staleTime: DESKTOP_NETWORK_ACCESS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:network-access"),
  );
}

export const desktopNetworkAccessStateAtom = createDesktopNetworkAccessStateAtom(
  getDesktopNetworkAccessBridge,
);

export function refreshDesktopNetworkAccessState(): void {
  appAtomRegistry.refresh(desktopNetworkAccessStateAtom);
}
