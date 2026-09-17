// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { ENABLEMENT_COMPATIBILITY_FLAGS } from "./compatibility-flags.ts";
import type { ReadyAnalytics } from "./types.ts";

// This will allow us to make breaking changes to the analytic schema
const VERSION = 1;

// Identifies which entrypoint produced the analytics row.
// Values must stay in sync with the ClickHouse view in cloudflare/ch/ready-analytics.
export enum EntrypointType {
  Outer = 0,
  Inner = 1,
}

// When adding new columns please update the schema
type Data = {
  // -- Indexes --
  accountId?: number;
  scriptId?: number;

  // -- Doubles --
  // double1 - The time it takes for the whole request to complete in milliseconds
  requestTime?: number;
  // double2 - Colo ID
  coloId?: number;
  // double3 - Metal ID
  metalId?: number;
  // double4 - Colo tier (e.g. tier 1, tier 2, tier 3)
  coloTier?: number;
  // double5 - Response status code
  status?: number;
  // double6 - Compatibility flags
  compatibilityFlags?: Array<string>; // converted into a bitmask
  // double7 - Entrypoint discriminator (see EntrypointType enum)
  entrypoint?: EntrypointType;

  // -- Blobs --
  // blob1 - Hostname of the request
  hostname?: string;
  // blob2 - User agent making the request
  userAgent?: string;
  // blob3 - Html handling option
  htmlHandling?: string;
  // blob4 - Not found handling option
  notFoundHandling?: string;
  // blob5 - Error message
  error?: string;
  // blob6 - The current version UUID of asset-worker
  version?: string;
  // blob7 - Region of the colo (e.g. WEUR)
  coloRegion?: string;
  // blob8 - The cache status of the request
  cacheStatus?: string;
  // blob9 - Account cohort ("ent", "paid", "free", "employee", or "unknown")
  cohort?: string;
};

const COMPATIBILITY_FLAG_MASKS: Record<ENABLEMENT_COMPATIBILITY_FLAGS, number> =
  {
    assets_navigation_prefers_asset_serving: 1 << 0,
    // next_one: 1 << 1
    // one_after_that: 1 << 2
    // etc: 1 << 3
  };

export class Analytics {
  private data: Data = {};
  private readyAnalytics?: ReadyAnalytics;

  constructor(readyAnalytics?: ReadyAnalytics) {
    this.readyAnalytics = readyAnalytics;
  }

  setData(newData: Partial<Data>) {
    this.data = { ...this.data, ...newData };
  }

  getData(key: keyof Data) {
    return this.data[key];
  }

  write() {
    if (!this.readyAnalytics) {
      return;
    }

    let compatibilityFlagsBitmask = 0;
    for (const compatibilityFlag of this.data.compatibilityFlags || []) {
      const mask =
        COMPATIBILITY_FLAG_MASKS[
          compatibilityFlag as ENABLEMENT_COMPATIBILITY_FLAGS
        ];
      if (mask) {
        compatibilityFlagsBitmask += mask;
      }
    }

    this.readyAnalytics.logEvent({
      version: VERSION,
      accountId: this.data.accountId,
      indexId: this.data.scriptId?.toString(),
      doubles: [
        this.data.requestTime ?? -1, // double1
        this.data.coloId ?? -1, // double2
        this.data.metalId ?? -1, // double3
        this.data.coloTier ?? -1, // double4
        this.data.status ?? -1, // double5
        compatibilityFlagsBitmask, // double6
        this.data.entrypoint ?? -1, // double7
      ],
      blobs: [
        this.data.hostname?.substring(0, 256), // blob1 - trim to 256 bytes
        this.data.userAgent?.substring(0, 256), // blob2 - trim to 256 bytes
        this.data.htmlHandling, // blob3
        this.data.notFoundHandling, // blob4
        this.data.error?.substring(0, 256), // blob5 - trim to 256 bytes
        this.data.version, // blob6
        this.data.coloRegion, // blob7
        this.data.cacheStatus, // blob8
        this.data.cohort, // blob9
      ],
    });
  }
}
