import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface DiscoveryProps {}

export interface Discovery extends Resource<
  "AWS.ApplicationSignals.Discovery",
  DiscoveryProps,
  {
    /**
     * The AWS account in which Application Signals discovery was enabled.
     */
    accountId: string;
    /**
     * The region in which Application Signals discovery was enabled.
     */
    region: string;
  },
  never,
  Providers
> {}

/**
 * Enables CloudWatch Application Signals for this account by creating the
 * `AWSServiceRoleForCloudWatchApplicationSignals` service-linked role and the
 * service-linked CloudTrail event channel used for change-event correlation
 * (mirrors CloudFormation's `AWS::ApplicationSignals::Discovery`).
 *
 * `StartDiscovery` is idempotent, and AWS provides no API to disable
 * discovery or observe its enablement, so this resource is
 * provision-only: deleting it from the stack leaves discovery enabled
 * (the delete is a no-op, matching CloudFormation's behavior).
 *
 * @resource
 * @section Enabling Application Signals
 * @example Enable Discovery for the Account
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const discovery = yield* AWS.ApplicationSignals.Discovery("Discovery", {});
 * ```
 */
export const Discovery = Resource<Discovery>(
  "AWS.ApplicationSignals.Discovery",
);

export const DiscoveryProvider = () =>
  Provider.effect(
    Discovery,
    Effect.gen(function* () {
      return {
        stables: ["accountId", "region"],

        read: Effect.fn(function* ({ output }) {
          // There is no API to observe whether discovery is enabled — echo
          // the recorded state; a lost state falls through to a (harmless,
          // idempotent) re-enable on the next reconcile.
          return output;
        }),

        reconcile: Effect.fn(function* ({ session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          // StartDiscovery is idempotent: re-enabling an already-enabled
          // account succeeds without side effects.
          yield* appsignals.startDiscovery({});
          yield* session.note(`application-signals discovery ${accountId}`);
          return { accountId, region };
        }),

        delete: Effect.fn(function* () {
          // Discovery cannot be disabled via API — deletion is a no-op
          // (CloudFormation's AWS::ApplicationSignals::Discovery behaves the
          // same way).
        }),

        list: () => Effect.succeed([]),
      };
    }),
  );
