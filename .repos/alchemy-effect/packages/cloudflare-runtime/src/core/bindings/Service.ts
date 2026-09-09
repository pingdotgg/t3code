import * as Effect from "effect/Effect";
import { SERVICE_USER_WORKER } from "../internal/constants.ts";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";
import { RegistryProxy } from "../registry/RegistryProxy.ts";
import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export interface LocalServiceProps {
  /**
   * Name of the binding.
   */
  readonly binding: string;
  /**
   * Name of the worker (as registered in the dev registry by another
   * `cloudflare-runtime` or `wrangler dev` process) to bind to.
   */
  readonly scriptName: string;
  /**
   * Named entrypoint on the target worker. Defaults to the default entrypoint.
   */
  readonly entrypoint?: string;
  /**
   * Optional `ctx.props` forwarded to the remote entrypoint.
   */
  readonly props?: Record<string, unknown>;
}

/**
 * Bind to another locally-running worker by name. The connection is
 * established cross-process via the workerd debug port and the on-disk
 * dev registry, so the target worker can be running in a separate
 * `cloudflare-runtime` or `wrangler dev` process.
 */
export const local = ({
  binding,
  scriptName,
  entrypoint,
  props,
}: LocalServiceProps): BindingHook<RegistryProxy> =>
  Plugin.use(RegistryProxy, (proxy) =>
    proxy.api
      .subscribe({
        kind: "worker",
        scriptName,
        entrypoint,
        props,
      })
      .pipe(
        Effect.map((service) => ({
          name: binding,
          service,
        })),
      ),
  );

export interface SelfServiceProps {
  /**
   * Named entrypoint on the worker. Defaults to the default entrypoint.
   */
  readonly entrypoint?: string;
}

/**
 * Bind the worker to itself (a same-script service binding, e.g. OpenNext's
 * `WORKER_SELF_REFERENCE`). Unlike {@link local}, this resolves in-process with
 * no dev-registry round trip, so it works while the worker is still starting.
 *
 * The binding targets the user worker service directly, **bypassing the
 * middleware chain** (assets router, etc.) that fronts the worker's entry
 * socket. Requests sent through this binding always reach the worker's own
 * handlers, even for paths that static assets would otherwise serve. This is
 * the correct semantic for self-invocation patterns like ISR revalidation,
 * where the request must hit the worker's `fetch` handler rather than the
 * assets middleware.
 */
export const self = (
  binding: string,
  { entrypoint }: SelfServiceProps = {},
): BindingHook =>
  Effect.succeed({
    name: binding,
    service: {
      name: SERVICE_USER_WORKER,
      ...(entrypoint !== undefined ? { entrypoint } : undefined),
    },
  });

/**
 * Bind to a deployed Cloudflare Worker via the remote bindings proxy.
 */
export const remote = (name: string, service: string) =>
  makeRemoteBinding({ name, type: "service", service }, (service) => ({
    name,
    service,
  }));
