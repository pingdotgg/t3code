import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import * as Provider from "../Provider.ts";
import { App, AppProvider } from "./App.ts";
import { FlyAuth } from "./AuthProvider.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { DeleteObjectHttp } from "./DeleteObjectHttp.ts";
import { GetObjectHttp } from "./GetObjectHttp.ts";
import { HeadObjectHttp } from "./HeadObjectHttp.ts";
import { ListObjectsV2Http } from "./ListObjectsV2Http.ts";
import { PutObjectHttp } from "./PutObjectHttp.ts";
import { ReadRedisHttp } from "./ReadRedisHttp.ts";
import { ReadWriteRedisHttp } from "./ReadWriteRedisHttp.ts";
import { WriteRedisHttp } from "./WriteRedisHttp.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { CheckpointHttp } from "./CheckpointHttp.ts";
import * as Credentials from "./Credentials.ts";
import { fromCredentials } from "./Environment.ts";
import { IpAssignment, IpAssignmentProvider } from "./IpAssignment.ts";
import { Machine, MachineProvider } from "./Machine.ts";
import { ConnectPostgresHttp } from "./ConnectPostgresHttp.ts";
import { Postgres, PostgresProvider } from "./Postgres.ts";
import { Redis, RedisProvider } from "./Redis.ts";
import { DecryptHttp } from "./DecryptHttp.ts";
import { EncryptHttp } from "./EncryptHttp.ts";
import { ExecHttp } from "./ExecHttp.ts";
import { GetSecretHttp } from "./GetSecretHttp.ts";
import { ListSecretsHttp } from "./ListSecretsHttp.ts";
import { MountVolumeLive } from "./MountVolume.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { SecretKey, SecretKeyProvider } from "./SecretKey.ts";
import { Service, ServiceProvider } from "./Service.ts";
import {
  AssetDeployment,
  AssetDeploymentProvider,
} from "./Website/AssetDeployment.ts";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "../Website/Server.ts";
import { SignHttp } from "./SignHttp.ts";
import { Sprite, SpriteProvider } from "./Sprite.ts";
import { VerifyHttp } from "./VerifyHttp.ts";
import { VolumeSnapshot, VolumeSnapshotProvider } from "./VolumeSnapshot.ts";
import { WriteSecretHttp } from "./WriteSecretHttp.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Fly",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers Fly resource providers, the Fly
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land. The collection starts empty so App / Machine / Service agents can
 * make a single minimal insertion.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Fly.providers(),
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
      App,
      AssetDeployment,
      Bucket,
      Certificate,
      IpAssignment,
      Machine,
      Postgres,
      Redis,
      Secret,
      SecretKey,
      Service,
      Sprite,
      VolumeSnapshot,
      WebsiteServer,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AppProvider(),
        AssetDeploymentProvider(),
        BucketProvider(),
        CertificateProvider(),
        IpAssignmentProvider(),
        MachineProvider(),
        PostgresProvider(),
        RedisProvider(),
        SecretProvider(),
        SecretKeyProvider(),
        ServiceProvider(),
        SpriteProvider(),
        VolumeSnapshotProvider(),
        WebsiteServerProvider(),
      ),
    ),
    // The binding layers are mutually independent — they all draw on the
    // Credentials/HttpClient layers below. Merge them into one group so
    // `.pipe` stays under its 20-argument overload ceiling.
    Layer.provideMerge(
      Layer.mergeAll(
        MountVolumeLive,
        ConnectPostgresHttp,
        PutObjectHttp,
        GetObjectHttp,
        DeleteObjectHttp,
        HeadObjectHttp,
        ListObjectsV2Http,
        ReadRedisHttp,
        WriteRedisHttp,
        ReadWriteRedisHttp,
        CheckpointHttp,
        ExecHttp,
        GetSecretHttp,
        ListSecretsHttp,
        WriteSecretHttp,
        EncryptHttp,
        DecryptHttp,
        SignHttp,
        VerifyHttp,
      ),
    ),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FlyAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
  );
