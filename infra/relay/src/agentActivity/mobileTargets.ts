import type * as LiveActivities from "./LiveActivities.ts";

export type IosMobileTarget = LiveActivities.TargetRow;

export interface AndroidMobileTarget {
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: "android";
  readonly push_token: string | null;
  readonly preferences_json: string;
}

export type MobileTarget = IosMobileTarget | AndroidMobileTarget;

export function isAndroidMobileTarget(target: MobileTarget): target is AndroidMobileTarget {
  return target.platform === "android";
}
