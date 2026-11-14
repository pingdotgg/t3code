import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { Container, ContainerProvider } from "./Container.ts";
import { Context, ContextProvider } from "./Context.ts";
import { type DockerOptions, dockerLive } from "./Docker.ts";
import { Image, ImageProvider } from "./Image.ts";
import { Network, NetworkProvider } from "./Network.ts";
import { RemoteImage, RemoteImageProvider } from "./RemoteImage.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { Swarm, SwarmProvider } from "./Swarm.ts";
import { Volume, VolumeProvider } from "./Volume.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Docker") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Registers all Docker resource providers.
 *
 * Docker providers use the active Docker CLI context and are intentionally
 * separate from `Cloudflare.Container`. Pass `bin` to run a Docker-compatible
 * CLI such as Podman; the `DOCKER_BIN` environment variable overrides it.
 *
 * ```typescript
 * providers: Docker.providers({ bin: "podman" }),
 * ```
 */
export const providers = (options: DockerOptions = {}) =>
  Layer.effect(
    Providers,
    Provider.collection([Container, Image, Network, RemoteImage, Volume, Context, Service, Swarm]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ContainerProvider(),
        ImageProvider(),
        NetworkProvider(),
        RemoteImageProvider(),
        VolumeProvider(),
        ContextProvider(),
        ServiceProvider(),
        SwarmProvider(),
      ),
    ),
    Layer.provideMerge(dockerLive(options)),
  );
