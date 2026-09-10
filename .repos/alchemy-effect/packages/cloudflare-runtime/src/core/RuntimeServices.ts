import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AnalyticsEngine,
  Assets,
  Browser,
  Cache,
  D1,
  DispatchNamespace,
  Hyperdrive,
  Images,
  KvNamespace,
  Queue,
  R2Bucket,
  RateLimit,
  SecretsStore,
  SendEmail,
  Stream,
  Workflows,
} from "./bindings/index.ts";
import * as Docker from "./Docker.ts";
import {
  Globals,
  Internet,
  Loopback,
  LoopbackServer,
  Storage,
} from "./globals/index.ts";
import * as Paths from "./internal/Paths.ts";
import * as WorkerProxy from "./proxy/WorkerProxy.ts";
import { Registry, RegistryProxy } from "./registry/index.ts";
import {
  Access,
  RemoteBindings,
  RemoteWorker,
} from "./remote-bindings/index.ts";
import * as Runtime from "./Runtime.ts";
import * as Workerd from "./workerd/Workerd.ts";

export interface RuntimeConfig {
  api: ApiConfig;
  storage?: StorageConfig;
}

export interface ApiConfig {
  accountId: string | Effect.Effect<string>;
}

export interface StorageConfig {
  directory: string;
}

export const layerRemoteBindings = ({ accountId }: ApiConfig) =>
  RemoteBindings.RemoteBindingsLive.pipe(
    Layer.provide(
      RemoteWorker.layer(
        Effect.isEffect(accountId) ? accountId : Effect.succeed(accountId),
      ),
    ),
    Layer.provide(Access.layer),
  );

export const layerStorage = (config: StorageConfig | undefined) =>
  config ? Storage.layerDisk(config.directory) : Storage.layerTemp();

export const layerLoopback = () =>
  Layer.provide(Loopback.LoopbackLive, LoopbackServer.LoopbackServerLive);

export const layerLocalBindings = () =>
  Layer.mergeAll(
    AnalyticsEngine.AnalyticsEngineLive,
    Assets.AssetsLive,
    Browser.BrowserLive,
    Cache.CacheLive,
    D1.D1Live,
    DispatchNamespace.DispatchNamespaceLive,
    Hyperdrive.HyperdriveLive,
    Images.ImagesLive,
    KvNamespace.KvNamespaceLive,
    Queue.QueueLive,
    R2Bucket.R2BucketLive,
    RateLimit.RateLimitLive,
    SecretsStore.SecretsStoreLive,
    SendEmail.SendEmailLive,
    Stream.StreamLive,
    Workflows.WorkflowsLive,
  );

export type BindingServices =
  | AnalyticsEngine.AnalyticsEngine
  | Assets.Assets
  | Browser.Browser
  | Cache.Cache
  | D1.D1
  | DispatchNamespace.DispatchNamespace
  | Hyperdrive.Hyperdrive
  | Images.Images
  | KvNamespace.KvNamespace
  | Loopback.Loopback
  | Queue.Queue
  | R2Bucket.R2Bucket
  | RateLimit.RateLimit
  | RemoteBindings.RemoteBindings
  | RegistryProxy.RegistryProxy
  | SecretsStore.SecretsStore
  | SendEmail.SendEmail
  | Stream.Stream
  | Workflows.Workflows;

export type RuntimeServices = Runtime.Runtime | BindingServices;

export const layerProxy = () =>
  Layer.provide(
    WorkerProxy.WorkerProxyLive,
    Layer.mergeAll(Internet.InternetLive, Workerd.WorkerdLive),
  );

export const layerRegistry = () =>
  RegistryProxy.RegistryProxyLive.pipe(Layer.provide(Registry.RegistryLive));

export const layerRuntime = (config: RuntimeConfig) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(layerLocalBindings()),
    Layer.provideMerge(layerRemoteBindings(config.api)),
    Layer.provideMerge(WorkerProxy.WorkerProxyLive),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(layerLoopback()),
    Layer.provide(layerStorage(config.storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(layerRegistry()),
    Layer.provide(Paths.PathsLive),
    Layer.provide(Docker.DockerLive),
    Layer.provide(Workerd.WorkerdLive),
  );
