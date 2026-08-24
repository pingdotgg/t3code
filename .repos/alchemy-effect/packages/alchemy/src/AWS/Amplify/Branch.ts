import * as amplify from "@distilled.cloud/aws/amplify";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * Deployment stage of an Amplify branch.
 */
export type BranchStage =
  | "PRODUCTION"
  | "BETA"
  | "DEVELOPMENT"
  | "EXPERIMENTAL"
  | "PULL_REQUEST";

export interface BranchProps {
  /**
   * ID of the Amplify {@link App} the branch belongs to. Changing it replaces
   * the branch.
   */
  appId: string;
  /**
   * Name of the branch (e.g. `main`). For an app without a connected
   * repository this is just a label for manual deployments. If omitted, a
   * unique name is generated. Changing it replaces the branch.
   */
  branchName?: string;
  /**
   * Description of the branch.
   */
  description?: string;
  /**
   * Display name shown in the Amplify console.
   */
  displayName?: string;
  /**
   * Deployment stage of the branch.
   */
  stage?: BranchStage;
  /**
   * Framework label for the branch (e.g. `React`, `Next.js`).
   */
  framework?: string;
  /**
   * Whether pushing to the (repo-connected) branch automatically triggers a
   * build. Branches of repo-less apps should set this to `false`.
   */
  enableAutoBuild?: boolean;
  /**
   * Whether to enable deployment skew protection for the branch.
   */
  enableSkewProtection?: boolean;
  /**
   * Whether to enable performance mode (longer edge cache intervals).
   */
  enablePerformanceMode?: boolean;
  /**
   * Environment variables available to builds of this branch.
   */
  environmentVariables?: Record<string, string>;
  /**
   * Whether to require basic auth to view the branch's site.
   */
  enableBasicAuth?: boolean;
  /**
   * Basic auth credentials for the branch, as base64 of `user:password`.
   */
  basicAuthCredentials?: Redacted.Redacted<string>;
  /**
   * Build specification (amplify.yml contents) overriding the app's.
   */
  buildSpec?: string;
  /**
   * Content Time-To-Live for the branch's website (wire unit: seconds).
   */
  ttl?: Duration.Input;
  /**
   * Whether pull requests to the (repo-connected) branch create previews.
   */
  enablePullRequestPreview?: boolean;
  /**
   * Amplify environment name used for pull request previews.
   */
  pullRequestEnvironmentName?: string;
  /**
   * User-defined tags to apply to the branch.
   */
  tags?: Record<string, string>;
}

export interface Branch extends Resource<
  "AWS.Amplify.Branch",
  BranchProps,
  {
    appId: string;
    branchName: string;
    branchArn: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A branch of an AWS Amplify Hosting app.
 *
 * For apps without a connected Git repository, a branch is the target of the
 * manual-deploy pipeline: stage a zip with `CreateDeployment`, upload it to
 * the pre-signed URL, and release it with `StartDeployment`.
 *
 * @resource
 * @section Creating Branches
 * @example Manual-Deploy Branch
 * ```typescript
 * const app = yield* App("MySite", { platform: "WEB" });
 * const branch = yield* Branch("Main", {
 *   appId: app.appId,
 *   branchName: "main",
 *   stage: "PRODUCTION",
 *   enableAutoBuild: false,
 * });
 * ```
 *
 * @example Password-Protected Branch with Content TTL
 * ```typescript
 * const branch = yield* Branch("Preview", {
 *   appId: app.appId,
 *   branchName: "preview",
 *   stage: "DEVELOPMENT",
 *   ttl: "10 minutes",
 *   enableBasicAuth: true,
 *   // base64 of "user:password"
 *   basicAuthCredentials: Redacted.make(credentials),
 * });
 * ```
 */
export const Branch = Resource<Branch>("AWS.Amplify.Branch");

// Amplify throttles control-plane writes account-wide in roughly per-minute
// buckets and surfaces it as a BadRequestException with a "Rate exceeded"
// message (not a throttling error class). A burst elsewhere in the account
// (e.g. a mass delete) can keep the bucket exhausted for most of a minute, so
// spread bounded retries evenly across ~80s instead of front-loading an
// exponential that spends its whole budget in the first few seconds.
const amplifyWriteRetrySchedule = Schedule.max([
  Schedule.spaced("8 seconds"),
  Schedule.recurs(10),
]);

export const BranchProvider = () =>
  Provider.effect(
    Branch,
    Effect.gen(function* () {
      const toName = (id: string, props: { branchName?: string } = {}) =>
        props.branchName
          ? Effect.succeed(props.branchName)
          : createPhysicalName({ id, maxLength: 100 });

      const observe = (appId: string, branchName: string) =>
        amplify.getBranch({ appId, branchName }).pipe(
          Effect.map((r) => r.branch),
          // Amplify's API Gateway front door can time out a slow
          // control-plane call ("Endpoint request timed out"); reads are
          // side-effect free, so retry the typed tag with bounded backoff.
          Effect.retry({
            while: (e): boolean => e._tag === "TimeoutException",
            schedule: Schedule.exponential("2 seconds"),
            times: 3,
          }),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      const syncTags = Effect.fn(function* (
        branchArn: string,
        desiredTags: Record<string, string>,
        observedTags: Record<string, string>,
      ) {
        const { removed, upsert } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* amplify.tagResource({
            resourceArn: branchArn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* amplify.untagResource({
            resourceArn: branchArn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: ["appId", "branchName", "branchArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (somePropsAreDifferent(olds, news, ["appId", "branchName"])) {
            return { action: "replace" };
          }
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (!output?.appId || !output.branchName) return undefined;
          const branch = yield* observe(output.appId, output.branchName);
          if (!branch) return undefined;
          const attrs = {
            appId: output.appId,
            branchName: branch.branchName,
            branchArn: branch.branchArn,
            tags: tagRecord(branch.tags),
          };
          return (yield* hasAlchemyTags(id, branch.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const branchName = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const ttl =
            news.ttl === undefined
              ? undefined
              : String(toWireSeconds(news.ttl));

          const settings = {
            description: news.description,
            displayName: news.displayName,
            stage: news.stage,
            framework: news.framework,
            enableAutoBuild: news.enableAutoBuild,
            enableSkewProtection: news.enableSkewProtection,
            enablePerformanceMode: news.enablePerformanceMode,
            environmentVariables: news.environmentVariables,
            enableBasicAuth: news.enableBasicAuth,
            basicAuthCredentials: news.basicAuthCredentials,
            buildSpec: news.buildSpec,
            ttl,
            enablePullRequestPreview: news.enablePullRequestPreview,
            pullRequestEnvironmentName: news.pullRequestEnvironmentName,
          };

          let branch = yield* observe(news.appId, branchName);

          if (!branch) {
            // CreateBranch is subject to the account-wide "Rate exceeded"
            // throttle (see amplifyWriteRetrySchedule). Its API Gateway
            // front door can also time out a slow CreateBranch (typed
            // TimeoutException, "Endpoint request timed out") with the
            // outcome unknown — re-observe before every (re)try so a
            // retry converges on the branch the timed-out call created.
            branch = yield* observe(news.appId, branchName).pipe(
              Effect.flatMap((existing) =>
                existing
                  ? Effect.succeed(existing)
                  : amplify
                      .createBranch({
                        appId: news.appId,
                        branchName,
                        ...settings,
                        tags: desiredTags,
                      })
                      .pipe(Effect.map((r) => r.branch)),
              ),
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "TimeoutException" ||
                  (e._tag === "BadRequestException" &&
                    (e.message ?? "").includes("Rate exceeded")),
                schedule: amplifyWriteRetrySchedule,
              }),
            );
          } else {
            // UpdateBranch is idempotent — retry front-door timeouts and
            // the "Rate exceeded" throttle with bounded backoff.
            const updated = yield* amplify
              .updateBranch({
                appId: news.appId,
                branchName,
                ...settings,
              })
              .pipe(
                Effect.retry({
                  while: (e): boolean =>
                    e._tag === "TimeoutException" ||
                    (e._tag === "BadRequestException" &&
                      (e.message ?? "").includes("Rate exceeded")),
                  schedule: amplifyWriteRetrySchedule,
                }),
              );
            yield* syncTags(
              updated.branch.branchArn,
              desiredTags,
              tagRecord(branch.tags),
            );
            branch = updated.branch;
          }

          yield* session.note(branch.branchArn);
          return {
            appId: news.appId,
            branchName: branch.branchName,
            branchArn: branch.branchArn,
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const apps = yield* amplify.listApps.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.apps ?? []),
              ),
            );
            const branches: Array<{
              appId: string;
              branchName: string;
              branchArn: string;
              tags: Record<string, string>;
            }> = [];
            for (const app of apps) {
              const appBranches = yield* amplify.listBranches
                .pages({ appId: app.appId })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) => page.branches ?? []),
                  ),
                );
              for (const branch of appBranches) {
                branches.push({
                  appId: app.appId,
                  branchName: branch.branchName,
                  branchArn: branch.branchArn,
                  tags: tagRecord(branch.tags),
                });
              }
            }
            return branches;
          }),
        delete: Effect.fn(function* ({ output }) {
          // DeleteBranch is idempotent — retry front-door timeouts and the
          // account-wide "Rate exceeded" throttle; a timed-out delete that
          // actually landed resolves to NotFoundException on the retry,
          // which is swallowed below.
          yield* amplify
            .deleteBranch({
              appId: output.appId,
              branchName: output.branchName,
            })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "TimeoutException" ||
                  (e._tag === "BadRequestException" &&
                    (e.message ?? "").includes("Rate exceeded")),
                schedule: amplifyWriteRetrySchedule,
              }),
              Effect.catchTag("NotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
