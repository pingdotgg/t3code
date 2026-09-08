import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import * as Provider from "../Provider.ts";
import { HetznerAuth } from "./AuthProvider.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import * as Credentials from "./Credentials.ts";
import { fromCredentials } from "./Environment.ts";
import { Firewall, FirewallProvider } from "./Firewall.ts";
import { FloatingIp, FloatingIpProvider } from "./FloatingIp.ts";
import {
  FloatingIpAssignment,
  FloatingIpAssignmentProvider,
} from "./FloatingIpAssignment.ts";
import { Image, ImageProvider } from "./Image.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import { Network, NetworkProvider } from "./Network.ts";
import { PlacementGroup, PlacementGroupProvider } from "./PlacementGroup.ts";
import { PrimaryIp, PrimaryIpProvider } from "./PrimaryIp.ts";
import { ReadDnsHttp } from "./ReadDnsHttp.ts";
import { ReadWriteDnsHttp } from "./ReadWriteDnsHttp.ts";
import { MountVolumeLive } from "./MountVolume.ts";
import { RecordSet, RecordSetProvider } from "./RecordSet.ts";
import { Server, ServerProvider } from "./Server.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { SshLive } from "./Ssh.ts";
import { WriteDnsHttp } from "./WriteDnsHttp.ts";
import { SshKey, SshKeyProvider } from "./SshKey.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import {
  VolumeAttachment,
  VolumeAttachmentProvider,
} from "./VolumeAttachment.ts";
import { Zone, ZoneProvider } from "./Zone.ts";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "../Website/Server.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Hetzner",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Hetzner resource providers, the Hetzner
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Hetzner from "alchemy/Hetzner";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Hetzner.providers(),
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
      Certificate,
      Firewall,
      FloatingIp,
      FloatingIpAssignment,
      Image,
      LoadBalancer,
      Network,
      PlacementGroup,
      PrimaryIp,
      RecordSet,
      Server,
      Service,
      SshKey,
      Volume,
      VolumeAttachment,
      WebsiteServer,
      Zone,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        CertificateProvider(),
        FirewallProvider(),
        FloatingIpProvider(),
        FloatingIpAssignmentProvider(),
        ImageProvider(),
        LoadBalancerProvider(),
        NetworkProvider(),
        PlacementGroupProvider(),
        PrimaryIpProvider(),
        RecordSetProvider(),
        ServerProvider(),
        ServiceProvider(),
        SshKeyProvider(),
        VolumeProvider(),
        VolumeAttachmentProvider(),
        WebsiteServerProvider(),
        ZoneProvider(),
      ),
    ),
    Layer.provideMerge(ReadDnsHttp),
    Layer.provideMerge(WriteDnsHttp),
    Layer.provideMerge(ReadWriteDnsHttp),
    Layer.provideMerge(SshLive),
    Layer.provideMerge(MountVolumeLive),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(HetznerAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
  );
