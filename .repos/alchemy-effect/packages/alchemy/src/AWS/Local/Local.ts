/**
 * The AWS dev sidecar entry: serves the floci-backed local providers over
 * RPC so their long-lived state — `Bundle.watch` loops hot-swapping Lambda
 * code into the emulator, ECS image watch loops rebuilding and restarting
 * task containers — survives exec-process hot reloads during `alchemy dev`.
 * Mirrors the Cloudflare sidecar entry
 * ([Cloudflare/Local.ts](../../Cloudflare/Local.ts)).
 */
import * as Layer from "effect/Layer";
import { DockerLive } from "../../Docker/Docker.ts";
import * as RpcServer from "../../Local/RpcServer.ts";
import { FlociServiceProvider } from "../ECS/FlociServiceProvider.ts";
import { FlociTaskProvider } from "../ECS/FlociTaskProvider.ts";
import { FlociFunctionProvider } from "../Lambda/FlociFunctionProvider.ts";
import { FlociMicrovmImageProvider } from "../Lambda/FlociMicrovmImageProvider.ts";

Layer.mergeAll(
  FlociFunctionProvider(),
  FlociMicrovmImageProvider(),
  FlociTaskProvider(),
  FlociServiceProvider(),
).pipe(
  // The ECS image pipelines (docker build / mirror / push) run in the
  // sidecar and need the Docker CLI service.
  Layer.provide(DockerLive),
  RpcServer.launch,
);
