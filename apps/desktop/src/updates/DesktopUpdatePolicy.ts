/**
 * DesktopUpdatePolicy - what the administrator's managed policy allows the desktop updater to do.
 * The desktop reads the policy file itself, before any backend runs, and fails closed: a policy it
 * cannot read turns updates off.
 *
 * @module DesktopUpdatePolicy
 */
import {
  managedUpdatesMessage,
  type ManagedPolicyDocument,
  type ManagedUpdatesMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

export interface UpdatePolicy {
  readonly mode: ManagedUpdatesMode;
  readonly feedUrl: string | undefined;
  readonly allowNightly: boolean;
  /** Why the updater is restricted, shown in place of update actions; `null` when unmanaged. */
  readonly message: string | null;
}

export class DesktopUpdatePolicy extends Context.Service<DesktopUpdatePolicy, UpdatePolicy>()(
  "@t3tools/desktop/updates/DesktopUpdatePolicy",
) {}

export const unmanagedUpdatePolicy: UpdatePolicy = {
  mode: "auto",
  feedUrl: undefined,
  allowNightly: true,
  message: null,
};

function resolveUpdatePolicy(document: ManagedPolicyDocument | undefined): UpdatePolicy {
  const updates = document?.limits?.updates;
  if (document === undefined || updates === undefined) return unmanagedUpdatePolicy;
  return {
    mode: updates.mode,
    feedUrl: updates.feedUrl,
    allowNightly: updates.allowNightly ?? true,
    message: managedUpdatesMessage(document.organization),
  };
}

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-update-policy");

const make = Effect.gen(function* () {
  return yield* (yield* DesktopManagedPolicy.DesktopManagedPolicy).read.pipe(
    Effect.map((found) => ({
      source: found?.source,
      policy: resolveUpdatePolicy(found?.document),
    })),
    Effect.tap(({ source, policy }) =>
      policy.message === null
        ? Effect.void
        : logInfo("managed policy restricts updates", {
            source,
            mode: policy.mode,
            customFeed: policy.feedUrl !== undefined,
            allowNightly: policy.allowNightly,
          }),
    ),
    Effect.map(({ policy }) => policy),
    Effect.catchTags({
      ManagedPolicyFileError: (error) =>
        logError("updates are off because the managed policy cannot be used", {
          path: error.path,
          reason: error.reason,
        }).pipe(
          Effect.as<UpdatePolicy>({
            mode: "off",
            feedUrl: undefined,
            allowNightly: false,
            message: `Updates are off because T3 Code cannot use the managed policy at ${error.path}. Contact your administrator.`,
          }),
        ),
    }),
  );
});

export const layer = Layer.effect(DesktopUpdatePolicy, make);

export const layerTest = (policy: UpdatePolicy = unmanagedUpdatePolicy) =>
  Layer.succeed(DesktopUpdatePolicy, policy);
