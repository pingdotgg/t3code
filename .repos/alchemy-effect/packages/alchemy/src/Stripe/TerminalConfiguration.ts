import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteTerminalConfiguration,
  GetTerminalConfigurations,
  GetTerminalConfiguration,
  CreateTerminalConfiguration,
  UpdateTerminalConfiguration,
  type DeletedTerminalConfiguration,
  type CreateTerminalConfigurationRequest,
  type CreateTerminalConfigurationRequestTippingCase0,
  type CreateTerminalConfigurationRequestWifiCase0,
  type TerminalConfiguration as StripeTerminalConfiguration,
  type TerminalConfigurationConfigurationResourceCurrencySpecificConfig,
  type TerminalConfigurationConfigurationResourceDeviceTypeSpecificConfig,
  type TerminalConfigurationConfigurationResourceTipping,
  type TerminalConfigurationConfigurationResourceWifiConfig,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const NAME_MAX_LENGTH = 250;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** Fixed amounts / percentages shown when collecting an on-reader tip. */
export interface TerminalTippingCurrency {
  /**
   * Fixed amounts (in the currency's minor units) displayed when
   * collecting a tip.
   */
  fixedAmounts?: number[];
  /**
   * Percentages displayed when collecting a tip.
   */
  percentages?: number[];
  /**
   * Below this amount (minor units), fixed amounts are shown; above it,
   * percentages are shown. Requires both `fixedAmounts` and `percentages`.
   */
  smartTipThreshold?: number;
}

/** Per-currency on-reader tipping. Keys are lowercase ISO 4217 codes. */
export interface TerminalTipping {
  /** Tipping configuration for AED. */
  aed?: TerminalTippingCurrency;
  /** Tipping configuration for AUD. */
  aud?: TerminalTippingCurrency;
  /** Tipping configuration for CAD. */
  cad?: TerminalTippingCurrency;
  /** Tipping configuration for CHF. */
  chf?: TerminalTippingCurrency;
  /** Tipping configuration for CZK. */
  czk?: TerminalTippingCurrency;
  /** Tipping configuration for DKK. */
  dkk?: TerminalTippingCurrency;
  /** Tipping configuration for EUR. */
  eur?: TerminalTippingCurrency;
  /** Tipping configuration for GBP. */
  gbp?: TerminalTippingCurrency;
  /** Tipping configuration for GIP. */
  gip?: TerminalTippingCurrency;
  /** Tipping configuration for HKD. */
  hkd?: TerminalTippingCurrency;
  /** Tipping configuration for HUF. */
  huf?: TerminalTippingCurrency;
  /** Tipping configuration for JPY. */
  jpy?: TerminalTippingCurrency;
  /** Tipping configuration for MXN. */
  mxn?: TerminalTippingCurrency;
  /** Tipping configuration for MYR. */
  myr?: TerminalTippingCurrency;
  /** Tipping configuration for NOK. */
  nok?: TerminalTippingCurrency;
  /** Tipping configuration for NZD. */
  nzd?: TerminalTippingCurrency;
  /** Tipping configuration for PLN. */
  pln?: TerminalTippingCurrency;
  /** Tipping configuration for RON. */
  ron?: TerminalTippingCurrency;
  /** Tipping configuration for SEK. */
  sek?: TerminalTippingCurrency;
  /** Tipping configuration for SGD. */
  sgd?: TerminalTippingCurrency;
  /** Tipping configuration for USD. */
  usd?: TerminalTippingCurrency;
}

/** Device-specific splash screen. */
export interface TerminalDeviceConfig {
  /**
   * Stripe File id of an image to display on the reader. Empty string
   * clears it on update.
   */
  splashscreen?: string;
}

/** Offline-mode collection. */
export interface TerminalOffline {
  /**
   * Whether the reader may collect transactions while offline.
   */
  enabled: boolean;
}

/** Cellular connectivity. */
export interface TerminalCellular {
  /**
   * Whether a cellular-capable reader may connect over cellular.
   */
  enabled: boolean;
}

/** Daily reboot window (hours in 0–23). */
export interface TerminalRebootWindow {
  /**
   * Start hour of the reboot window (0–23).
   */
  startHour: number;
  /**
   * End hour of the reboot window (0–23). Must differ from `startHour`.
   */
  endHour: number;
}

/** Wi-Fi security type. */
export type TerminalWifiType =
  | "enterprise_eap_peap"
  | "enterprise_eap_tls"
  | "personal_psk";

/** WPA-Enterprise EAP-PEAP credentials. */
export interface TerminalWifiEnterprisePeap {
  /**
   * Wi-Fi network name.
   */
  ssid: string;
  /**
   * Username for the network.
   */
  username: string;
  /**
   * Password for the network. Never returned on read.
   */
  password: string;
  /**
   * Stripe File id of a PEM containing the server certificate.
   */
  caCertificateFile?: string;
}

/** WPA-Enterprise EAP-TLS credentials. */
export interface TerminalWifiEnterpriseTls {
  /**
   * Wi-Fi network name.
   */
  ssid: string;
  /**
   * Stripe File id of a PEM containing the client certificate.
   */
  clientCertificateFile: string;
  /**
   * Stripe File id of a PEM containing the client RSA private key.
   */
  privateKeyFile: string;
  /**
   * Stripe File id of a PEM containing the server certificate.
   */
  caCertificateFile?: string;
  /**
   * Password for the private key file. Never returned on read.
   */
  privateKeyFilePassword?: string;
}

/** WPA-Personal PSK credentials. */
export interface TerminalWifiPersonalPsk {
  /**
   * Wi-Fi network name.
   */
  ssid: string;
  /**
   * Password for the network. Never returned on read.
   */
  password: string;
}

/** Reader Wi-Fi configuration. */
export interface TerminalWifi {
  /**
   * Security type. The matching nested object holds the credentials.
   */
  type: TerminalWifiType;
  /**
   * EAP-PEAP credentials. Required when `type` is `enterprise_eap_peap`.
   */
  enterpriseEapPeap?: TerminalWifiEnterprisePeap;
  /**
   * EAP-TLS credentials. Required when `type` is `enterprise_eap_tls`.
   */
  enterpriseEapTls?: TerminalWifiEnterpriseTls;
  /**
   * Personal PSK credentials. Required when `type` is `personal_psk`.
   */
  personalPsk?: TerminalWifiPersonalPsk;
}

/** Observed Wi-Fi state with secrets stripped. */
export interface TerminalWifiState {
  /**
   * Security type currently configured.
   */
  type: TerminalWifiType;
  /**
   * Observed EAP-PEAP settings (password omitted).
   */
  enterpriseEapPeap?: {
    ssid: string;
    username: string;
    caCertificateFile: string | undefined;
  };
  /**
   * Observed EAP-TLS settings (private-key password omitted).
   */
  enterpriseEapTls?: {
    ssid: string;
    clientCertificateFile: string;
    privateKeyFile: string;
    caCertificateFile: string | undefined;
  };
  /**
   * Observed personal PSK settings (password omitted).
   */
  personalPsk?: {
    ssid: string;
  };
}

export interface TerminalConfigurationProps {
  /**
   * Display name of the configuration. If omitted, a unique name is
   * generated from the stack, stage, and logical id. Mutable. Used as the
   * lookup key when the Stripe id is missing — this object has no
   * metadata.
   */
  name?: string;
  /**
   * Offline transaction collection. `null` clears it on update.
   */
  offline?: TerminalOffline | null;
  /**
   * On-reader tipping by currency. `null` clears it on update.
   */
  tipping?: TerminalTipping | null;
  /**
   * Daily reboot window. `null` clears it on update.
   */
  rebootWindow?: TerminalRebootWindow | null;
  /**
   * Cellular connectivity. `null` clears it on update.
   */
  cellular?: TerminalCellular | null;
  /**
   * Reader Wi-Fi. `null` clears it on update. Passwords are write-only.
   */
  wifi?: TerminalWifi | null;
  /**
   * BBPOS WisePad 3 splash screen. `null` clears it on update.
   */
  bbposWisepad3?: TerminalDeviceConfig | null;
  /**
   * BBPOS WisePOS E splash screen. `null` clears it on update.
   */
  bbposWiseposE?: TerminalDeviceConfig | null;
  /**
   * Stripe S700 splash screen. `null` clears it on update.
   */
  stripeS700?: TerminalDeviceConfig | null;
  /**
   * Stripe S710 splash screen. `null` clears it on update.
   */
  stripeS710?: TerminalDeviceConfig | null;
  /**
   * Verifone M425 splash screen. `null` clears it on update.
   */
  verifoneM425?: TerminalDeviceConfig | null;
  /**
   * Verifone P400 splash screen. `null` clears it on update.
   */
  verifoneP400?: TerminalDeviceConfig | null;
  /**
   * Verifone P630 splash screen. `null` clears it on update.
   */
  verifoneP630?: TerminalDeviceConfig | null;
  /**
   * Verifone UX700 splash screen. `null` clears it on update.
   */
  verifoneUx700?: TerminalDeviceConfig | null;
  /**
   * Verifone V660p splash screen. `null` clears it on update.
   */
  verifoneV660p?: TerminalDeviceConfig | null;
}

type DeviceKey = (typeof DEVICE_MAP)[number][0];
type SnakeDeviceKey = (typeof DEVICE_MAP)[number][1];
type TippingCurrency = (typeof TIPPING_CURRENCIES)[number];

const DEVICE_MAP = [
  ["bbposWisepad3", "bbpos_wisepad3"],
  ["bbposWiseposE", "bbpos_wisepos_e"],
  ["stripeS700", "stripe_s700"],
  ["stripeS710", "stripe_s710"],
  ["verifoneM425", "verifone_m425"],
  ["verifoneP400", "verifone_p400"],
  ["verifoneP630", "verifone_p630"],
  ["verifoneUx700", "verifone_ux700"],
  ["verifoneV660p", "verifone_v660p"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

const TIPPING_CURRENCIES = [
  "aed",
  "aud",
  "cad",
  "chf",
  "czk",
  "dkk",
  "eur",
  "gbp",
  "gip",
  "hkd",
  "huf",
  "jpy",
  "mxn",
  "myr",
  "nok",
  "nzd",
  "pln",
  "ron",
  "sek",
  "sgd",
  "usd",
] as const satisfies ReadonlyArray<keyof TerminalTipping>;

type DeviceAttributes = {
  [K in DeviceKey]: TerminalDeviceConfig | undefined;
};

export type TerminalConfiguration = Resource<
  "Stripe.TerminalConfiguration",
  TerminalConfigurationProps,
  {
    /** Stripe Terminal configuration id (`tmc_…`). */
    id: string;
    /** Display name of the configuration, if set. */
    name: string | undefined;
    /** Whether this is the account's default configuration. */
    isAccountDefault: boolean;
    /** Offline transaction collection, if configured. */
    offline: TerminalOffline | undefined;
    /** On-reader tipping by currency, if configured. */
    tipping: TerminalTipping | undefined;
    /** Daily reboot window, if configured. */
    rebootWindow: TerminalRebootWindow | undefined;
    /** Cellular connectivity, if configured. */
    cellular: TerminalCellular | undefined;
    /** Observed Wi-Fi (passwords omitted). */
    wifi: TerminalWifiState | undefined;
    /** Whether the configuration exists in live mode. */
    livemode: boolean;
  } & DeviceAttributes,
  never,
  Providers
>;

/**
 * A Stripe Terminal Configuration — splash screens, tipping, offline
 * mode, reboot window, cellular, and Wi-Fi for smart readers. Name and
 * nested settings update in place. Destroy hard-deletes the
 * configuration. The account default configuration is never adopted or
 * listed.
 *
 * Terminal configurations have no metadata field. Identity is the Stripe
 * id plus the unique name. Account-wide `list()` (nuke) enumerates every
 * non-default configuration on the account.
 *
 * @see https://docs.stripe.com/api/terminal/configuration
 *
 * ### Creating a Configuration
 * **Example:** Named configuration with USD tipping
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("storefront", {
 *   name: "Storefront",
 *   offline: { enabled: true },
 *   tipping: {
 *     usd: {
 *       fixedAmounts: [100, 200, 300],
 *       percentages: [15, 20, 25],
 *       smartTipThreshold: 1000,
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Reboot window
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("storefront", {
 *   name: "Storefront",
 *   rebootWindow: { startHour: 2, endHour: 4 },
 * });
 * ```
 *
 * ### Updating a Configuration
 * **Example:** Rename and change tipping
 * ```typescript
 * const config = yield* Stripe.TerminalConfiguration("storefront", {
 *   name: "Storefront (updated)",
 *   offline: { enabled: false },
 *   tipping: {
 *     usd: {
 *       fixedAmounts: [200, 300, 400],
 *       percentages: [10, 15, 20],
 *       smartTipThreshold: 2000,
 *     },
 *   },
 * });
 * ```
 *
 * ### Deleting a Configuration
 * **Example:** Destroy deletes the configuration
 * ```typescript
 * // stack.destroy() / resource removal hard-deletes the configuration
 * const config = yield* Stripe.TerminalConfiguration("storefront", {
 *   name: "Storefront",
 * });
 * ```
 *
 * @resource
 */
export const TerminalConfiguration = Resource<TerminalConfiguration>(
  "Stripe.TerminalConfiguration",
);

export class TerminalConfigurationNotResolved extends Data.TaggedError(
  "Stripe.TerminalConfigurationNotResolved",
)<{
  configurationId: string | undefined;
  name: string;
}> {}

type ConfigurationAttributes = TerminalConfiguration["Attributes"];

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const isDeletedConfiguration = (
  value: StripeTerminalConfiguration | DeletedTerminalConfiguration,
): value is DeletedTerminalConfiguration =>
  "deleted" in value && value.deleted === true;

const asConfiguration = (
  value: StripeTerminalConfiguration | DeletedTerminalConfiguration | undefined,
): StripeTerminalConfiguration | undefined => {
  if (value === undefined || isDeletedConfiguration(value)) return undefined;
  return value;
};

const isAccountDefault = (configuration: StripeTerminalConfiguration) =>
  configuration.is_account_default === true;

const toFileId = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  if (
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return undefined;
};

const toDeviceState = (
  value:
    | TerminalConfigurationConfigurationResourceDeviceTypeSpecificConfig
    | undefined,
): TerminalDeviceConfig | undefined => {
  if (value === undefined) return undefined;
  const splashscreen = toFileId(value.splashscreen);
  return splashscreen === undefined ? {} : { splashscreen };
};

const toTippingCurrency = (
  value:
    | TerminalConfigurationConfigurationResourceCurrencySpecificConfig
    | undefined,
): TerminalTippingCurrency | undefined => {
  if (value === undefined) return undefined;
  return {
    ...(value.fixed_amounts != null
      ? { fixedAmounts: value.fixed_amounts }
      : {}),
    ...(value.percentages != null ? { percentages: value.percentages } : {}),
    ...(value.smart_tip_threshold !== undefined
      ? { smartTipThreshold: value.smart_tip_threshold }
      : {}),
  };
};

const toTipping = (
  tipping: TerminalConfigurationConfigurationResourceTipping | undefined,
): TerminalTipping | undefined => {
  if (tipping === undefined) return undefined;
  const out: TerminalTipping = {};
  for (const currency of TIPPING_CURRENCIES) {
    const mapped = toTippingCurrency(tipping[currency]);
    if (mapped !== undefined) out[currency] = mapped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const toWifiState = (
  wifi: TerminalConfigurationConfigurationResourceWifiConfig | undefined,
): TerminalWifiState | undefined => {
  if (wifi === undefined) return undefined;
  return {
    type: wifi.type,
    ...(wifi.enterprise_eap_peap !== undefined
      ? {
          enterpriseEapPeap: {
            ssid: wifi.enterprise_eap_peap.ssid,
            username: wifi.enterprise_eap_peap.username,
            caCertificateFile: wifi.enterprise_eap_peap.ca_certificate_file,
          },
        }
      : {}),
    ...(wifi.enterprise_eap_tls !== undefined
      ? {
          enterpriseEapTls: {
            ssid: wifi.enterprise_eap_tls.ssid,
            clientCertificateFile:
              wifi.enterprise_eap_tls.client_certificate_file,
            privateKeyFile: wifi.enterprise_eap_tls.private_key_file,
            caCertificateFile: wifi.enterprise_eap_tls.ca_certificate_file,
          },
        }
      : {}),
    ...(wifi.personal_psk !== undefined
      ? { personalPsk: { ssid: wifi.personal_psk.ssid } }
      : {}),
  };
};

const toAttrs = (
  configuration: StripeTerminalConfiguration,
): ConfigurationAttributes => {
  const devices = {} as DeviceAttributes;
  for (const [camel, snake] of DEVICE_MAP) {
    devices[camel] = toDeviceState(configuration[snake]);
  }
  return {
    id: configuration.id,
    name: configuration.name ?? undefined,
    isAccountDefault: isAccountDefault(configuration),
    offline:
      configuration.offline?.enabled == null
        ? undefined
        : { enabled: configuration.offline.enabled },
    tipping: toTipping(configuration.tipping),
    rebootWindow:
      configuration.reboot_window === undefined
        ? undefined
        : {
            startHour: configuration.reboot_window.start_hour,
            endHour: configuration.reboot_window.end_hour,
          },
    cellular:
      configuration.cellular === undefined
        ? undefined
        : { enabled: configuration.cellular.enabled },
    wifi: toWifiState(configuration.wifi),
    livemode: configuration.livemode,
    ...devices,
  };
};

const toWireTippingCurrency = (value: TerminalTippingCurrency) => ({
  ...(value.fixedAmounts !== undefined
    ? { fixed_amounts: value.fixedAmounts }
    : {}),
  ...(value.percentages !== undefined
    ? { percentages: value.percentages }
    : {}),
  ...(value.smartTipThreshold !== undefined
    ? { smart_tip_threshold: value.smartTipThreshold }
    : {}),
});

const toWireTipping = (
  tipping: TerminalTipping,
): CreateTerminalConfigurationRequestTippingCase0 => {
  const out: CreateTerminalConfigurationRequestTippingCase0 = {};
  for (const currency of TIPPING_CURRENCIES) {
    const value = tipping[currency];
    if (value !== undefined) {
      out[currency] = toWireTippingCurrency(value);
    }
  }
  return out;
};

const toWireWifi = (
  wifi: TerminalWifi,
): CreateTerminalConfigurationRequestWifiCase0 => ({
  type: wifi.type,
  ...(wifi.enterpriseEapPeap !== undefined
    ? {
        enterprise_eap_peap: {
          ssid: wifi.enterpriseEapPeap.ssid,
          username: wifi.enterpriseEapPeap.username,
          password: wifi.enterpriseEapPeap.password,
          ...(wifi.enterpriseEapPeap.caCertificateFile !== undefined
            ? { ca_certificate_file: wifi.enterpriseEapPeap.caCertificateFile }
            : {}),
        },
      }
    : {}),
  ...(wifi.enterpriseEapTls !== undefined
    ? {
        enterprise_eap_tls: {
          ssid: wifi.enterpriseEapTls.ssid,
          client_certificate_file: wifi.enterpriseEapTls.clientCertificateFile,
          private_key_file: wifi.enterpriseEapTls.privateKeyFile,
          ...(wifi.enterpriseEapTls.caCertificateFile !== undefined
            ? { ca_certificate_file: wifi.enterpriseEapTls.caCertificateFile }
            : {}),
          ...(wifi.enterpriseEapTls.privateKeyFilePassword !== undefined
            ? {
                private_key_file_password:
                  wifi.enterpriseEapTls.privateKeyFilePassword,
              }
            : {}),
        },
      }
    : {}),
  ...(wifi.personalPsk !== undefined
    ? {
        personal_psk: {
          ssid: wifi.personalPsk.ssid,
          password: wifi.personalPsk.password,
        },
      }
    : {}),
});

const toWireDevice = (device: TerminalDeviceConfig) =>
  device.splashscreen !== undefined
    ? { splashscreen: device.splashscreen }
    : {};

const wifiComparable = (
  wifi: TerminalWifi | TerminalWifiState | undefined,
): unknown => {
  if (wifi === undefined) return undefined;
  return {
    type: wifi.type,
    enterpriseEapPeap:
      wifi.enterpriseEapPeap === undefined
        ? undefined
        : {
            ssid: wifi.enterpriseEapPeap.ssid,
            username:
              "username" in wifi.enterpriseEapPeap
                ? wifi.enterpriseEapPeap.username
                : undefined,
            caCertificateFile: wifi.enterpriseEapPeap.caCertificateFile,
          },
    enterpriseEapTls:
      wifi.enterpriseEapTls === undefined
        ? undefined
        : {
            ssid: wifi.enterpriseEapTls.ssid,
            clientCertificateFile: wifi.enterpriseEapTls.clientCertificateFile,
            privateKeyFile: wifi.enterpriseEapTls.privateKeyFile,
            caCertificateFile: wifi.enterpriseEapTls.caCertificateFile,
          },
    personalPsk:
      wifi.personalPsk === undefined
        ? undefined
        : { ssid: wifi.personalPsk.ssid },
  };
};

const pickSpecified = (desired: unknown, observed: unknown): unknown => {
  if (desired === undefined) return undefined;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed)) return observed;
    return desired.map((item, index) => pickSpecified(item, observed[index]));
  }
  if (
    desired !== null &&
    typeof desired === "object" &&
    observed !== null &&
    typeof observed === "object"
  ) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(desired as Record<string, unknown>)) {
      out[key] = pickSpecified(
        (desired as Record<string, unknown>)[key],
        (observed as Record<string, unknown>)[key],
      );
    }
    return out;
  }
  return observed;
};

const nestedNeedSync = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return false;
  if (desired === null) return observed !== undefined;
  return !deepEqual(desired, pickSpecified(desired, observed), {
    stripNullish: true,
  });
};

const isMissingConfiguration = isMissingStripeResource;

const getById = (configuration: string) =>
  GetTerminalConfiguration({ configuration }).pipe(
    Effect.map(asConfiguration),
    Effect.catchIf(isMissingConfiguration, () => Effect.succeed(undefined)),
  );

const listNonDefault = Effect.fn(function* () {
  const configurations: StripeTerminalConfiguration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetTerminalConfigurations({
      is_account_default: false,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    configurations.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return configurations.filter(
    (configuration) => !isAccountDefault(configuration),
  );
});

const findByName = Effect.fn(function* (name: string) {
  const configurations = yield* listNonDefault();
  return configurations.find(
    (configuration) => (configuration.name ?? "") === name,
  );
});

const observe = Effect.fn(function* (input: { id?: string; name?: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.name !== undefined) {
    return yield* findByName(input.name);
  }
  return undefined;
});

type DeviceWire = { splashscreen?: string };

const specifiedDevices = (
  news: TerminalConfigurationProps,
): Partial<Record<SnakeDeviceKey, DeviceWire | "">> => {
  const payload: Partial<Record<SnakeDeviceKey, DeviceWire | "">> = {};
  for (const [camel, snake] of DEVICE_MAP) {
    const value = news[camel];
    if (value === undefined) continue;
    payload[snake] = value === null ? "" : toWireDevice(value);
  }
  return payload;
};

const toCreatePayload = (
  name: string,
  news: TerminalConfigurationProps,
): CreateTerminalConfigurationRequest => {
  const devices = specifiedDevices(news);
  const createDevices: Partial<Record<SnakeDeviceKey, DeviceWire>> = {};
  for (const [snake, value] of Object.entries(devices) as Array<
    [SnakeDeviceKey, DeviceWire | ""]
  >) {
    if (value !== "") createDevices[snake] = value;
  }
  return {
    name,
    ...(news.offline != null ? { offline: news.offline } : {}),
    ...(news.tipping != null ? { tipping: toWireTipping(news.tipping) } : {}),
    ...(news.rebootWindow != null
      ? {
          reboot_window: {
            start_hour: news.rebootWindow.startHour,
            end_hour: news.rebootWindow.endHour,
          },
        }
      : {}),
    ...(news.cellular != null ? { cellular: news.cellular } : {}),
    ...(news.wifi != null ? { wifi: toWireWifi(news.wifi) } : {}),
    ...createDevices,
  };
};

export const TerminalConfigurationProvider = () =>
  Provider.succeed(TerminalConfiguration, {
    stables: ["id", "livemode", "isAccountDefault"],

    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const existing = yield* observe({
        id: output?.id,
        name: output?.name,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      // No metadata. Identity is the Stripe id and unique name. Never
      // take over the account default configuration.
      return isAccountDefault(existing) ? Unowned(attrs) : attrs;
    }),

    list: Effect.fn(function* () {
      // No metadata on this resource. Account-wide list is every
      // non-default configuration so nuke can drain the account.
      const configurations = yield* listNonDefault();
      return configurations.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const name = yield* toName(id, news.name, output?.name);

      let current = yield* observe({
        id: output?.id,
        name,
      });
      if (current !== undefined && isAccountDefault(current)) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateTerminalConfiguration(
          toCreatePayload(name, news),
        ).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-terminal-configuration-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new TerminalConfigurationNotResolved({
          configurationId: output?.id,
          name,
        });
      }

      const attrs = toAttrs(current);
      const nameChanged = (current.name ?? "") !== name;
      const offlineChanged = nestedNeedSync(news.offline, attrs.offline);
      const tippingChanged = nestedNeedSync(news.tipping, attrs.tipping);
      const rebootWindowChanged = nestedNeedSync(
        news.rebootWindow,
        attrs.rebootWindow,
      );
      const cellularChanged = nestedNeedSync(news.cellular, attrs.cellular);
      const wifiChanged =
        news.wifi === null
          ? attrs.wifi !== undefined
          : news.wifi !== undefined &&
            nestedNeedSync(
              wifiComparable(news.wifi),
              wifiComparable(attrs.wifi),
            );

      const changedDevices: Partial<Record<SnakeDeviceKey, DeviceWire | "">> =
        {};
      for (const [camel, snake] of DEVICE_MAP) {
        const desired = news[camel];
        if (desired === undefined) continue;
        if (nestedNeedSync(desired, attrs[camel])) {
          changedDevices[snake] = desired === null ? "" : toWireDevice(desired);
        }
      }
      const devicesChanged = Object.keys(changedDevices).length > 0;

      if (
        !nameChanged &&
        !offlineChanged &&
        !tippingChanged &&
        !rebootWindowChanged &&
        !cellularChanged &&
        !wifiChanged &&
        !devicesChanged
      ) {
        return attrs;
      }

      const updated = yield* UpdateTerminalConfiguration({
        configuration: current.id,
        ...(nameChanged ? { name } : {}),
        ...(offlineChanged
          ? { offline: news.offline === null ? "" : news.offline! }
          : {}),
        ...(tippingChanged
          ? {
              tipping:
                news.tipping === null ? "" : toWireTipping(news.tipping!),
            }
          : {}),
        ...(rebootWindowChanged
          ? {
              reboot_window:
                news.rebootWindow === null
                  ? ""
                  : {
                      start_hour: news.rebootWindow!.startHour,
                      end_hour: news.rebootWindow!.endHour,
                    },
            }
          : {}),
        ...(cellularChanged
          ? { cellular: news.cellular === null ? "" : news.cellular! }
          : {}),
        ...(wifiChanged
          ? { wifi: news.wifi === null ? "" : toWireWifi(news.wifi!) }
          : {}),
        ...changedDevices,
      });
      const next = asConfiguration(updated);
      if (next === undefined) {
        return yield* new TerminalConfigurationNotResolved({
          configurationId: current.id,
          name,
        });
      }
      return toAttrs(next);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || isAccountDefault(existing)) return;
      yield* DeleteTerminalConfiguration({
        configuration: existing.id,
      }).pipe(Effect.catchIf(isMissingConfiguration, () => Effect.void));
    }),
  });
