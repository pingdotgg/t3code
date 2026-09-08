// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export type Environment = "production" | "staging" | "fed-prod";

export interface ReadyAnalytics {
  logEvent: (e: ReadyAnalyticsEvent) => void;
}

export interface ReadyAnalyticsEvent {
  accountId?: number;
  indexId?: string;
  version?: number;
  doubles?: Array<number | undefined>;
  blobs?: Array<string | undefined>;
}
