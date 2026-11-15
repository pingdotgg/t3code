import type { ServerSettings } from "@t3tools/contracts";

/** The setting each platform honors for cloning worktrees from a checkout cache; also its capability. */
const FAST_CHECKOUT_SETTING = {
  darwin: "fastWorktreeCheckout",
  linux: "reflinkWorktrees",
} as const satisfies Partial<Record<NodeJS.Platform, keyof ServerSettings>>;

type FastCheckoutKey = (typeof FAST_CHECKOUT_SETTING)[keyof typeof FAST_CHECKOUT_SETTING];

const settingFor = (platform: NodeJS.Platform): FastCheckoutKey | undefined =>
  Object.hasOwn(FAST_CHECKOUT_SETTING, platform)
    ? FAST_CHECKOUT_SETTING[platform as keyof typeof FAST_CHECKOUT_SETTING]
    : undefined;

export const fastCheckoutFor = (
  settings: Pick<ServerSettings, FastCheckoutKey>,
  platform: NodeJS.Platform,
): boolean => {
  const key = settingFor(platform);
  return key === undefined ? false : settings[key];
};

export const fastCheckoutCapabilities = (
  platform: NodeJS.Platform,
): Partial<Record<FastCheckoutKey, true>> => {
  const key = settingFor(platform);
  return key === undefined ? {} : { [key]: true };
};

/** What decides where checkout caches may live; the ledger, not this, says which ones to delete. */
export interface CheckoutCacheRetention {
  readonly enabled: boolean;
  readonly current: string;
}

export const checkoutCacheRetention = (
  settings: Pick<ServerSettings, FastCheckoutKey | "worktreesDirectory">,
  platform: NodeJS.Platform,
): CheckoutCacheRetention => ({
  enabled: fastCheckoutFor(settings, platform),
  current: settings.worktreesDirectory,
});

export const sameCheckoutCacheRetention = (
  left: CheckoutCacheRetention,
  right: CheckoutCacheRetention,
): boolean => left.enabled === right.enabled && left.current === right.current;
