import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Container, ContainerProvider } from "./Container.ts";
import { DockerLive } from "./Docker.ts";
import { Image, ImageProvider } from "./Image.ts";
import { Network, NetworkProvider } from "./Network.ts";
import { RemoteImage, RemoteImageProvider } from "./RemoteImage.ts";
import { Volume, VolumeProvider } from "./Volume.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Docker",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Registers all Docker resource providers.
 *
 * Docker providers use the active Docker CLI context and are intentionally
 * separate from `Cloudflare.Container`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Container, Image, Network, RemoteImage, Volume]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ContainerProvider(),
        ImageProvider(),
        NetworkProvider(),
        RemoteImageProvider(),
        VolumeProvider(),
      ),
    ),
    Layer.provideMerge(DockerLive),
  );
