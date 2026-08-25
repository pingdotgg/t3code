import type { SvgAssetComponent } from "@posthog/brand";
import {
  HedgehogHourglass,
  HedgehogOrganized,
  HedgehogPanic,
  HedgehogResearch,
  HedgehogStampApproved,
  HedgehogStampDenied,
} from "@posthog/brand/hoggies";

/**
 * The moments in the product that get a hedgehog, named by what happened
 * rather than by which drawing it is, so a moment keeps its illustration when
 * the brand package grows new ones.
 */
export const hoggies = {
  inboxZero: HedgehogOrganized,
  notConfigured: HedgehogResearch,
  requestFailed: HedgehogPanic,
  done: HedgehogStampApproved,
  failed: HedgehogStampDenied,
  loading: HedgehogHourglass,
} as const satisfies Record<string, SvgAssetComponent>;

export type HoggieName = keyof typeof hoggies;
export type HoggieComponent = (typeof hoggies)[HoggieName];
