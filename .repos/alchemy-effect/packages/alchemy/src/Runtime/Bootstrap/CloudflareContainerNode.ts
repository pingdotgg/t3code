/** `Cloudflare.Container` bootstrap on the node runtime. */
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "../../Http.ts";
import {
  bootstrapContainer,
  type ContainerBootstrapOptions,
} from "./CloudflareContainer.ts";

export const bootstrap = (
  entrypoint: unknown,
  options: ContainerBootstrapOptions,
): Promise<void> =>
  bootstrapContainer(
    { services: NodeServices.layer, httpServer: NodeHttpServer() },
    entrypoint,
    options,
  );
