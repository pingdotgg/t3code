// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { UnsafePerformanceTimer } from "./types.ts";

export class PerformanceTimer {
  private performanceTimer;

  constructor(performanceTimer?: UnsafePerformanceTimer) {
    this.performanceTimer = performanceTimer;
  }

  now() {
    if (this.performanceTimer) {
      return this.performanceTimer.timeOrigin + this.performanceTimer.now();
    }
    return Date.now();
  }
}
