/**
 * The AWS provider group served by the dev sidecar (see
 * `Local/Sidecar.ts`): the floci-backed local providers, whose long-lived
 * state — `Bundle.watch` loops hot-swapping Lambda code into the emulator,
 * ECS image watch loops rebuilding and restarting task containers —
 * survives exec-process hot reloads during `alchemy dev`. Built per session
 * the first time a stack asks for one of their types, so a stack without
 * AWS resources never starts the emulator. Mirrors
 * [Cloudflare/Local.ts](../../Cloudflare/Local.ts).
 */
import * as Layer from "effect/Layer";
import { DockerLive } from "../../Docker/Docker.ts";
import type * as RpcServer from "../../Local/RpcServer.ts";
import { FlociServiceProvider } from "../ECS/FlociServiceProvider.ts";
import { FlociTaskProvider } from "../ECS/FlociTaskProvider.ts";
import { FlociFunctionProvider } from "../Lambda/FlociFunctionProvider.ts";
import { FlociMicrovmImageProvider } from "../Lambda/FlociMicrovmImageProvider.ts";

export default Layer.mergeAll(
  FlociFunctionProvider(),
  FlociMicrovmImageProvider(),
  FlociTaskProvider(),
  FlociServiceProvider(),
).pipe(
  // The ECS image pipelines (docker build / mirror / push) run in the
  // sidecar and need the Docker CLI service.
  Layer.provide(DockerLive),
) satisfies RpcServer.ProviderLayer;
