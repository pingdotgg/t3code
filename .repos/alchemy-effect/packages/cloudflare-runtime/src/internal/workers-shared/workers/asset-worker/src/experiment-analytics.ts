// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { ReadyAnalytics } from "./types.ts";

// This will allow us to make breaking changes to the analytic schema
const VERSION = 1;

// When adding new columns please update the schema
type Data = {
  // -- Indexes --
  accountId?: number;
  experimentName?: string;

  // -- Doubles --
  // double1 - The time it takes to read the manifest in milliseconds
  manifestReadTime?: number;

  // -- Blobs --
  // blob1 current or perfTest version of binary search
  binarySearchVersion?: "current" | "perfTest" | "current-fallback";
};

export class ExperimentAnalytics {
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

    this.readyAnalytics.logEvent({
      version: VERSION,
      accountId: this.data.accountId,
      indexId: this.data.experimentName,
      doubles: [
        this.data.manifestReadTime ?? -1, // double1
      ],
      blobs: [
        this.data.binarySearchVersion, // blob1
      ],
    });
  }
}
