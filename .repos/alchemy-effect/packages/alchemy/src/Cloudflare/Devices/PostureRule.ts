import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Devices.PostureRule" as const;
type TypeId = typeof TypeId;

/**
 * The type of device posture rule, e.g. `os_version`, `firewall`,
 * `disk_encryption`, or a third-party service-to-service integration type
 * like `crowdstrike_s2s` (which requires a posture integration's
 * `connectionId` in {@link DevicePostureRuleProps.input}).
 */
export type DevicePostureRuleType =
  zeroTrust.CreateDevicePostureRequest["type"];

/**
 * The per-type check definition for a posture rule. The accepted shape
 * depends on {@link DevicePostureRuleProps.type} — e.g. `os_version` takes
 * `{ operatingSystem, operator, version }`, `firewall` takes
 * `{ enabled, operatingSystem }`, `disk_encryption` takes
 * `{ checkDisks?, requireAll? }`.
 */
export type DevicePostureRuleInput =
  zeroTrust.CreateDevicePostureRequest["input"];

/**
 * Platform conditions that scope which devices run the rule.
 */
export type DevicePostureRuleMatch =
  zeroTrust.CreateDevicePostureRequest["match"];

export interface DevicePostureRuleProps {
  /**
   * Name of the device posture rule. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The type of posture check (e.g. `os_version`, `firewall`,
   * `disk_encryption`, `crowdstrike_s2s`). Immutable — changing the type
   * triggers a replacement.
   */
  type: DevicePostureRuleType;
  /**
   * A description of the posture rule.
   */
  description?: string;
  /**
   * Polling frequency for the WARP client posture check (e.g. `"5m"`,
   * `"1h"`). Minimum `1m`.
   * @default "5m"
   */
  schedule?: string;
  /**
   * Expiration time for a posture check result (e.g. `"1h"`). If empty,
   * the result remains valid until overwritten by new data from the WARP
   * client.
   */
  expiration?: string;
  /**
   * The conditions (platforms) that a device must match for the rule to
   * run, e.g. `[{ platform: "mac" }]`.
   */
  match?: DevicePostureRuleMatch;
  /**
   * The per-type value to check against. Shape depends on {@link type}.
   */
  input?: DevicePostureRuleInput;
}

export type DevicePostureRuleAttributes = {
  /** API UUID of the posture rule. */
  postureRuleId: string;
  /** Account that owns the rule. */
  accountId: string;
  /** Observed rule name. */
  name: string;
  /** Observed rule type. */
  type: string;
  /** Observed description. */
  description: string | undefined;
  /** Observed polling schedule. */
  schedule: string | undefined;
  /** Observed result expiration. */
  expiration: string | undefined;
  /** Observed platform conditions. */
  match: { platform: string | undefined }[] | undefined;
  /** Observed per-type check definition. */
  input: unknown;
};

export type DevicePostureRule = Resource<
  TypeId,
  DevicePostureRuleProps,
  DevicePostureRuleAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **device posture rule** — a periodic check the
 * WARP client runs on enrolled devices (OS version, firewall status, disk
 * encryption, file presence, or a third-party security provider's
 * verdict). Posture results can then gate Access policies and Gateway
 * rules.
 *
 * Everything except `type` is mutable in place (full PUT). Changing
 * `type` replaces the rule.
 * @resource
 * @product Devices
 * @category Cloudflare One (Zero Trust)
 * @section Infrastructure-free checks
 * @example Require a minimum Windows version
 * ```typescript
 * const rule = yield* Cloudflare.Devices.DevicePostureRule("WindowsOsVersion", {
 *   type: "os_version",
 *   description: "Require Windows 10.0.19045+",
 *   match: [{ platform: "windows" }],
 *   schedule: "5m",
 *   input: {
 *     operatingSystem: "windows",
 *     operator: ">=",
 *     version: "10.0.19045",
 *   },
 * });
 * ```
 *
 * @example Require the OS firewall to be enabled
 * ```typescript
 * yield* Cloudflare.Devices.DevicePostureRule("Firewall", {
 *   type: "firewall",
 *   match: [{ platform: "windows" }, { platform: "mac" }],
 *   input: { enabled: true, operatingSystem: "windows" },
 * });
 * ```
 *
 * @example Require disk encryption on all drives
 * ```typescript
 * yield* Cloudflare.Devices.DevicePostureRule("DiskEncryption", {
 *   type: "disk_encryption",
 *   match: [{ platform: "mac" }],
 *   input: { requireAll: true },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/identity/devices/
 */
export const DevicePostureRule = Resource<DevicePostureRule>(TypeId);

/**
 * Returns true if the given value is a DevicePostureRule resource.
 */
export const isDevicePostureRule = (
  value: unknown,
): value is DevicePostureRule =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const DevicePostureRuleProvider = () =>
  Provider.succeed(DevicePostureRule, {
    stables: ["postureRuleId", "accountId", "type"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection: exhaustively paginate the device
      // posture rules list and hydrate each into the `read` shape.
      return yield* zeroTrust.listDevicePostures.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((rule) => toAttributes(rule, accountId)),
          ),
        ),
        // Account lacks the Zero Trust / device posture entitlement.
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // `type` is immutable on Cloudflare's side — replace on change.
      const oldType = output?.type ?? olds?.type;
      if (oldType !== undefined && oldType !== news.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted rule id.
      if (output?.postureRuleId) {
        const observed = yield* observeRule(acct, output.postureRuleId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // Cold lookup: recover from lost state by exact name. Posture rules
      // carry no ownership markers, so brand the match `Unowned`.
      const name = yield* createRuleName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createRuleName(id, news.name);

      // 1. Observe — the rule id cached on `output` is a hint, not a
      //    guarantee: a missing rule falls through to create.
      const observed = output?.postureRuleId
        ? yield* observeRule(accountId, output.postureRuleId)
        : undefined;

      // 2. Ensure — create when missing. Names are not unique on
      //    Cloudflare's side, so there is no AlreadyExists race.
      if (!observed) {
        const created = yield* zeroTrust.createDevicePosture({
          accountId,
          name,
          type: news.type,
          description: news.description,
          schedule: news.schedule,
          expiration: news.expiration,
          match: news.match,
          input: news.input,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — the update API is a PUT that requires the full body;
      //    send everything, but skip the call entirely on a no-op.
      const dirty =
        (observed.name ?? "") !== name ||
        (news.description !== undefined &&
          !sameJSON(denull(observed.description), news.description)) ||
        (news.schedule !== undefined &&
          denull(observed.schedule) !== news.schedule) ||
        (news.expiration !== undefined &&
          denull(observed.expiration) !== news.expiration) ||
        (news.match !== undefined &&
          !sameJSON(normalizeMatch(observed.match), news.match)) ||
        (news.input !== undefined && !sameJSON(observed.input, news.input));
      if (!dirty) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* zeroTrust.updateDevicePosture({
        accountId,
        ruleId: observed.id!,
        name,
        type: news.type,
        description: news.description,
        schedule: news.schedule,
        expiration: news.expiration,
        match: news.match,
        input: news.input,
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare's delete is already idempotent (200 on a missing
      // rule); the typed catch covers the documented 404 path too.
      yield* zeroTrust
        .deleteDevicePosture({
          accountId: output.accountId,
          ruleId: output.postureRuleId,
        })
        .pipe(Effect.catchTag("PostureRuleNotFound", () => Effect.void));
    }),
  });

type ObservedRule =
  | zeroTrust.GetDevicePostureResponse
  | zeroTrust.CreateDevicePostureResponse
  | zeroTrust.UpdateDevicePostureResponse
  | zeroTrust.ListDevicePosturesResponse["result"][number];

/**
 * Read a posture rule by id, mapping "gone" (`PostureRuleNotFound`,
 * Cloudflare error code 6024) to `undefined`.
 */
const observeRule = (accountId: string, ruleId: string) =>
  zeroTrust
    .getDevicePosture({ accountId, ruleId })
    .pipe(
      Effect.catchTag("PostureRuleNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a posture rule by exact name (oldest-id-first for determinism when
 * names collide).
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listDevicePostures.items({ accountId }).pipe(
    Stream.filter((r) => r.name === name && r.id != null),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
        .at(0),
    ),
  );

const createRuleName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  rule: ObservedRule,
  accountId: string,
): DevicePostureRuleAttributes => ({
  postureRuleId: rule.id ?? "",
  accountId,
  name: rule.name ?? "",
  type: rule.type ?? "",
  description: denull(rule.description),
  schedule: denull(rule.schedule),
  expiration: denull(rule.expiration),
  match: normalizeMatch(rule.match),
  input: denull(rule.input),
});

const normalizeMatch = (
  match: ObservedRule["match"],
): { platform: string | undefined }[] | undefined =>
  match == null
    ? undefined
    : match.map((m) => ({ platform: denull(m.platform) }));

/**
 * Strip Cloudflare's `null` echoes to `undefined` so structural equality
 * (`JSON.stringify`) works.
 */
const denull = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

/** Structural deep-equality via canonical JSON. */
const sameJSON = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
