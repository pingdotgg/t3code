// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { InternalServerErrorResponse } from "../../../../shared/responses.ts";
import type { PerformanceTimer } from "../../../../shared/performance.ts";
import type { Analytics } from "../analytics.ts";
import type { Toucan } from "toucan-js";

export function handleError(
  sentry: Toucan | undefined,
  analytics: Analytics,
  err: unknown,
) {
  try {
    const response = new InternalServerErrorResponse(err as Error);

    // Log to Sentry if we can
    if (sentry) {
      sentry.captureException(err);
    }

    if (err instanceof Error) {
      analytics.setData({ error: err.message });
    }

    return response;
  } catch (e) {
    console.error("Error handling error", e);
    return new InternalServerErrorResponse(e as Error);
  }
}

export function submitMetrics(
  analytics: Analytics,
  performance: PerformanceTimer,
  startTimeMs: number,
) {
  try {
    analytics.setData({ requestTime: performance.now() - startTimeMs });
    analytics.write();
  } catch (e) {
    console.error("Error submitting metrics", e);
  }
}
