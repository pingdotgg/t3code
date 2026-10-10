import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const DispatchNamespaceBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/dispatch-namespace/dispatch-namespace.worker",
    ),
};
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";

export class DispatchNamespace extends Plugin.Service<DispatchNamespace>()(
  "cloudflare-runtime/plugin/DispatchNamespace",
) {}

const EXTENSION_MODULE_NAME = "cloudflare-runtime:dispatch-namespace";

export const DispatchNamespaceLive = Layer.succeed(
  DispatchNamespace,
  DispatchNamespace.of(
    Effect.map(
      formatExtensionModule(DispatchNamespaceBindingWorker),
      (esModule) => ({
        extensions: [
          {
            modules: [
              {
                name: EXTENSION_MODULE_NAME,
                internal: true,
                esModule,
              },
            ],
          },
        ],
      }),
    ),
  ),
);

export interface DispatchNamespaceProps {
  readonly binding: string;
  readonly namespace: string;
  readonly outbound?: {
    worker?: { service?: string; environment?: string };
    params?: Array<{ name: string }>;
  };
}

/**
 * Bind to a deployed dispatch namespace via the remote bindings proxy.
 *
 * Wraps the remote-bindings client service so user code can call
 * `env.BINDING.get(name, args, options).fetch(...)` against a user worker
 * dispatched from the remote namespace.
 */
export const remote = (
  props: DispatchNamespaceProps,
): BindingHook<RemoteBindings | DispatchNamespace> =>
  Plugin.use(DispatchNamespace, () =>
    makeRemoteBinding(
      {
        name: props.binding,
        type: "dispatch_namespace",
        namespace: props.namespace,
        outbound: props.outbound,
      },
      (service) => ({
        name: props.binding,
        wrapped: {
          moduleName: EXTENSION_MODULE_NAME,
          innerBindings: [{ name: "proxyClient", service }],
        },
      }),
    ),
  );
