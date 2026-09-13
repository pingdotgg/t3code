import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import { RailwayAuth } from "./AuthProvider.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { CloudAgent, CloudAgentProvider } from "./CloudAgent.ts";
import * as Credentials from "./Credentials.ts";
import { DeleteObjectHttp } from "./DeleteObjectHttp.ts";
import { GetObjectHttp } from "./GetObjectHttp.ts";
import { HeadObjectHttp } from "./HeadObjectHttp.ts";
import { ListObjectsV2Http } from "./ListObjectsV2Http.ts";
import { PutObjectHttp } from "./PutObjectHttp.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { fromCredentials } from "./Environment.ts";
import { Function, FunctionProvider } from "./Function.ts";
import { Group, GroupProvider } from "./Group.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { Environment, EnvironmentProvider } from "./ProjectEnvironment.ts";
import { TcpProxy, TcpProxyProvider } from "./TcpProxy.ts";
import { Template, TemplateProvider } from "./Template.ts";
import { UsageLimit, UsageLimitProvider } from "./Usage.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { MountVolumeLive } from "./MountVolume.ts";
import { ConnectMongoHttp } from "./ConnectMongoHttp.ts";
import { ConnectMySQLHttp } from "./ConnectMySQLHttp.ts";
import { ConnectPostgresHttp } from "./ConnectPostgresHttp.ts";
import { Mongo, MongoProvider } from "./Mongo.ts";
import { MySQL, MySQLProvider } from "./MySQL.ts";
import { Postgres, PostgresProvider } from "./Postgres.ts";
import {
  PrivateNetwork,
  PrivateNetworkEndpoint,
  PrivateNetworkEndpointProvider,
  PrivateNetworkProvider,
} from "./PrivateNetwork.ts";
import { ReadRedisHttp } from "./ReadRedisHttp.ts";
import { ReadWriteRedisHttp } from "./ReadWriteRedisHttp.ts";
import { RailwayRetryPolicy } from "./RetryPolicy.ts";
import { Redis, RedisProvider } from "./Redis.ts";
import { Service } from "./Service.ts";
import { ServiceProvider } from "./ServiceProvider.ts";
import { Cdn, CdnProvider } from "./Website/Cdn.ts";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "../Website/Server.ts";
import { ExecHttp, Sandbox, SandboxProvider } from "./Sandbox.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeBackup, VolumeBackupProvider } from "./VolumeBackup.ts";
import { WriteRedisHttp } from "./WriteRedisHttp.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Railway",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers Railway resource providers, the Railway
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land. The collection starts empty so Project / Service agents can make a
 * single minimal insertion.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Railway from "alchemy/Railway";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Railway.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Postgres,
      PrivateNetwork,
      PrivateNetworkEndpoint,
      MySQL,
      Mongo,
      Cdn,
      CustomDomain,
      Environment,
      Function,
      Group,
      Service,
      TcpProxy,
      Template,
      UsageLimit,
      Variable,
      Volume,
      VolumeBackup,
      Redis,
      Bucket,
      CloudAgent,
      Sandbox,
      Random,
      WebsiteServer,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        PostgresProvider(),
        PrivateNetworkProvider(),
        PrivateNetworkEndpointProvider(),
        MySQLProvider(),
        MongoProvider(),
        CdnProvider(),
        CustomDomainProvider(),
        EnvironmentProvider(),
        FunctionProvider(),
        GroupProvider(),
        ServiceProvider(),
        TcpProxyProvider(),
        TemplateProvider(),
        UsageLimitProvider(),
        VariableProvider(),
        VolumeProvider(),
        VolumeBackupProvider(),
        RedisProvider(),
        BucketProvider(),
        CloudAgentProvider(),
        SandboxProvider(),
        RandomProvider(),
        WebsiteServerProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        MountVolumeLive,
        ConnectPostgresHttp,
        ConnectMySQLHttp,
        ConnectMongoHttp,
        PutObjectHttp,
        GetObjectHttp,
        DeleteObjectHttp,
        HeadObjectHttp,
        ListObjectsV2Http,
        ReadRedisHttp,
        WriteRedisHttp,
        ReadWriteRedisHttp,
        ExecHttp,
      ),
    ),
    Layer.provide(RailwayRetryPolicy),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(RailwayAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
  );
