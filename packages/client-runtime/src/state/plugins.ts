import {
  type ExecutionEnvironmentCapabilities,
  type PluginInstallation,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { requestIfSupported, subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** One environment's plugins, or `unsupported` for a server that has no plugin catalogue. */
export type PluginCatalogView =
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "available";
      readonly installations: ReadonlyArray<PluginInstallation>;
      /** Client-side delivery order across every catalogue subscription; later deliveries are greater. */
      readonly revision: number;
    };

let deliveredRevision = 0;

/** A catalogue snapshot as it is delivered, numbered after every snapshot delivered before it. */
export const deliverPluginCatalog = (
  installations: ReadonlyArray<PluginInstallation>,
): PluginCatalogView => ({ _tag: "available", installations, revision: ++deliveredRevision });

/** The revision of the latest delivered snapshot; anything delivered later has a greater one. */
export const latestPluginCatalogRevision = () => deliveredRevision;

const supportsPluginCatalog = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "plugins"> | null | undefined,
) => capabilities?.plugins === true;

const UNSUPPORTED: PluginCatalogView = { _tag: "unsupported" };

type PluginCommandTag =
  | typeof WS_METHODS.pluginsAdd
  | typeof WS_METHODS.pluginsRefresh
  | typeof WS_METHODS.pluginsConsent
  | typeof WS_METHODS.pluginsEnable
  | typeof WS_METHODS.pluginsDisable
  | typeof WS_METHODS.pluginsRemove
  | typeof WS_METHODS.pluginsResume;

/**
 * Follows the environment's sessions and checks each server's capability
 * before subscribing, so a server without the catalogue never receives a
 * plugin call.
 */
export const pluginCatalogStream = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              Stream.unwrap(
                session.initialConfig.pipe(
                  Effect.map((config) =>
                    supportsPluginCatalog(config.environment.capabilities)
                      ? subscribe(WS_METHODS.pluginsSubscribe, {}).pipe(
                          Stream.map((snapshot) => deliverPluginCatalog(snapshot.installations)),
                        )
                      : Stream.succeed(UNSUPPORTED),
                  ),
                  // A session that never delivered its config has nothing to show yet.
                  Effect.orElseSucceed(() => Stream.empty),
                ),
              ),
          }),
        ),
      ),
    ),
  ),
);

export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Management steps for one environment run in order, matching the server's own lock.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  /** A command that checks the capability on the session it would use, so an older server never receives it. */
  const command = <TTag extends PluginCommandTag>(label: string, tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label,
      tag,
      scheduler,
      concurrency,
      execute: (input) => requestIfSupported(tag, input, supportsPluginCatalog),
    });
  return {
    /** The live catalogue with each enabled plugin's process state. */
    catalog: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:catalog",
      subscribe: (_input: Record<string, never>) => pluginCatalogStream,
    }),
    add: command("environment-data:plugins:add", WS_METHODS.pluginsAdd),
    refresh: command("environment-data:plugins:refresh", WS_METHODS.pluginsRefresh),
    consent: command("environment-data:plugins:consent", WS_METHODS.pluginsConsent),
    enable: command("environment-data:plugins:enable", WS_METHODS.pluginsEnable),
    disable: command("environment-data:plugins:disable", WS_METHODS.pluginsDisable),
    remove: command("environment-data:plugins:remove", WS_METHODS.pluginsRemove),
    resume: command("environment-data:plugins:resume", WS_METHODS.pluginsResume),
  };
}
