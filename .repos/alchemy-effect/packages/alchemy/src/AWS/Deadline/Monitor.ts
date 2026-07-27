import * as deadline from "@distilled.cloud/aws/deadline";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, type Tags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  deadlineArnOf,
  fetchDeadlineTags,
  retryThroughIamPropagation,
  syncDeadlineTags,
} from "./internal.ts";

export interface MonitorProps {
  /**
   * Display name of the monitor, shown on its web page.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * Subdomain the monitor URL is served under
   * (`https://{subdomain}.{region}.deadlinecloud.amazonaws.com`).
   */
  subdomain: string;
  /**
   * ARN of the IAM Identity Center instance responsible for authenticating
   * monitor users. Changing it replaces the monitor.
   */
  identityCenterInstanceArn: string;
  /**
   * Region of the IAM Identity Center instance, when it differs from the
   * monitor's region.
   */
  identityCenterRegion?: string;
  /**
   * ARN of the IAM role the monitor assumes on behalf of signed-in users.
   */
  roleArn: string;
  /**
   * Tags to associate with the monitor.
   */
  tags?: Record<string, string>;
}

export interface Monitor extends Resource<
  "AWS.Deadline.Monitor",
  MonitorProps,
  {
    /**
     * Service-assigned unique identifier of the monitor (`monitor-...`).
     */
    monitorId: string;
    /**
     * ARN of the monitor.
     */
    monitorArn: string;
    /**
     * The monitor's display name.
     */
    displayName: string;
    /**
     * The configured subdomain.
     */
    subdomain: string;
    /**
     * Full URL of the monitor's web page.
     */
    url: string;
    /**
     * ARN of the monitor's user role.
     */
    roleArn: string;
    /**
     * ARN of the IAM Identity Center instance backing sign-in.
     */
    identityCenterInstanceArn: string;
    /**
     * ARN of the Identity Center application the monitor registered.
     */
    identityCenterApplicationArn: string;
    /**
     * Current tags reported for the monitor.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Deadline Cloud monitor — the hosted web console where artists and
 * administrators view farms, queues, and jobs, authenticated through IAM
 * Identity Center.
 *
 * @resource
 * @section Creating Monitors
 * @example Basic Monitor
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const monitor = yield* AWS.Deadline.Monitor("StudioMonitor", {
 *   subdomain: "studio-renders",
 *   identityCenterInstanceArn: "arn:aws:sso:::instance/ssoins-1234567890abcdef",
 *   roleArn: monitorRole.roleArn,
 * });
 * ```
 *
 * @example Export the Monitor URL
 * ```typescript
 * // The monitor's web console URL is available as an output attribute —
 * // return it from the stack so users know where to sign in.
 * const monitor = yield* AWS.Deadline.Monitor("StudioMonitor", {
 *   subdomain: "studio-renders",
 *   identityCenterInstanceArn: identityCenterArn,
 *   roleArn: monitorRole.roleArn,
 * });
 * return { monitorUrl: monitor.url };
 * ```
 */
export const Monitor = Resource<Monitor>("AWS.Deadline.Monitor");

const createMonitorName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

interface MonitorState {
  attrs: Monitor["Attributes"];
  described: deadline.GetMonitorResponse;
}

const readMonitorById = Effect.fn(function* (
  monitorId: string,
  arnOf: (path: string) => string,
) {
  const described = yield* deadline
    .getMonitor({ monitorId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  const monitorArn = arnOf(`monitor/${described.monitorId}`);
  const state: MonitorState = {
    described,
    attrs: {
      monitorId: described.monitorId,
      monitorArn,
      displayName: described.displayName,
      subdomain: described.subdomain,
      url: described.url,
      roleArn: described.roleArn,
      identityCenterInstanceArn: described.identityCenterInstanceArn,
      identityCenterApplicationArn: described.identityCenterApplicationArn,
      tags: yield* fetchDeadlineTags(monitorArn),
    },
  };
  return state;
});

const findMonitorBySubdomain = Effect.fn(function* (
  subdomain: string,
  arnOf: (path: string) => string,
) {
  const summaries = yield* deadline.listMonitors.items({}).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  const match = summaries.find((summary) => summary.subdomain === subdomain);
  if (!match) return undefined;
  return yield* readMonitorById(match.monitorId, arnOf);
});

export const MonitorProvider = () =>
  Provider.effect(
    Monitor,
    Effect.gen(function* () {
      return {
        stables: [
          "monitorId",
          "monitorArn",
          "identityCenterInstanceArn",
          "identityCenterApplicationArn",
        ],
        list: () =>
          Effect.gen(function* () {
            const arnOf = yield* deadlineArnOf;
            const summaries = yield* deadline.listMonitors.items({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const states = yield* Effect.forEach(
              summaries,
              (summary) => readMonitorById(summary.monitorId, arnOf),
              { concurrency: 4 },
            );
            return states
              .filter((state): state is MonitorState => state !== undefined)
              .map((state) => state.attrs);
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arnOf = yield* deadlineArnOf;
          const subdomain = output?.subdomain ?? olds?.subdomain;
          const state = output?.monitorId
            ? yield* readMonitorById(output.monitorId, arnOf)
            : subdomain !== undefined
              ? yield* findMonitorBySubdomain(subdomain, arnOf)
              : undefined;
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The Identity Center instance is fixed at creation.
          if (
            olds.identityCenterInstanceArn !== news.identityCenterInstanceArn
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (news === undefined) {
            return yield* Effect.fail(
              new Error("AWS.Deadline.Monitor requires props"),
            );
          }
          const arnOf = yield* deadlineArnOf;
          const displayName = yield* createMonitorName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe.
          let state = output?.monitorId
            ? yield* readMonitorById(output.monitorId, arnOf)
            : yield* findMonitorBySubdomain(news.subdomain, arnOf);

          // Ensure.
          if (state === undefined) {
            const created = yield* retryThroughIamPropagation(
              deadline.createMonitor({
                displayName,
                subdomain: news.subdomain,
                identityCenterInstanceArn: news.identityCenterInstanceArn,
                identityCenterRegion: news.identityCenterRegion,
                roleArn: news.roleArn,
                tags: desiredTags,
              }),
            );
            yield* session.note(
              `Created monitor ${displayName} (${created.monitorId})`,
            );
            state = yield* readMonitorById(created.monitorId, arnOf);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created monitor ${displayName}`),
              );
            }
          }

          // Sync mutable settings — only when drifted from OBSERVED state.
          const described = state.described;
          const needsUpdate =
            displayName !== described.displayName ||
            news.subdomain !== described.subdomain ||
            news.roleArn !== described.roleArn;
          if (needsUpdate) {
            yield* deadline.updateMonitor({
              monitorId: state.attrs.monitorId,
              displayName,
              subdomain: news.subdomain,
              roleArn: news.roleArn,
            });
            yield* session.note(`Updated monitor ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          yield* syncDeadlineTags(state.attrs.monitorArn, desiredTags);

          yield* session.note(state.attrs.monitorArn);
          const final = yield* readMonitorById(state.attrs.monitorId, arnOf);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled monitor ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deadline
            .deleteMonitor({ monitorId: output.monitorId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
