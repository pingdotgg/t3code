/**
 * ManagedPolicy - the administrator's machine-wide policy file, read once at startup. A file this
 * build cannot fully enforce stops the server instead of leaving it looking managed.
 *
 * @module ManagedPolicy
 */
import * as NodeModule from "node:module";

import { ManagedPolicyDocument, type ManagedPolicySummary } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ManagedPolicyFileError,
  managedPolicyPath,
  layerWindowsRegistry,
  readManagedPolicy,
  readManagedPolicyFile,
} from "@t3tools/shared/managedPolicyFile";

import { telemetryChannel } from "../config.ts";
import * as ManagedLimits from "./managedLimits.ts";
import * as ManagedProviders from "./managedProviders.ts";
import * as ManagedSettings from "./managedSettings.ts";

export class ManagedPolicy extends Context.Service<
  ManagedPolicy,
  {
    /** Where the policy is read from, whether or not a file exists there. */
    readonly path: string;
    readonly document: ManagedPolicyDocument | undefined;
    readonly settings: ManagedSettings.ManagedSettings;
    readonly providers: ManagedProviders.ManagedProviders;
    /** What clients are told; absent when no policy applies. */
    readonly summary: ManagedPolicySummary | undefined;
  }
>()("t3/policy/ManagedPolicy") {}

type LimitsSummary = NonNullable<ManagedPolicySummary["limits"]>;

const encodeDocumentJson = Schema.encodeEffect(Schema.fromJsonString(ManagedPolicyDocument));

/** What `t3 policy show` compares to tell whether a running server loaded the installed policy. */
export const loadedPolicy = Effect.fn("ManagedPolicy.loadedPolicy")(function* (
  policy: Pick<ManagedPolicy["Service"], "path" | "document">,
) {
  if (policy.document === undefined) return null;
  const json = yield* encodeDocumentJson(policy.document).pipe(Effect.orDie);
  const digest = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", new TextEncoder().encode(json))
    .pipe(Effect.orDie);
  return {
    source: policy.path,
    organization: policy.document.organization,
    fingerprint: Hex.encode(digest).slice(0, 12),
  };
});

/**
 * The organization whose policy switches `capability` off, or undefined when it is allowed.
 * Only an explicit `false` restricts.
 */
export function deniedBy(
  policy: Pick<ManagedPolicy["Service"], "document">,
  capability: "webhookTasks" | "telemetry",
): string | undefined {
  return policy.document?.limits?.[capability] === false ? policy.document.organization : undefined;
}

/** Build the service from a decoded document; fails when the document cannot be enforced. */
export const fromDocument = Effect.fn("ManagedPolicy.fromDocument")(function* (
  path: string,
  document: ManagedPolicyDocument | undefined,
) {
  if (document === undefined) {
    return ManagedPolicy.of({
      path,
      document: undefined,
      settings: ManagedSettings.unmanagedSettings,
      providers: ManagedProviders.unmanagedProviders,
      summary: undefined,
    });
  }
  const maxRuntimeMode = document.limits?.maxRuntimeMode;
  const settings = ManagedSettings.makeManagedSettings(document.settings ?? {}, maxRuntimeMode);
  if (settings._tag === "Invalid") {
    return yield* new ManagedPolicyFileError({ path, reason: settings.reason });
  }
  // A ceiling alone also shapes providers: their launch configuration becomes the administrator's.
  const providerLimits = document.limits?.providers;
  const providers =
    providerLimits === undefined && maxRuntimeMode === undefined
      ? undefined
      : ManagedProviders.makeManagedProviders(
          providerLimits ?? {},
          maxRuntimeMode,
          yield* HostProcess.Platform,
        );
  if (providers?._tag === "Invalid") {
    return yield* new ManagedPolicyFileError({ path, reason: providers.reason });
  }
  const lockedInstanceFields = providers?.providers.lockedInstanceFields ?? {};
  return ManagedPolicy.of({
    path,
    document,
    settings: settings.settings,
    providers: providers?.providers ?? ManagedProviders.unmanagedProviders,
    summary: {
      organization: document.organization,
      ...(document.supportUrl === undefined ? {} : { supportUrl: document.supportUrl }),
      lockedSettings: settings.settings.lockedPaths,
      ...(document.limits === undefined
        ? {}
        : { limits: summarizeLimits(document, lockedInstanceFields) }),
    },
  });
});

// Copies only what clients may see; other limits can carry values that stay on the server.
function summarizeLimits(
  document: ManagedPolicyDocument,
  lockedInstanceFields: Readonly<Record<string, ReadonlyArray<string>>>,
): LimitsSummary {
  const {
    maxRuntimeMode,
    clients,
    webhookTasks,
    telemetry,
    browserCookieImport,
    providers,
    updates,
  } = document.limits ?? {};
  const connect = ManagedLimits.allowsConnect({ document });
  return {
    ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
    ...(clients === undefined ? {} : { clients }),
    ...(connect ? {} : { connect: false }),
    ...(webhookTasks === undefined ? {} : { webhookTasks }),
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(browserCookieImport === undefined ? {} : { browserCookieImport }),
    ...(providers?.allowedDrivers === undefined && Object.keys(lockedInstanceFields).length === 0
      ? {}
      : {
          providers: {
            ...(providers?.allowedDrivers === undefined
              ? {}
              : { allowedDrivers: providers.allowedDrivers }),
            ...(Object.keys(lockedInstanceFields).length === 0 ? {} : { lockedInstanceFields }),
          },
        }),
    ...(updates === undefined
      ? {}
      : {
          updates: {
            mode: updates.mode,
            ...(updates.allowNightly === undefined ? {} : { allowNightly: updates.allowNightly }),
          },
        }),
  };
}

/** Read and validate the policy at `path`; a missing file means no policy. */
export const load = Effect.fn("ManagedPolicy.load")(function* (path: string) {
  return yield* fromDocument(path, yield* readManagedPolicyFile(path));
});

const make = Effect.gen(function* () {
  // Source builds may read a policy from elsewhere so it can be tried without root. Release
  // builds never do: any override a user can set is a way around the policy.
  const devPath =
    telemetryChannel === "dev"
      ? yield* Config.option(Config.String("T3CODE_DEV_MANAGED_POLICY_PATH")).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        )
      : Option.none<string>();
  const platform = yield* HostProcess.Platform;
  const policy = yield* Option.match(devPath, {
    onSome: load,
    onNone: () =>
      readManagedPolicy(platform).pipe(
        Effect.flatMap((found) =>
          fromDocument(found?.source ?? managedPolicyPath(platform), found?.document),
        ),
      ),
  });
  const path = policy.path;
  if (policy.summary !== undefined) {
    yield* Effect.logInfo("Managed policy applies.", {
      path,
      organization: policy.summary.organization,
      lockedSettings: policy.summary.lockedSettings,
    });
  }
  return policy;
});

// A single-executable server resolves packages on disk only through `require`.
const requireForFfi = NodeModule.createRequire(import.meta.url);

export const layer = Layer.effect(ManagedPolicy, make).pipe(
  Layer.provide(
    layerWindowsRegistry(async () => requireForFfi("ffi-rs") as typeof import("ffi-rs")),
  ),
);

/** A policy for tests; `undefined` means unmanaged. */
export const layerTest = (document?: ManagedPolicyDocument) =>
  Layer.effect(ManagedPolicy, fromDocument("/test/policy.json", document));
