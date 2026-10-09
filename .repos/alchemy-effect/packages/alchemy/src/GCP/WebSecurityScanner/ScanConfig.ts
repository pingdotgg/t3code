import * as websecurityscanner from "@distilled.cloud/gcp/websecurityscanner_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  getScanConfig,
  jsonEqual,
  lastSegment,
  sameText,
  scanConfigNameOf,
  sortedStrings,
  stringList,
  toUserDisplayName,
  unspecified,
  updateMaskOf,
} from "./internal.ts";

export type ScanConfigSchedule = {
  /**
   * RFC3339 time of the next run. The server refreshes this after each
   * run. Omit to start the first run immediately when a schedule is set.
   */
  scheduleTime?: string;
  /**
   * Days between scheduled executions. Required when `schedule` is set.
   */
  intervalDurationDays: number;
};

export type ScanConfigGoogleAccount = {
  /**
   * Google account username used during the scan.
   */
  username: string;
  /**
   * Input-only Google account password. Stored encrypted by GCP and
   * never returned.
   */
  password?: string;
};

export type ScanConfigCustomAccount = {
  /**
   * Custom account username.
   */
  username: string;
  /**
   * Input-only custom account password. Stored encrypted by GCP and
   * never returned.
   */
  password?: string;
  /**
   * Login form URL of the target site.
   */
  loginUrl: string;
};

export type ScanConfigIapCredential = {
  /**
   * OAuth2 client id of the IAP-protected resource.
   */
  targetAudienceClientId: string;
};

export type ScanConfigAuthentication = {
  /**
   * Authenticate with a Google account.
   */
  googleAccount?: ScanConfigGoogleAccount;
  /**
   * Authenticate with a custom account.
   */
  customAccount?: ScanConfigCustomAccount;
  /**
   * Authenticate with Identity-Aware Proxy.
   */
  iapCredential?: ScanConfigIapCredential;
};

export type ScanConfigLatestRun = {
  /** Scan run resource name. */
  name?: string;
  /** Execution state (`QUEUED`, `SCANNING`, `FINISHED`). */
  executionState?: string;
  /** Result state after finish (`SUCCESS`, `ERROR`, `KILLED`). */
  resultState?: string;
  /** RFC3339 start time. */
  startTime?: string;
  /** RFC3339 end time. */
  endTime?: string;
  /** Completion percent 0–100. */
  progressPercent?: number;
  /** URLs crawled so far. */
  urlsCrawledCount?: string;
  /** URLs tested so far. */
  urlsTestedCount?: string;
  /** Whether any vulnerabilities were found. */
  hasVulnerabilities?: boolean;
};

export type ScanConfigProps = {
  /**
   * Server-assigned scan config id (the `{scanConfigId}` segment of
   * `projects/{project}/scanConfigs/{scanConfigId}`). Immutable —
   * changing it replaces the config.
   */
  scanConfigId?: string;
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Starting URLs the scanner crawls from. Each URL must belong to this
   * project (App Engine, a reserved Compute IP, Cloud Run, or Cloud
   * Functions).
   */
  startingUrls: string[];
  /**
   * Maximum QPS while scanning. Valid range is 5–20. Unspecified or 0
   * uses the API default of 15.
   */
  maxQps?: number;
  /**
   * User agent used while scanning (`CHROME_LINUX`, `CHROME_ANDROID`,
   * `SAFARI_IPHONE`).
   */
  userAgent?: string;
  /**
   * URL patterns excluded from the crawl.
   */
  blacklistPatterns?: string[];
  /**
   * Recurring scan schedule. Omit to keep the config idle until a scan
   * is started explicitly.
   */
  schedule?: ScanConfigSchedule;
  /**
   * Credentials used while scanning. Passwords are input-only.
   */
  authentication?: ScanConfigAuthentication;
  /**
   * Platforms to scan (`APP_ENGINE`, `COMPUTE`, `CLOUD_RUN`,
   * `CLOUD_FUNCTIONS`). Empty uses `APP_ENGINE`.
   */
  targetPlatforms?: string[];
  /**
   * Export scan results to Security Command Center (`ENABLED` or
   * `DISABLED`). Default `ENABLED`.
   */
  exportToSecurityCommandCenter?: string;
  /**
   * Scan risk level (`NORMAL` or `LOW`). Default `NORMAL`.
   */
  riskLevel?: string;
  /**
   * When true, the scanner uses static IP addresses.
   */
  staticIpScan?: boolean;
  /**
   * When true, keep scanning even if most responses are HTTP errors.
   */
  ignoreHttpStatusErrors?: boolean;
};

export type ScanConfig = Resource<
  "GCP.WebSecurityScanner.ScanConfig",
  ScanConfigProps,
  {
    /** Full resource name `projects/{project}/scanConfigs/{scanConfigId}`. */
    name: string;
    /** Server-assigned scan config id. */
    scanConfigId: string;
    /** Project id used when the config was reconciled. */
    project: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Starting URLs. */
    startingUrls: string[];
    /** Maximum QPS. */
    maxQps: number | undefined;
    /** User agent. */
    userAgent: string | undefined;
    /** Excluded URL patterns. */
    blacklistPatterns: string[];
    /** Recurring schedule, if set. */
    schedule: ScanConfigSchedule | undefined;
    /** Authentication with passwords omitted. */
    authentication: ScanConfigAuthentication | undefined;
    /** Target platforms. */
    targetPlatforms: string[];
    /** Security Command Center export setting. */
    exportToSecurityCommandCenter: string | undefined;
    /** Risk level. */
    riskLevel: string | undefined;
    /** Whether static IP scanning is enabled. */
    staticIpScan: boolean | undefined;
    /** Whether HTTP error codes are ignored. */
    ignoreHttpStatusErrors: boolean | undefined;
    /** Whether Web Security Scanner manages this config. */
    managedScan: boolean | undefined;
    /** Most recent scan run, if any. */
    latestRun: ScanConfigLatestRun | undefined;
  },
  never,
  Providers
>;

/**
 * A Web Security Scanner scan configuration.
 *
 * Scan config ids are assigned by Google and scan configs have no labels
 * field, so Alchemy tracks a config only through the name recorded in
 * state; a config read without prior state is reported as unowned. Display
 * name, starting
 * URLs, QPS, user agent, blacklist, schedule, authentication, platforms,
 * export, risk, and scan flags update in place. Changing `scanConfigId`
 * replaces the config.
 *
 * Starting URLs must belong to the project — a reserved Compute IP,
 * App Engine (`https://PROJECT.appspot.com`), Cloud Run, or Cloud
 * Functions.
 *
 * ### Creating a ScanConfig
 * **Example:** Scan a reserved Compute IP
 * ```typescript
 * const ip = yield* GCP.Compute.Address("Target", {
 *   region: "us-central1",
 * });
 * const scan = yield* GCP.WebSecurityScanner.ScanConfig("Site", {
 *   displayName: "public site",
 *   startingUrls: [Output.interpolate`http://${ip.address}`],
 *   targetPlatforms: ["COMPUTE"],
 *   exportToSecurityCommandCenter: "DISABLED",
 * });
 * ```
 *
 * **Example:** Low-risk scan with excluded paths
 * ```typescript
 * const scan = yield* GCP.WebSecurityScanner.ScanConfig("Site", {
 *   displayName: "public site",
 *   startingUrls: ["https://my-app-uc.a.run.app/"],
 *   targetPlatforms: ["CLOUD_RUN"],
 *   maxQps: 5,
 *   riskLevel: "LOW",
 *   userAgent: "CHROME_LINUX",
 *   blacklistPatterns: ["https://my-app-uc.a.run.app/logout"],
 *   ignoreHttpStatusErrors: true,
 *   exportToSecurityCommandCenter: "DISABLED",
 * });
 * ```
 *
 * ### Updating a ScanConfig
 * **Example:** Raise QPS and change the display name
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const scan = yield* GCP.WebSecurityScanner.ScanConfig("Site", {
 *   displayName: "public site v2",
 *   startingUrls: [Output.interpolate`http://${ip.address}`],
 *   targetPlatforms: ["COMPUTE"],
 *   maxQps: 10,
 *   exportToSecurityCommandCenter: "DISABLED",
 * });
 * ```
 *
 * @resource
 * @category WebSecurityScanner
 */
export const ScanConfig = Resource<ScanConfig>(
  "GCP.WebSecurityScanner.ScanConfig",
);

export class ScanConfigNotResolved extends Data.TaggedError(
  "GCP.WebSecurityScanner.ScanConfigNotResolved",
)<{
  name: string;
}> {}

const toSchedule = (
  schedule: websecurityscanner.Schedule | ScanConfigSchedule | undefined,
): ScanConfigSchedule | undefined => {
  if (schedule === undefined) return undefined;
  if (schedule.intervalDurationDays === undefined) return undefined;
  return {
    intervalDurationDays: schedule.intervalDurationDays,
    scheduleTime: schedule.scheduleTime,
  };
};

const toAuthentication = (
  authentication: websecurityscanner.Authentication | undefined,
): ScanConfigAuthentication | undefined => {
  if (authentication === undefined) return undefined;
  const google = authentication.googleAccount;
  const custom = authentication.customAccount;
  const iapClientId =
    authentication.iapCredential?.iapTestServiceAccountInfo
      ?.targetAudienceClientId;
  const next: ScanConfigAuthentication = {};
  if (google?.username !== undefined) {
    next.googleAccount = { username: google.username };
  }
  if (custom?.username !== undefined || custom?.loginUrl !== undefined) {
    next.customAccount = {
      username: custom?.username ?? "",
      loginUrl: custom?.loginUrl ?? "",
    };
  }
  if (iapClientId !== undefined) {
    next.iapCredential = { targetAudienceClientId: iapClientId };
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const authenticationFingerprint = (
  authentication: ScanConfigAuthentication | undefined,
) =>
  JSON.stringify({
    googleUsername: authentication?.googleAccount?.username ?? "",
    customUsername: authentication?.customAccount?.username ?? "",
    customLoginUrl: authentication?.customAccount?.loginUrl ?? "",
    iapClientId: authentication?.iapCredential?.targetAudienceClientId ?? "",
  });

const toLatestRun = (
  run: websecurityscanner.ScanRun | undefined,
): ScanConfigLatestRun | undefined => {
  if (run === undefined) return undefined;
  return {
    name: run.name,
    executionState: run.executionState,
    resultState: run.resultState,
    startTime: run.startTime,
    endTime: run.endTime,
    progressPercent: run.progressPercent,
    urlsCrawledCount: run.urlsCrawledCount,
    urlsTestedCount: run.urlsTestedCount,
    hasVulnerabilities: run.hasVulnerabilities,
  };
};

const toAttrs = (config: websecurityscanner.ScanConfig, project: string) => {
  const name = config.name ?? "";
  return {
    name,
    scanConfigId: lastSegment(name),
    project,
    displayName: config.displayName,
    startingUrls: stringList(config.startingUrls),
    maxQps: config.maxQps,
    userAgent: unspecified(config.userAgent) || undefined,
    blacklistPatterns: stringList(config.blacklistPatterns),
    schedule: toSchedule(config.schedule),
    authentication: toAuthentication(config.authentication),
    targetPlatforms: stringList(config.targetPlatforms).filter(
      (platform) => unspecified(platform).length > 0,
    ),
    exportToSecurityCommandCenter:
      unspecified(config.exportToSecurityCommandCenter) || undefined,
    riskLevel: unspecified(config.riskLevel) || undefined,
    staticIpScan: config.staticIpScan,
    ignoreHttpStatusErrors: config.ignoreHttpStatusErrors,
    managedScan: config.managedScan,
    latestRun: toLatestRun(config.latestRun),
  };
};

const toAuthBody = (
  authentication: ScanConfigAuthentication | undefined,
): websecurityscanner.Authentication | undefined => {
  if (authentication === undefined) return undefined;
  const body: websecurityscanner.Authentication = {};
  if (authentication.googleAccount !== undefined) {
    body.googleAccount = {
      username: authentication.googleAccount.username,
      password: authentication.googleAccount.password,
    };
  }
  if (authentication.customAccount !== undefined) {
    body.customAccount = {
      username: authentication.customAccount.username,
      password: authentication.customAccount.password,
      loginUrl: authentication.customAccount.loginUrl,
    };
  }
  if (authentication.iapCredential !== undefined) {
    body.iapCredential = {
      iapTestServiceAccountInfo: {
        targetAudienceClientId:
          authentication.iapCredential.targetAudienceClientId,
      },
    };
  }
  return Object.keys(body).length > 0 ? body : undefined;
};

const toBody = (
  news: ScanConfigProps,
  displayName: string,
): websecurityscanner.ScanConfig => {
  const body: websecurityscanner.ScanConfig = {
    displayName,
    startingUrls: news.startingUrls,
  };
  if (news.maxQps !== undefined) body.maxQps = news.maxQps;
  if (news.userAgent !== undefined) body.userAgent = news.userAgent;
  if (news.blacklistPatterns !== undefined) {
    body.blacklistPatterns = news.blacklistPatterns;
  }
  if (news.schedule !== undefined) {
    body.schedule = {
      intervalDurationDays: news.schedule.intervalDurationDays,
      scheduleTime: news.schedule.scheduleTime,
    };
  }
  const authentication = toAuthBody(news.authentication);
  if (authentication !== undefined) body.authentication = authentication;
  if (news.targetPlatforms !== undefined) {
    body.targetPlatforms = news.targetPlatforms;
  }
  if (news.exportToSecurityCommandCenter !== undefined) {
    body.exportToSecurityCommandCenter = news.exportToSecurityCommandCenter;
  }
  if (news.riskLevel !== undefined) body.riskLevel = news.riskLevel;
  if (news.staticIpScan !== undefined) body.staticIpScan = news.staticIpScan;
  if (news.ignoreHttpStatusErrors !== undefined) {
    body.ignoreHttpStatusErrors = news.ignoreHttpStatusErrors;
  }
  return body;
};

const lookupNameOf = (
  project: string,
  news: { scanConfigId?: string },
  output: { name?: string; scanConfigId?: string } | undefined,
) =>
  output?.name ??
  (news.scanConfigId !== undefined
    ? scanConfigNameOf(project, news.scanConfigId)
    : output?.scanConfigId !== undefined
      ? scanConfigNameOf(project, output.scanConfigId)
      : "");

export const ScanConfigProvider = () =>
  Provider.succeed(ScanConfig, {
    stables: ["name", "scanConfigId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.scanConfigId ?? output?.scanConfigId;
      if (
        news.scanConfigId !== undefined &&
        previousId !== undefined &&
        news.scanConfigId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getScanConfig(
        lookupNameOf(env.project, olds ?? {}, output),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const lookupName = lookupNameOf(env.project, news, output);

      let current = yield* getScanConfig(lookupName);
      const displayName = yield* toUserDisplayName(
        id,
        news.displayName,
        current?.displayName ?? output?.displayName,
      );
      const desired = toBody(news, displayName);

      if (current === undefined) {
        const created = yield* websecurityscanner
          .createProjectsScanConfigs({
            parent: `projects/${env.project}`,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => getScanConfig(lookupName)),
            // A just-reserved static IP can take up to a minute to be visible.
            Effect.retry({
              while: (e) => e._tag === "StartingUrlIpNotReserved",
              schedule: Schedule.spaced("3 seconds"),
              times: 20,
            }),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ScanConfigNotResolved({
          name: lookupName.length > 0 ? lookupName : displayName,
        });
      }

      const name = current.name ?? lookupName;
      const displayChanged = !sameText(current.displayName, displayName);
      const startingChanged = !jsonEqual(
        stringList(current.startingUrls),
        news.startingUrls,
      );
      const maxQpsChanged =
        news.maxQps !== undefined && (current.maxQps ?? 15) !== news.maxQps;
      const userAgentChanged =
        news.userAgent !== undefined &&
        unspecified(current.userAgent) !== unspecified(news.userAgent);
      const blacklistChanged =
        news.blacklistPatterns !== undefined &&
        !jsonEqual(
          stringList(current.blacklistPatterns),
          news.blacklistPatterns,
        );
      const scheduleChanged =
        news.schedule !== undefined &&
        (current.schedule?.intervalDurationDays ?? 0) !==
          news.schedule.intervalDurationDays;
      const authenticationChanged =
        news.authentication !== undefined &&
        authenticationFingerprint(toAuthentication(current.authentication)) !==
          authenticationFingerprint(news.authentication);
      const platformsChanged =
        news.targetPlatforms !== undefined &&
        !jsonEqual(
          sortedStrings(
            stringList(current.targetPlatforms).filter(
              (platform) => unspecified(platform).length > 0,
            ),
          ),
          sortedStrings(news.targetPlatforms),
        );
      const exportChanged =
        news.exportToSecurityCommandCenter !== undefined &&
        unspecified(current.exportToSecurityCommandCenter) !==
          unspecified(news.exportToSecurityCommandCenter);
      const riskChanged =
        news.riskLevel !== undefined &&
        unspecified(current.riskLevel) !== unspecified(news.riskLevel);
      const staticIpChanged =
        news.staticIpScan !== undefined &&
        (current.staticIpScan === true) !== news.staticIpScan;
      const ignoreHttpChanged =
        news.ignoreHttpStatusErrors !== undefined &&
        (current.ignoreHttpStatusErrors === true) !==
          news.ignoreHttpStatusErrors;

      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        startingChanged ? "startingUrls" : undefined,
        maxQpsChanged ? "maxQps" : undefined,
        userAgentChanged ? "userAgent" : undefined,
        blacklistChanged ? "blacklistPatterns" : undefined,
        scheduleChanged ? "schedule" : undefined,
        authenticationChanged ? "authentication" : undefined,
        platformsChanged ? "targetPlatforms" : undefined,
        exportChanged ? "exportToSecurityCommandCenter" : undefined,
        riskChanged ? "riskLevel" : undefined,
        staticIpChanged ? "staticIpScan" : undefined,
        ignoreHttpChanged ? "ignoreHttpStatusErrors" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* websecurityscanner.patchProjectsScanConfigs({
          name,
          updateMask,
          body: { ...desired, name },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* websecurityscanner
        .deleteProjectsScanConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
