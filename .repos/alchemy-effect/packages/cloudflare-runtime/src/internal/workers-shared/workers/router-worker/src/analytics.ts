// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { ReadyAnalytics } from "./types.ts";

// This will allow us to make breaking changes to the analytic schema
const VERSION = 1;

export enum STATIC_ROUTING_DECISION {
  NOT_PROVIDED = 0,
  NOT_ROUTED = 1,
  ROUTED = 2,
}

export enum DISPATCH_TYPE {
  ASSETS = "asset",
  WORKER = "worker",
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
  // double5 - Run user worker ahead of assets
  userWorkerAhead?: boolean;
  // double6 - Routing performed based on the _routes.json (if provided)
  staticRoutingDecision?: STATIC_ROUTING_DECISION;
  // double7 - Whether the request was blocked by abuse mitigation or not
  abuseMitigationBlocked?: boolean;
  // double8 - User worker invocation denied due to free tier limiting
  userWorkerFreeTierLimiting?: boolean;
  // double9 - The time it takes for the request to be handed off the Asset Worker or user Worker in milliseconds
  timeToDispatch?: number;

  // -- Blobs --
  // blob1 - Hostname of the request
  hostname?: string;
  // blob2 - Dispatch type - what kind of thing did we dispatch
  dispatchtype?: DISPATCH_TYPE;
  // blob3 - Error message
  error?: string;
  // blob4 - The current version UUID of router-server
  version?: string;
  // blob5 - Region of the colo (e.g. WEUR)
  coloRegion?: string;
  // blob6 - URL for analysis
  abuseMitigationURLHost?: string;
  // blob7 - XSS detection href parameter value
  xssDetectionImageHref?: string;
  // blob8 - cdn-cgi backslash bypass attempt URL
  cdnCgiBackslashBypassUrl?: string;
};

export class Analytics {
  private data: Data = {};
  private readyAnalytics?: ReadyAnalytics;
  private hasWritten: boolean = false;

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
    if (this.hasWritten) {
      // We've already written analytics, don't double send
      return;
    } else if (!this.readyAnalytics) {
      // Local environment, no-op
      return;
    }

    this.hasWritten = true;

    this.readyAnalytics.logEvent({
      version: VERSION,
      accountId: this.data.accountId,
      indexId: this.data.scriptId?.toString(),
      doubles: [
        this.data.requestTime ?? -1, // double1
        this.data.coloId ?? -1, // double2
        this.data.metalId ?? -1, // double3
        this.data.coloTier ?? -1, // double4
        this.data.userWorkerAhead === undefined // double5
          ? -1
          : Number(this.data.userWorkerAhead),
        this.data.staticRoutingDecision ?? STATIC_ROUTING_DECISION.NOT_PROVIDED, // double6
        this.data.abuseMitigationBlocked ? 1 : 0, // double7
        this.data.userWorkerFreeTierLimiting ? 1 : 0, // double8
        this.data.timeToDispatch ?? -1, // double9
      ],
      blobs: [
        this.data.hostname?.substring(0, 256), // blob1 - trim to 256 bytes
        this.data.dispatchtype, // blob2
        this.data.error?.substring(0, 256), // blob3 - trim to 256 bytes
        this.data.version, // blob4
        this.data.coloRegion, // blob5
        this.data.abuseMitigationURLHost, // blob6
        this.data.xssDetectionImageHref, // blob7
        this.data.cdnCgiBackslashBypassUrl?.substring(0, 256), // blob8 - trim to 256 bytes
      ],
    });
  }
}
