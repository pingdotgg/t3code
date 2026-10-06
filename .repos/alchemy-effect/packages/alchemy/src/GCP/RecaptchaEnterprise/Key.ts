import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  findOwnedKey,
  keyNameOf,
  lastSegment,
  listKeys,
  sameText,
  stringList,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type TestingOptions = {
  /**
   * Score returned for every assessment of this key. Must be between 0
   * and 1 inclusive.
   */
  testingScore?: number;
  /**
   * Challenge outcome for CHECKBOX / INVISIBLE keys: `NOCAPTCHA` or
   * `UNSOLVABLE_CHALLENGE`.
   */
  testingChallenge?: string;
};

export type AppleDeveloperId = {
  /**
   * Input-only Apple DeviceCheck private key (`.p8` contents).
   */
  privateKey?: string;
  /**
   * Apple team id (10 characters).
   */
  teamId?: string;
  /**
   * Apple developer key id (10 characters).
   */
  keyId?: string;
};

export type IOSKeySettings = {
  /**
   * iOS bundle ids allowed to use the key.
   */
  allowedBundleIds?: string[];
  /**
   * When true, `allowedBundleIds` are not enforced.
   */
  allowAllBundleIds?: boolean;
  /**
   * Apple Developer account used for App Attest / DeviceCheck.
   */
  appleDeveloperId?: AppleDeveloperId;
};

export type AndroidKeySettings = {
  /**
   * Android package names allowed to use the key.
   */
  allowedPackageNames?: string[];
  /**
   * When true, the key may be used by apps distributed outside Play.
   */
  supportNonGoogleAppStoreDistribution?: boolean;
  /**
   * When true, `allowedPackageNames` are not enforced.
   */
  allowAllPackageNames?: boolean;
};

export type WebActionSettings = {
  /**
   * Challenge is triggered when the score is below this threshold (0–1).
   */
  scoreThreshold?: number;
};

export type WebChallengeSettings = {
  /**
   * Default action threshold.
   */
  defaultSettings?: WebActionSettings;
  /**
   * Per-action score thresholds. Action names match `data-action`.
   */
  actionSettings?: Record<string, WebActionSettings | undefined>;
};

export type WebKeySettings = {
  /**
   * Hostnames allowed to use the key (no path, port, or fragment).
   */
  allowedDomains?: string[];
  /**
   * How the key is integrated with the site. Immutable — changing it
   * replaces the key.
   * @default "SCORE"
   */
  integrationType?: string;
  /**
   * Challenge frequency / difficulty for CHECKBOX, INVISIBLE, and
   * POLICY_BASED_CHALLENGE keys.
   */
  challengeSecurityPreference?: string;
  /**
   * When true, `allowedDomains` are not enforced.
   * @default true
   */
  allowAllDomains?: boolean;
  /**
   * Allow AMP pages. SCORE keys only. Immutable — changing it replaces
   * the key.
   */
  allowAmpTraffic?: boolean;
  /**
   * POLICY_BASED_CHALLENGE thresholds.
   */
  challengeSettings?: WebChallengeSettings;
};

export type WafSettings = {
  /**
   * WAF service that uses this key (`CA`, `FASTLY`, `CLOUDFLARE`,
   * `AKAMAI`). Immutable — changing it replaces the key.
   */
  wafService?: string;
  /**
   * WAF feature (`CHALLENGE_PAGE`, `SESSION_TOKEN`, `ACTION_TOKEN`,
   * `EXPRESS`). Immutable — changing it replaces the key.
   */
  wafFeature?: string;
};

export type KeyProps = {
  /**
   * Server-assigned key id (the `{key}` segment of
   * `projects/{project}/keys/{key}`). This is also the site key used by
   * client libraries. Immutable — changing it replaces the key.
   */
  keyId?: string;
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User-acceptance testing overrides (fixed score / challenge).
   */
  testingOptions?: TestingOptions;
  /**
   * Website key settings. Default when no Android, iOS, or Express
   * settings are set: SCORE integration with `allowAllDomains`.
   */
  webSettings?: WebKeySettings;
  /**
   * Android app key settings. Mutually exclusive with web, iOS, and
   * Express. Changing the platform kind replaces the key.
   */
  androidSettings?: AndroidKeySettings;
  /**
   * iOS app key settings. Mutually exclusive with web, Android, and
   * Express. Changing the platform kind replaces the key.
   */
  iosSettings?: IOSKeySettings;
  /**
   * reCAPTCHA Express settings. Mutually exclusive with web, Android,
   * and iOS. Changing the platform kind replaces the key.
   */
  expressSettings?: Record<string, never> | {};
  /**
   * Web Application Firewall settings. Immutable — changing them
   * replaces the key.
   */
  wafSettings?: WafSettings;
};

export type Key = Resource<
  "GCP.RecaptchaEnterprise.Key",
  KeyProps,
  {
    /** Full resource name `projects/{project}/keys/{key}`. */
    name: string;
    /** Server-assigned key id (site key). */
    keyId: string;
    /** Project id used when the key was reconciled. */
    project: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Testing overrides, if set. */
    testingOptions: TestingOptions | undefined;
    /** Website settings, if this is a web key. */
    webSettings: WebKeySettings | undefined;
    /** Android settings, if this is an Android key. */
    androidSettings: AndroidKeySettings | undefined;
    /** iOS settings, if this is an iOS key. */
    iosSettings: IOSKeySettings | undefined;
    /** Whether Express settings are configured. */
    expressSettings: Record<string, never> | {} | undefined;
    /** WAF settings, if set. */
    wafSettings: WafSettings | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A reCAPTCHA Enterprise key.
 *
 * Key ids are assigned by Google and are the site key used by client
 * libraries. Alchemy stamps ownership into labels so `list` / nuke can
 * find them. Display name, labels, and allowed domains update in place.
 * Changing `keyId`, platform kind (web / Android / iOS / Express),
 * `webSettings.integrationType`, AMP traffic, WAF settings, or testing
 * options replaces the key.
 *
 * ### Creating a Key
 * **Example:** Generated SCORE web key
 * ```typescript
 * const key = yield* GCP.RecaptchaEnterprise.Key("Signup", {});
 * ```
 *
 * **Example:** Named SCORE key with labels and a test score
 * ```typescript
 * const key = yield* GCP.RecaptchaEnterprise.Key("Signup", {
 *   displayName: "signup form",
 *   labels: { env: "prod" },
 *   testingOptions: { testingScore: 0.9 },
 *   webSettings: {
 *     integrationType: "SCORE",
 *     allowAllDomains: true,
 *   },
 * });
 * ```
 *
 * ### Assessments
 * **Example:** Create an assessment for the key
 * ```typescript
 * const createAssessment = yield* GCP.RecaptchaEnterprise.CreateAssessment(
 *   key,
 * );
 * const assessment = yield* createAssessment({
 *   body: {
 *     event: { token: recaptchaToken, expectedAction: "login" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category RecaptchaEnterprise
 */
export const Key = Resource<Key>("GCP.RecaptchaEnterprise.Key");

export class KeyNotResolved extends Data.TaggedError(
  "GCP.RecaptchaEnterprise.KeyNotResolved",
)<{
  name: string;
}> {}

type KeyKind = "web" | "android" | "ios" | "express";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const kindOf = (
  props: {
    webSettings?: unknown;
    androidSettings?: unknown;
    iosSettings?: unknown;
    expressSettings?: unknown;
  },
  fallback?: KeyKind,
): KeyKind => {
  if (props.androidSettings !== undefined) return "android";
  if (props.iosSettings !== undefined) return "ios";
  if (props.expressSettings !== undefined) return "express";
  if (props.webSettings !== undefined) return "web";
  return fallback ?? "web";
};

const toTestingOptions = (
  options:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1TestingOptions
    | TestingOptions
    | undefined,
): TestingOptions | undefined => {
  if (options === undefined) return undefined;
  if (
    options.testingScore === undefined &&
    options.testingChallenge === undefined
  ) {
    return undefined;
  }
  return {
    testingScore: options.testingScore,
    testingChallenge: options.testingChallenge,
  };
};

const toWebSettings = (
  settings:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1WebKeySettings
    | WebKeySettings
    | undefined,
): WebKeySettings | undefined => {
  if (settings === undefined) return undefined;
  return {
    allowedDomains: stringList(settings.allowedDomains),
    integrationType: settings.integrationType,
    challengeSecurityPreference: settings.challengeSecurityPreference,
    allowAllDomains: settings.allowAllDomains,
    allowAmpTraffic: settings.allowAmpTraffic,
    challengeSettings: settings.challengeSettings,
  };
};

const toAndroidSettings = (
  settings:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1AndroidKeySettings
    | AndroidKeySettings
    | undefined,
): AndroidKeySettings | undefined => {
  if (settings === undefined) return undefined;
  return {
    allowedPackageNames: stringList(settings.allowedPackageNames),
    supportNonGoogleAppStoreDistribution:
      settings.supportNonGoogleAppStoreDistribution,
    allowAllPackageNames: settings.allowAllPackageNames,
  };
};

const toIosSettings = (
  settings:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1IOSKeySettings
    | IOSKeySettings
    | undefined,
): IOSKeySettings | undefined => {
  if (settings === undefined) return undefined;
  const apple = settings.appleDeveloperId;
  return {
    allowedBundleIds: stringList(settings.allowedBundleIds),
    allowAllBundleIds: settings.allowAllBundleIds,
    appleDeveloperId:
      apple === undefined
        ? undefined
        : {
            teamId: apple.teamId,
            keyId: apple.keyId,
          },
  };
};

const toWafSettings = (
  settings:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1WafSettings
    | WafSettings
    | undefined,
): WafSettings | undefined => {
  if (settings === undefined) return undefined;
  if (settings.wafService === undefined && settings.wafFeature === undefined) {
    return undefined;
  }
  return {
    wafService: settings.wafService,
    wafFeature: settings.wafFeature,
  };
};

const toExpressSettings = (
  settings:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1FirewallActionBlockAction
    | Record<string, never>
    | {}
    | undefined,
): Record<string, never> | {} | undefined =>
  settings === undefined ? undefined : {};

const desiredWebSettings = (news: KeyProps): WebKeySettings => ({
  allowAllDomains: true,
  integrationType: "SCORE",
  ...news.webSettings,
});

const platformBody = (news: KeyProps, kind: KeyKind) => {
  if (kind === "android") {
    return { androidSettings: news.androidSettings ?? {} };
  }
  if (kind === "ios") {
    return { iosSettings: news.iosSettings ?? {} };
  }
  if (kind === "express") {
    return { expressSettings: {} };
  }
  return { webSettings: desiredWebSettings(news) };
};

const toKeyBody = (
  news: KeyProps,
  displayName: string,
  labels: Record<string, string>,
  kind: KeyKind,
): recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1Key => ({
  displayName,
  labels,
  testingOptions: news.testingOptions,
  wafSettings: news.wafSettings,
  ...platformBody(news, kind),
});

const unspecified = (value: string | undefined) =>
  value === undefined || value.length === 0 || value.endsWith("_UNSPECIFIED")
    ? ""
    : value;

const testingFingerprint = (options: TestingOptions | undefined) =>
  JSON.stringify({
    testingScore: options?.testingScore ?? null,
    testingChallenge: unspecified(options?.testingChallenge),
  });

const webFingerprint = (settings: WebKeySettings | undefined) =>
  JSON.stringify({
    allowedDomains: settings?.allowedDomains
      ? [...settings.allowedDomains].slice().sort()
      : [],
    integrationType: unspecified(settings?.integrationType),
    challengeSecurityPreference: unspecified(
      settings?.challengeSecurityPreference,
    ),
    allowAllDomains: settings?.allowAllDomains === true,
    allowAmpTraffic: settings?.allowAmpTraffic === true,
    challengeSettings: settings?.challengeSettings ?? null,
  });

const androidFingerprint = (settings: AndroidKeySettings | undefined) =>
  JSON.stringify({
    allowedPackageNames: settings?.allowedPackageNames
      ? [...settings.allowedPackageNames].slice().sort()
      : [],
    supportNonGoogleAppStoreDistribution:
      settings?.supportNonGoogleAppStoreDistribution === true,
    allowAllPackageNames: settings?.allowAllPackageNames === true,
  });

const iosFingerprint = (settings: IOSKeySettings | undefined) =>
  JSON.stringify({
    allowedBundleIds: settings?.allowedBundleIds
      ? [...settings.allowedBundleIds].slice().sort()
      : [],
    allowAllBundleIds: settings?.allowAllBundleIds === true,
    teamId: settings?.appleDeveloperId?.teamId ?? "",
    keyId: settings?.appleDeveloperId?.keyId ?? "",
  });

const wafFingerprint = (settings: WafSettings | undefined) =>
  JSON.stringify({
    wafService: settings?.wafService ?? "",
    wafFeature: settings?.wafFeature ?? "",
  });

const toAttrs = (
  key: recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1Key,
  project: string,
) => {
  const name = key.name ?? "";
  return {
    name,
    keyId: lastSegment(name),
    project,
    displayName: key.displayName,
    labels: userLabels(key.labels),
    testingOptions: toTestingOptions(key.testingOptions),
    webSettings: toWebSettings(key.webSettings),
    androidSettings: toAndroidSettings(key.androidSettings),
    iosSettings: toIosSettings(key.iosSettings),
    expressSettings: toExpressSettings(key.expressSettings),
    wafSettings: toWafSettings(key.wafSettings),
    createTime: key.createTime,
  };
};

export const KeyProvider = () =>
  Provider.succeed(Key, {
    stables: ["name", "keyId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.keyId ?? output?.keyId;
      if (
        news.keyId !== undefined &&
        previousId !== undefined &&
        news.keyId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousKind = kindOf(olds ?? output ?? {});
      const nextKind = kindOf(news, previousKind);
      if (previousKind !== nextKind) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType =
        olds?.webSettings?.integrationType ??
        output?.webSettings?.integrationType;
      const nextType = news.webSettings?.integrationType;
      if (
        previousType !== undefined &&
        nextType !== undefined &&
        previousType !== nextType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousAmp =
        olds?.webSettings?.allowAmpTraffic ??
        output?.webSettings?.allowAmpTraffic;
      if (
        news.webSettings?.allowAmpTraffic !== undefined &&
        previousAmp !== undefined &&
        news.webSettings.allowAmpTraffic !== previousAmp
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        (news.wafSettings !== undefined ||
          olds?.wafSettings !== undefined ||
          output?.wafSettings !== undefined) &&
        wafFingerprint(news.wafSettings) !==
          wafFingerprint(olds?.wafSettings ?? output?.wafSettings)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousTesting = olds?.testingOptions ?? output?.testingOptions;
      if (
        (olds !== undefined || output !== undefined) &&
        testingFingerprint(toTestingOptions(news.testingOptions)) !==
          testingFingerprint(toTestingOptions(previousTesting))
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name =
        output?.name ??
        (olds?.keyId !== undefined
          ? keyNameOf(env.project, olds.keyId)
          : output?.keyId !== undefined
            ? keyNameOf(env.project, output.keyId)
            : "");
      const existing = yield* findOwnedKey(env.project, id, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const keys = yield* listKeys(env.project);
        return keys
          .filter((key) =>
            Object.keys(key.labels ?? {}).some((label) =>
              label.startsWith("alchemy-"),
            ),
          )
          .map((key) => toAttrs(key, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const lookupName =
        output?.name ??
        (news.keyId !== undefined
          ? keyNameOf(env.project, news.keyId)
          : output?.keyId !== undefined
            ? keyNameOf(env.project, output.keyId)
            : "");

      let current = yield* findOwnedKey(env.project, id, lookupName);
      const kind = kindOf(news, kindOf(current ?? {}, "web"));
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        current?.displayName ?? output?.displayName,
      );
      const desired = toKeyBody(news, displayName, desiredLabels, kind);

      if (current === undefined) {
        const created = yield* recaptchaenterprise
          .createProjectsKeys({
            parent: `projects/${env.project}`,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedKey(env.project, id, lookupName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new KeyNotResolved({
          name: lookupName.length > 0 ? lookupName : displayName,
        });
      }

      const name = current.name ?? lookupName;
      const labelsChanged = (() => {
        const { upsert, removed } = diffLabels(
          tagRecord(current.labels),
          desiredLabels,
        );
        return upsert.length > 0 || removed.length > 0;
      })();
      const displayChanged = !sameText(current.displayName, displayName);
      const webChanged =
        kind === "web" &&
        webFingerprint(toWebSettings(current.webSettings)) !==
          webFingerprint(desiredWebSettings(news));
      const androidChanged =
        kind === "android" &&
        androidFingerprint(toAndroidSettings(current.androidSettings)) !==
          androidFingerprint(toAndroidSettings(news.androidSettings ?? {}));
      const iosChanged =
        kind === "ios" &&
        iosFingerprint(toIosSettings(current.iosSettings)) !==
          iosFingerprint(toIosSettings(news.iosSettings ?? {}));
      const expressChanged =
        kind === "express" && current.expressSettings === undefined;
      const wafChanged =
        wafFingerprint(toWafSettings(current.wafSettings)) !==
        wafFingerprint(toWafSettings(news.wafSettings));

      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        labelsChanged ? "labels" : undefined,
        webChanged ? "webSettings" : undefined,
        androidChanged ? "androidSettings" : undefined,
        iosChanged ? "iosSettings" : undefined,
        expressChanged ? "expressSettings" : undefined,
        wafChanged ? "wafSettings" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* recaptchaenterprise.patchProjectsKeys({
          name,
          updateMask,
          body: { ...desired, name },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* recaptchaenterprise
        .deleteProjectsKeys({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
