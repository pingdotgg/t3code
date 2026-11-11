import { DockerLive } from "@alchemy.run/docker/Docker";
import type * as RpcServer from "alchemy/Local/RpcServer";
/**
 * The Cloudflare provider group served by the dev sidecar (see
 * `Local/Sidecar.ts`): the workerd-backed local providers, built per
 * session the first time a stack asks for one of their types.
 */
import * as Layer from "effect/Layer";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import { LocalContainerProvider } from "./Containers/LocalContainerProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ProviderLocal as D1ProviderLocal } from "./D1/Database.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import { ConsumerProviderLocal } from "./Queues/Consumer.ts";
import { ProviderLocal } from "./Queues/Queue.ts";
import { SecretProviderLocal } from "./SecretsStore/Secret.ts";
import { LocalWorkerProvider } from "./Workers/LocalWorkerProvider.ts";
import { WorkerRouteProviderLocal } from "./Workers/Route.ts";

const cloudflareServices = Layer.provide(
  Layer.merge(Credentials.fromAuthProvider(), CloudflareEnvironment.fromProfile()),
  CloudflareAuth,
);

export default Layer.mergeAll(
  LocalWorkerProvider(),
  LocalContainerProvider(),
  ProviderLocal(),
  ConsumerProviderLocal(),
  D1ProviderLocal(),
  SecretProviderLocal(),
  WorkerRouteProviderLocal(),
).pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(cloudflareServices),
  Layer.provide(DockerLive),
) satisfies RpcServer.ProviderLayer;
