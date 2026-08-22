export interface NetworkPathBaseline {
  readonly known: boolean;
  readonly type: string | null;
}

export const UNKNOWN_NETWORK_PATH: NetworkPathBaseline = {
  known: false,
  type: null,
};

export function seedNetworkPathBaseline(
  baseline: NetworkPathBaseline,
  type: string | null,
): NetworkPathBaseline {
  if (baseline.known || type === null) {
    return baseline;
  }
  return { known: true, type };
}

export function observeNetworkPath(
  baseline: NetworkPathBaseline,
  type: string | null,
): {
  readonly baseline: NetworkPathBaseline;
  readonly shouldProbe: boolean;
} {
  if (type === null) {
    return {
      baseline: UNKNOWN_NETWORK_PATH,
      shouldProbe: false,
    };
  }
  return {
    baseline: { known: true, type },
    // If the initial async seed has not landed, the first listener event may
    // itself be the WiFi/cellular transition. A cheap advisory probe is safer
    // than losing that transition and waiting for the socket ping timeout.
    shouldProbe: !baseline.known || baseline.type !== type,
  };
}
