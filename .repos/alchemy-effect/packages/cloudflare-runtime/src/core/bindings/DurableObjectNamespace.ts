import * as Effect from "effect/Effect";
import { defaultDurableObjectUniqueKey } from "../internal/constants.ts";
import type { BindingHook } from "../PluginContext.ts";
import { PluginContext } from "../PluginContext.ts";
import { RegistryProxy } from "../registry/RegistryProxy.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../workerd/Config.ts";

export interface LocalDurableObjectNamespaceProps {
  /**
   * Name of the binding.
   */
  readonly binding: string;
  /**
   * Class name of the Durable Object namespace to bind to.
   */
  readonly className: string;
  /**
   * If set and the referenced worker isn't the current one, the binding is
   * routed through the dev-registry proxy. This enables service-binding
   * style cross-process Durable Object access during local development.
   */
  readonly scriptName?: string;
  /**
   * If set and the referenced worker isn't the current one, the binding is
   * routed through the dev-registry proxy. This enables service-binding
   * style cross-process Durable Object access during local development.
   */
  readonly uniqueKey?: string;
}

/**
 * Bind a Durable Object namespace.
 *
 * - Without `scriptName`: bind a DO defined on the current worker.
 * - With `scriptName === <current worker name>`: same as above.
 * - With `scriptName !== <current worker name>`: route through the dev
 *   registry proxy so the DO can live in a different `cloudflare-runtime`
 *   or `wrangler dev` process.
 */
export const local = ({
  binding,
  className,
  scriptName,
  uniqueKey,
}: LocalDurableObjectNamespaceProps): BindingHook<RegistryProxy> =>
  PluginContext.use((context) => {
    if (scriptName === undefined || scriptName === context.worker.name) {
      const namespace = context.worker.durableObjectNamespaces?.find(
        (namespace) => namespace.className === className,
      );
      if (!namespace) {
        return Effect.fail(
          new ConfigError({
            subtag: "DurableObjectNamespaceNotFound",
            message: `Durable object namespace ${className} not found`,
            hint: `Make sure the durable object namespace ${className} is defined in the worker config`,
            detail: {
              className,
              registeredClasses: context.worker.durableObjectNamespaces?.map(
                (namespace) => namespace.className,
              ),
            },
          }),
        );
      }
      if (uniqueKey && namespace.uniqueKey !== uniqueKey) {
        return Effect.fail(
          new ConfigError({
            subtag: "DurableObjectNamespaceUniqueKeyMismatch",
            message: `Durable object namespace ${className} has unique key "${namespace.uniqueKey}" but "${uniqueKey}" was provided`,
          }),
        );
      }
      return Effect.succeed<WorkerdConfig.Worker_Binding>({
        name: binding,
        durableObjectNamespace: { className },
      });
    }
    return context.get(RegistryProxy).pipe(
      Effect.flatMap((proxy) =>
        proxy.api.subscribe({
          kind: "durable-object",
          scriptName,
          className,
          uniqueKey:
            uniqueKey ?? defaultDurableObjectUniqueKey(scriptName, className),
        }),
      ),
      Effect.map((durableObjectNamespace): WorkerdConfig.Worker_Binding => ({
        name: binding,
        durableObjectNamespace,
      })),
    );
  });
