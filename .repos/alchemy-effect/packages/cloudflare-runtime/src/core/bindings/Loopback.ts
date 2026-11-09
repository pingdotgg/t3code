import * as Effect from "effect/Effect";
import * as Loopback from "../globals/Loopback.ts";
import type * as LoopbackServer from "../globals/LoopbackServer.ts";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";

export interface LoopbackProps {
  /**
   * Name of the binding to register.
   */
  readonly binding: string;
  /**
   * Name of the route to register. This must be unique within the current loopback server.
   */
  readonly name: string;
  /**
   * Handler to invoke when the route is matched.
   */
  readonly handler: LoopbackServer.RouteHandler;
}

export const local = ({ binding, name, handler }: LoopbackProps): BindingHook<Loopback.Loopback> =>
  Effect.map(
    Plugin.use(Loopback.Loopback, (loopback) => loopback.api.route(name, handler)),
    (service) => ({
      name: binding,
      service,
    }),
  );
