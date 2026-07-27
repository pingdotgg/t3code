import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Which finding format Security Hub generates for controls.
 */
export type ControlFindingGenerator = "STANDARD_CONTROL" | "SECURITY_CONTROL";

export interface HubProps {
  /**
   * Whether to enable the default security standards (AWS Foundational Security
   * Best Practices, CIS) when Security Hub is first enabled. Only takes effect
   * on the initial enablement.
   * @default true
   */
  enableDefaultStandards?: boolean;

  /**
   * Whether Security Hub automatically enables new controls when they are added
   * to enabled standards.
   */
  autoEnableControls?: boolean;

  /**
   * Whether to generate `STANDARD_CONTROL` or `SECURITY_CONTROL` findings.
   */
  controlFindingGenerator?: ControlFindingGenerator;

  /**
   * Tags applied to the Hub. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Hub extends Resource<
  "AWS.SecurityHub.Hub",
  HubProps,
  {
    /** ARN of the Security Hub Hub resource. */
    hubArn: string;
    /** When Security Hub was enabled for the account. */
    subscribedAt: string | undefined;
    /** Whether new controls are auto-enabled. */
    autoEnableControls: boolean | undefined;
    /** The active control finding generator. */
    controlFindingGenerator: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Security Hub Hub — the account/region singleton that enables AWS Security
 * Hub. Only one Hub can exist per region, so this is a capture-and-restore
 * singleton: adopting a pre-existing Hub that Alchemy did not create requires
 * `--adopt`.
 *
 * @section Enabling Security Hub
 * @example Enable with default standards
 * ```typescript
 * const hub = yield* SecurityHub.Hub("Hub", {});
 * ```
 *
 * @example Enable without default standards, auto-enable controls
 * ```typescript
 * const hub = yield* SecurityHub.Hub("Hub", {
 *   enableDefaultStandards: false,
 *   autoEnableControls: true,
 *   controlFindingGenerator: "SECURITY_CONTROL",
 *   tags: { team: "security" },
 * });
 * ```
 */
const HubResource = Resource<Hub>("AWS.SecurityHub.Hub");

export { HubResource as Hub };

const hubArnFallback = (region: string, accountId: string) =>
  `arn:aws:securityhub:${region}:${accountId}:hub/default`;

const buildAttrs = (hub: securityhub.DescribeHubResponse) => ({
  hubArn: hub.HubArn!,
  subscribedAt: hub.SubscribedAt,
  autoEnableControls: hub.AutoEnableControls,
  controlFindingGenerator: hub.ControlFindingGenerator,
});

// `describeHub` throws `InvalidAccessException` when the account is not
// subscribed and `ResourceNotFoundException` transiently right after enable —
// both mean "no Hub", so collapse them to `undefined`.
const describeHub = securityhub.describeHub({}).pipe(
  Effect.catchTag("InvalidAccessException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

export const HubProvider = () =>
  Provider.effect(
    HubResource,
    Effect.gen(function* () {
      const readTags = (arn: string) =>
        securityhub.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((r) => tagRecord(r.Tags)),
          Effect.catch(() => Effect.succeed<Record<string, string>>({})),
        );

      return {
        read: Effect.fn(function* ({ id }) {
          const hub = yield* describeHub;
          if (!hub) return undefined;
          const attrs = buildAttrs(hub);
          const tags = yield* readTags(attrs.hubArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Security Hub is an account/region singleton — `describeHub` returns
        // the single Hub or throws when unsubscribed.
        list: () =>
          describeHub.pipe(Effect.map((hub) => (hub ? [buildAttrs(hub)] : []))),

        reconcile: Effect.fn(function* ({ id, news = {}, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let hub = yield* describeHub;

          // 2. ENSURE — enable Security Hub if not already subscribed.
          if (!hub) {
            yield* securityhub.enableSecurityHub({
              Tags: desiredTags,
              EnableDefaultStandards: news.enableDefaultStandards ?? true,
              ControlFindingGenerator: news.controlFindingGenerator,
            });
            hub = yield* securityhub.describeHub({});
          }

          const arn = hub.HubArn ?? hubArnFallback(region, accountId);

          // 3. SYNC configuration — observed ↔ desired.
          const configChanged =
            (news.autoEnableControls !== undefined &&
              news.autoEnableControls !== hub.AutoEnableControls) ||
            (news.controlFindingGenerator !== undefined &&
              news.controlFindingGenerator !== hub.ControlFindingGenerator);
          if (configChanged) {
            yield* securityhub.updateSecurityHubConfiguration({
              AutoEnableControls: news.autoEnableControls,
              ControlFindingGenerator: news.controlFindingGenerator,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags.
          const currentTags = yield* readTags(arn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* securityhub.tagResource({
              ResourceArn: arn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* securityhub.untagResource({
              ResourceArn: arn,
              TagKeys: removed,
            });
          }

          // 4. RETURN fresh attributes.
          const final = yield* securityhub.describeHub({});
          yield* session.note(arn);
          return buildAttrs(final);
        }),

        delete: Effect.fn(function* () {
          yield* securityhub.disableSecurityHub({}).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.catchTag("InvalidAccessException", () => Effect.void),
          );
        }),
      };
    }),
  );
