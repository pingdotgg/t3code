/** `Cloudflare.Container` bootstrap on the bun runtime. */
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { bootstrapContainer, type ContainerBootstrapOptions } from "./Container.ts";

export const bootstrap = (entrypoint: unknown, options: ContainerBootstrapOptions): Promise<void> =>
  bootstrapContainer(
    { services: BunServices.layer, httpServer: BunHttpServer() },
    entrypoint,
    options,
  );
