import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useUiStateStore } from "~/uiStateStore";
import { usePrimaryEnvironmentId } from "./environments";

import {
  desktopNetworkAccessStateAtom,
  selectDefaultAdvertisedEndpoint,
} from "./desktopNetworkAccess";

/** Base URL that a desktop-hosted browser can use to reach exposed local servers. */
export function useDesktopPreviewBaseUrl(environmentId: EnvironmentId | null): string | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const defaultEndpointKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const networkAccess = useAtomValue(desktopNetworkAccessStateAtom);
  if (
    typeof window === "undefined" ||
    window.desktopBridge === undefined ||
    environmentId === null ||
    environmentId === primaryEnvironmentId
  ) {
    return null;
  }
  if (
    networkAccess._tag !== "Success" ||
    networkAccess.value.serverExposureState.mode !== "network-accessible"
  ) {
    return "http://localhost";
  }
  return (
    selectDefaultAdvertisedEndpoint(networkAccess.value.advertisedEndpoints, defaultEndpointKey)
      ?.httpBaseUrl ?? null
  );
}
