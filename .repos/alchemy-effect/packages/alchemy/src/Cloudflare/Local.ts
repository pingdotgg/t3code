import * as Layer from "effect/Layer";
import { DockerLive } from "../Docker/Docker.ts";
import * as RpcServer from "../Local/RpcServer.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import { LocalContainerProvider } from "./Containers/LocalContainerProvider.ts";
import * as Credentials from "./Credentials.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import { ProviderLocal } from "./Queues/Queue.ts";
import { ConsumerProviderLocal } from "./Queues/Consumer.ts";
import { LocalWorkerProvider } from "./Workers/LocalWorkerProvider.ts";

const cloudflareServices = Layer.provide(
  Layer.merge(
    Credentials.fromAuthProvider(),
    CloudflareEnvironment.fromProfile(),
  ),
  CloudflareAuth,
);

Layer.mergeAll(
  LocalWorkerProvider(),
  LocalContainerProvider(),
  ProviderLocal(),
  ConsumerProviderLocal(),
).pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(cloudflareServices),
  Layer.provide(DockerLive),
  RpcServer.launch,
);
