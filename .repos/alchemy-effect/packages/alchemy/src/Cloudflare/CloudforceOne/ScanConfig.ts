import * as cloudforceOne from "@distilled.cloud/cloudflare/cloudforce-one";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.CloudforceOne.ScanConfig" as const;
type TypeId = typeof TypeId;

export type ScanConfigProps = {
  /**
   * IP addresses or CIDR blocks to scan. The maximum number of total IP
   * addresses allowed is 5000.
   */
  ips: string[];
  /**
   * Number of days between each scan (`0` = one-off scan).
   * @default 0
   */
  frequency?: number;
  /**
   * Ports to scan. Valid values are `"default"` (the 100 most commonly open
   * ports), `"all"`, or a list of ports / port ranges (e.g. `["1-80", "443"]`).
   * @default ["default"]
   */
  ports?: string[];
};

export type ScanConfigAttributes = {
  /**
   * Server-assigned scan config identifier (UUID).
   */
  configId: string;
  /**
   * The Cloudflare account the scan config belongs to.
   */
  accountId: string;
  /**
   * IP addresses or CIDR blocks being scanned.
   */
  ips: string[];
  /**
   * Number of days between each scan (`0` = one-off scan).
   */
  frequency: number;
  /**
   * Ports being scanned.
   */
  ports: string[];
};

export type ScanConfig = Resource<
  TypeId,
  ScanConfigProps,
  ScanConfigAttributes,
  never,
  Providers
>;

/**
 * A Cloudforce One attack-surface scan configuration.
 *
 * Cloudforce One (Cloudflare's threat-intelligence product) can periodically
 * port-scan IP addresses you own to map your attack surface. A scan config
 * declares which IPs to scan, on which ports, and how often. Scan results are
 * read back via the scan-results API; the config itself is the only
 * declarative piece.
 *
 * Requires the `cfone.port_scan` entitlement (Cloudforce One subscription) —
 * accounts without it receive an `Unauthorized` error for every scan-config
 * operation.
 * @resource
 * @product Cloudforce One
 * @category Observability & Analytics
 * @section Creating a Scan Config
 * @example One-off scan of a single address
 * ```typescript
 * const scan = yield* Cloudflare.CloudforceOne.ScanConfig("edge-scan", {
 *   ips: ["203.0.113.7/32"],
 *   frequency: 0,
 * });
 * ```
 *
 * @example Weekly scan of a CIDR block on specific ports
 * ```typescript
 * const scan = yield* Cloudflare.CloudforceOne.ScanConfig("perimeter", {
 *   ips: ["203.0.113.0/24"],
 *   frequency: 7,
 *   ports: ["1-80", "443"],
 * });
 * ```
 *
 * @section Updating
 * @example Change the schedule and port list in place
 * ```typescript
 * const scan = yield* Cloudflare.CloudforceOne.ScanConfig("perimeter", {
 *   ips: ["203.0.113.0/24"],
 *   frequency: 30,
 *   ports: ["all"],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/security-center/intel-apis/attack-surface-scans/
 */
export const ScanConfig = Resource<ScanConfig>(TypeId);

/**
 * Returns true if the given value is a ScanConfig resource.
 */
export const isScanConfig = (value: unknown): value is ScanConfig =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ScanConfigProvider = () =>
  Provider.succeed(ScanConfig, {
    stables: ["configId", "accountId"],
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      // Scan configs are account-scoped; moving accounts is a replacement.
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // ips / frequency / ports are all mutable via PATCH.
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // There is no get-by-id endpoint and configs carry no name, so a cold
      // read (lost state, no cached configId) has no identity to match — we
      // can only observe through the cached configId.
      if (!output?.configId) return undefined;
      const acct = output.accountId;
      const observed = yield* findConfig(acct, output.configId);
      return observed ? toAttributes(observed, acct) : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* cloudforceOne.listScanConfigs.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((c) => toAttributes(c, accountId)),
          ),
        ),
        // Accounts without the cfone.port_scan entitlement reject every
        // scan-config call with the typed Unauthorized — treat as "none".
        Effect.catchTag("Unauthorized", () =>
          Effect.succeed<ScanConfigAttributes[]>([]),
        ),
      );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Observe — the configId cached on `output` is a hint, not a
      // guarantee: missing from the list falls through to create.
      const observed = output?.configId
        ? yield* findConfig(output.accountId ?? accountId, output.configId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete).
        const created = yield* cloudforceOne.createScanConfig({
          accountId,
          ips: news.ips,
          frequency: news.frequency,
          ports: news.ports,
        });
        return toAttributes(created, accountId);
      }

      // Sync — diff observed cloud state against desired; PATCH accepts
      // partial bodies, so send only what the user pinned, and skip the
      // call entirely on a no-op.
      const dirty =
        !sameList(observed.ips, news.ips) ||
        (news.frequency !== undefined &&
          observed.frequency !== news.frequency) ||
        (news.ports !== undefined && !sameList(observed.ports, news.ports));

      if (!dirty) {
        return toAttributes(observed, observed.accountId);
      }

      const updated = yield* cloudforceOne
        .patchScanConfig({
          accountId: observed.accountId,
          configId: observed.id,
          ips: news.ips,
          frequency: news.frequency,
          ports: news.ports,
        })
        .pipe(
          // Deleted out-of-band between observe and patch — recreate.
          Effect.catchTag("ScanConfigNotFound", () =>
            cloudforceOne.createScanConfig({
              accountId,
              ips: news.ips,
              frequency: news.frequency,
              ports: news.ports,
            }),
          ),
        );
      return toAttributes(updated, observed.accountId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* cloudforceOne
        .deleteScanConfig({
          accountId: output.accountId,
          configId: output.configId,
        })
        .pipe(Effect.catchTag("ScanConfigNotFound", () => Effect.void));
    }),
  });

type ObservedScanConfig = {
  id: string;
  accountId: string;
  frequency: number;
  ips: readonly string[];
  ports: readonly string[];
};

/**
 * Find a scan config by id. There is no get-by-id endpoint, so observe via
 * the account-level list; absent from the list means gone.
 */
const findConfig = (accountId: string, configId: string) =>
  cloudforceOne
    .listScanConfigs({ accountId })
    .pipe(
      Effect.map((page): ObservedScanConfig | undefined =>
        page.result.find((c) => c.id === configId),
      ),
    );

const sameList = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  config: ObservedScanConfig,
  accountId: string,
): ScanConfigAttributes => ({
  configId: config.id,
  accountId,
  ips: [...config.ips],
  frequency: config.frequency,
  ports: [...config.ports],
});
