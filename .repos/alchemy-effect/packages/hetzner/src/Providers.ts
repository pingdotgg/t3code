import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "alchemy/Website/Server";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { HetznerAuth } from "./AuthProvider.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import * as Credentials from "./Credentials.ts";
import {
  AdapterLive as DnsAdapterLive,
  RecordList as DnsRecordList,
  RecordListProvider as DnsRecordListProvider,
} from "./DNS.ts";
import { fromCredentials } from "./Environment.ts";
import { Firewall, FirewallProvider } from "./Firewall.ts";
import { FloatingIp, FloatingIpProvider } from "./FloatingIp.ts";
import { FloatingIpAssignment, FloatingIpAssignmentProvider } from "./FloatingIpAssignment.ts";
import { Image, ImageProvider } from "./Image.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import { MountVolumeLive } from "./MountVolume.ts";
import { Network, NetworkProvider } from "./Network.ts";
import { PlacementGroup, PlacementGroupProvider } from "./PlacementGroup.ts";
import { PrimaryIp, PrimaryIpProvider } from "./PrimaryIp.ts";
import { ReadDnsHttp } from "./ReadDnsHttp.ts";
import { ReadWriteDnsHttp } from "./ReadWriteDnsHttp.ts";
import { RecordSet, RecordSetProvider } from "./RecordSet.ts";
import { Server, ServerProvider } from "./Server.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { SshLive } from "./Ssh.ts";
import { SshKey, SshKeyProvider } from "./SshKey.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeAttachment, VolumeAttachmentProvider } from "./VolumeAttachment.ts";
import { WriteDnsHttp } from "./WriteDnsHttp.ts";
import { Zone, ZoneProvider } from "./Zone.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Hetzner") {}

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
 * import * as Hetzner from "@alchemy.run/hetzner";
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
      DnsRecordList,
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
        DnsRecordListProvider(),
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
    // `domain.dns: Hetzner.DNS.Adapter()` on any platform's custom domain.
    Layer.provideMerge(DnsAdapterLive),
    Layer.provideMerge(ReadDnsHttp),
    Layer.provideMerge(WriteDnsHttp),
    Layer.provideMerge(ReadWriteDnsHttp),
    Layer.provideMerge(SshLive),
    Layer.provideMerge(MountVolumeLive),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(HetznerAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
  );
