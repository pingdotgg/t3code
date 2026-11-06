/** `Cloudflare.Container` bootstrap on the node runtime. */
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "alchemy/Http";
import { bootstrapContainer, type ContainerBootstrapOptions } from "./Container.ts";

export const bootstrap = (entrypoint: unknown, options: ContainerBootstrapOptions): Promise<void> =>
  bootstrapContainer(
    { services: NodeServices.layer, httpServer: NodeHttpServer() },
    entrypoint,
    options,
  );
