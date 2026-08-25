import { Retry } from "@distilled.cloud/cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import { DockerLive } from "../Docker/Docker.ts";
import { KeyPair, KeyPairProvider } from "../KeyPair.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as Access from "./Access.ts";
import * as AccessApp from "./Access/Application.ts";
import * as Bookmark from "./Access/Bookmark.ts";
import * as AccessCert from "./Access/Certificate.ts";
import * as CustomPage from "./Access/CustomPage.ts";
import * as Group from "./Access/Group.ts";
import * as AccessIdp from "./Access/IdentityProvider.ts";
import * as AccessInfraTarget from "./Access/InfrastructureTarget.ts";
import * as AccessKeyConfig from "./Access/KeyConfiguration.ts";
import * as McpPortal from "./Access/McpPortal.ts";
import * as AccessOrg from "./Access/Organization.ts";
import * as AccessPol from "./Access/Policy.ts";
import * as AccessSvcToken from "./Access/ServiceToken.ts";
import * as Tag from "./Access/Tag.ts";
import * as Account from "./Account/index.ts";
import * as Acm from "./Acm/index.ts";
import * as Addressing from "./Addressing/index.ts";
import * as AI from "./AI/index.ts";
import * as Alerting from "./Alerting/index.ts";
import * as ApiShield from "./ApiShield/index.ts";
import * as ApiToken from "./ApiToken/index.ts";
import * as Argo from "./Argo/index.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as BotManagement from "./BotManagement/index.ts";
import * as Cache from "./Cache/index.ts";
import * as Calls from "./Calls/index.ts";
import * as CertificateAuthorities from "./CertificateAuthorities/index.ts";
import * as ClientCertificate from "./ClientCertificate/index.ts";
import * as CloudConnector from "./CloudConnector/index.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as CloudforceOne from "./CloudforceOne/index.ts";
import * as Connectivity from "./Connectivity/index.ts";
import * as Containers from "./Containers/index.ts";
import * as ContentScanning from "./ContentScanning/index.ts";
import * as Credentials from "./Credentials.ts";
import * as CustomCertificates from "./CustomCertificate/index.ts";
import * as CustomHostnames from "./CustomHostname/index.ts";
import * as CustomNameservers from "./CustomNameserver/index.ts";
import * as D1 from "./D1/index.ts";
import * as DdosProtection from "./DdosProtection/index.ts";
import * as Devices from "./Devices/index.ts";
import * as Diagnostics from "./Diagnostics/index.ts";
import * as Dlp from "./Dlp/index.ts";
import * as Dns from "./DNS/index.ts";
import * as Email from "./Email/index.ts";
import * as Firewall from "./Firewall/index.ts";
import * as Flagship from "./Flagship/index.ts";
import * as Fraud from "./Fraud/index.ts";
import * as Certificate from "./Gateway/Certificate.ts";
import * as Configuration from "./Gateway/Configuration.ts";
import * as List from "./Gateway/List.ts";
import * as Location from "./Gateway/Location.ts";
import * as Logging from "./Gateway/Logging.ts";
import * as ProxyEndpoint from "./Gateway/ProxyEndpoint.ts";
import * as Rule from "./Gateway/Rule.ts";
import * as GoogleTagGateway from "./GoogleTagGateway/index.ts";
import * as Healthcheck from "./Healthcheck/index.ts";
import * as HostnameTlsSetting from "./HostnameTlsSetting/index.ts";
import * as Hyperdrive from "./Hyperdrive/index.ts";
import * as Iam from "./Iam/index.ts";
import * as Images from "./Images/index.ts";
import * as Intel from "./Intel/index.ts";
import * as KeylessCertificate from "./KeylessCertificate/index.ts";
import * as KV from "./KV/index.ts";
import * as LeakedCredentialCheck from "./LeakedCredentialCheck/index.ts";
import * as LoadBalancer from "./LoadBalancer/index.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import * as Logpush from "./Logpush/index.ts";
import * as LogsControl from "./LogsControl/index.ts";
import * as MagicCloudNetworking from "./MagicCloudNetworking/index.ts";
import * as MagicNetworkMonitoring from "./MagicNetworkMonitoring/index.ts";
import * as MagicTransit from "./MagicTransit/index.ts";
import * as ManagedTransforms from "./ManagedTransforms/index.ts";
import * as MtlsCertificate from "./MtlsCertificate/index.ts";
import * as NetworkInterconnects from "./NetworkInterconnects/index.ts";
import * as Organization from "./Organization/index.ts";
import * as OriginCaCertificate from "./OriginCaCertificate/index.ts";
import * as OriginPostQuantumEncryption from "./OriginPostQuantumEncryption/index.ts";
import * as OriginTlsClientAuth from "./OriginTlsClientAuth/index.ts";
import * as PageRule from "./PageRule/index.ts";
import * as Pages from "./Pages/index.ts";
import * as PageShield from "./PageShield/index.ts";
import * as Pipelines from "./Pipelines/index.ts";
import * as Queue from "./Queues/index.ts";
import * as R2 from "./R2/index.ts";
import * as RealtimeKit from "./RealtimeKit/index.ts";
import * as RegionalHostname from "./RegionalHostname/index.ts";
import * as Registrar from "./Registrar/index.ts";
import * as ResourceSharing from "./ResourceSharing/index.ts";
import * as RiskScoring from "./RiskScoring/index.ts";
import * as Rules from "./Rules/index.ts";
import * as Ruleset from "./Ruleset/index.ts";
import * as Rum from "./Rum/index.ts";
import * as SchemaValidation from "./SchemaValidation/index.ts";
import * as SecretsStore from "./SecretsStore/index.ts";
import * as SecurityTxt from "./SecurityTxt/index.ts";
import * as Snippets from "./Snippets/index.ts";
import * as Spectrum from "./Spectrum/index.ts";
import * as Speed from "./Speed/index.ts";
import * as Ssl from "./Ssl/index.ts";
import * as Stream from "./Stream/index.ts";
import * as Tags from "./Tags/index.ts";
import * as TokenValidation from "./TokenValidation/index.ts";
import * as Tunnel from "./Tunnel/index.ts";
import * as Turnstile from "./Turnstile/index.ts";
import * as UrlNorm from "./UrlNormalization/index.ts";
import * as Vectorize from "./Vectorize/index.ts";
import * as VpcService from "./VpcService/index.ts";
import * as VulnScanner from "./VulnerabilityScanner/index.ts";
import * as WaitingRoom from "./WaitingRoom/index.ts";
import * as Web3 from "./Web3/index.ts";
import * as Workers from "./Workers/index.ts";
import * as WorkersForPlatforms from "./WorkersForPlatforms/index.ts";
import * as Workflows from "./Workflows/Workflow.ts";
import * as Zaraz from "./Zaraz/index.ts";
import * as Zone from "./Zone/index.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Cloudflare",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Cloudflare providers, bindings, and credentials for Worker-based stacks.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      AccessApp.Application,
      AccessCert.Certificate,
      AccessIdp.IdentityProvider,
      AccessInfraTarget.InfrastructureTarget,
      AccessKeyConfig.KeyConfiguration,
      AccessOrg.Organization,
      AccessPol.Policy,
      AccessSvcToken.ServiceToken,
      Account.Account,
      Account.Member,
      Acm.CustomTrustStore,
      Acm.TotalTls,
      Addressing.AddressMap,
      Addressing.BgpPrefix,
      Addressing.Prefix,
      Addressing.PrefixDelegation,
      Addressing.ServiceBinding,
      AI.CustomTopics,
      AI.Dataset,
      AI.Evaluation,
      AI.Gateway,
      AI.GatewayDynamicRouting,
      AI.GatewayProvider,
      AI.SearchInstance,
      AI.SearchNamespace,
      AI.SearchToken,
      AI.SecuritySettings,
      Alerting.NotificationPolicy,
      Alerting.NotificationWebhook,
      Alerting.Silence,
      ApiShield.Configuration,
      ApiShield.Label,
      ApiShield.Operation,
      ApiShield.UserSchema,
      ApiToken.AccountApiToken,
      ApiToken.UserApiToken,
      Argo.SmartRouting,
      Argo.TieredCaching,
      Bookmark.Bookmark,
      BotManagement.BotManagement,
      Cache.OriginCloudRegion,
      Cache.RegionalTieredCache,
      Cache.Reserve,
      Cache.SmartTieredCache,
      Cache.Variants,
      Calls.App,
      Calls.TurnKey,
      Certificate.Certificate,
      CertificateAuthorities.HostnameAssociation,
      ClientCertificate.ClientCertificate,
      CloudConnector.Rules,
      CloudforceOne.ScanConfig,
      Configuration.Configuration,
      Connectivity.DirectoryService,
      Containers.ContainerPlatform,
      ContentScanning.ContentScanning,
      ContentScanning.Expression,
      CustomCertificates.CustomCertificate,
      CustomHostnames.CustomHostname,
      CustomHostnames.FallbackOrigin,
      CustomNameservers.CustomNameserver,
      CustomPage.CustomPage,
      D1.Database,
      DdosProtection.DdosAllowlistEntry,
      DdosProtection.SynProtectionFilter,
      DdosProtection.SynProtectionRule,
      DdosProtection.TcpFlowProtectionFilter,
      DdosProtection.TcpFlowProtectionRule,
      Devices.DeviceCustomProfile,
      Devices.DeviceDefaultProfile,
      Devices.DeviceDexTest,
      Devices.DeviceManagedNetwork,
      Devices.DevicePostureIntegration,
      Devices.DevicePostureRule,
      Devices.DeviceSettings,
      Diagnostics.EndpointHealthcheck,
      Dlp.Entry,
      Dlp.Profile,
      Dns.AccountDnsSettings,
      Dns.Dnssec,
      Dns.Firewall,
      Dns.Record,
      Dns.View,
      Dns.ZoneDnsSettings,
      Dns.ZoneTransferAcl,
      Dns.ZoneTransferIncoming,
      Dns.ZoneTransferOutgoing,
      Dns.ZoneTransferPeer,
      Dns.ZoneTransferTsig,
      Email.Address,
      Email.AllowPolicy,
      Email.BlockSender,
      Email.CatchAll,
      Email.Domain,
      Email.ImpersonationRegistryEntry,
      Email.Routing,
      Email.Rule,
      Email.SendingSubdomain,
      Email.TrustedDomain,
      Firewall.AccessRule,
      Firewall.Lockdown,
      Firewall.UaRule,
      Flagship.App,
      Flagship.Flag,
      Fraud.DetectionSettings,
      GoogleTagGateway.GoogleTagGateway,
      Group.Group,
      Healthcheck.Healthcheck,
      HostnameTlsSetting.HostnameTlsSetting,
      Hyperdrive.Connection,
      Iam.ResourceGroup,
      Iam.UserGroup,
      Iam.UserGroupMembership,
      Images.SigningKey,
      Images.Variant,
      Intel.IndicatorFeed,
      Intel.IndicatorFeedPermission,
      KeylessCertificate.KeylessCertificate,
      KeyPair,
      KV.Namespace,
      LeakedCredentialCheck.LeakedCredentialCheck,
      LeakedCredentialCheck.LeakedCredentialDetection,
      List.List,
      LoadBalancer.LoadBalancer,
      LoadBalancer.Monitor,
      LoadBalancer.MonitorGroup,
      LoadBalancer.Pool,
      Location.Location,
      Logging.Logging,
      Logpush.Job,
      LogsControl.CmbConfig,
      LogsControl.LogsRetentionFlag,
      MagicCloudNetworking.CatalogSync,
      MagicCloudNetworking.CloudIntegration,
      MagicCloudNetworking.OnRamp,
      MagicNetworkMonitoring.Config,
      MagicNetworkMonitoring.Rule,
      MagicTransit.GreTunnel,
      MagicTransit.IpsecTunnel,
      MagicTransit.MagicApp,
      MagicTransit.MagicSite,
      MagicTransit.MagicSiteAcl,
      MagicTransit.MagicSiteLan,
      MagicTransit.MagicSiteWan,
      MagicTransit.MagicStaticRoute,
      ManagedTransforms.ManagedTransforms,
      McpPortal.McpPortal,
      MtlsCertificate.MtlsCertificate,
      NetworkInterconnects.NetworkInterconnectSettings,
      Organization.Organization,
      OriginCaCertificate.OriginCaCertificate,
      OriginPostQuantumEncryption.OriginPostQuantumEncryption,
      OriginTlsClientAuth.Certificate,
      OriginTlsClientAuth.HostnameAssociation,
      OriginTlsClientAuth.HostnameCertificate,
      OriginTlsClientAuth.Setting,
      PageRule.PageRule,
      Pages.Deployment,
      Pages.Domain,
      Pages.Project,
      PageShield.Policy,
      PageShield.Settings,
      Pipelines.LegacyPipeline,
      Pipelines.Pipeline,
      Pipelines.Sink,
      Pipelines.Stream,
      ProxyEndpoint.ProxyEndpoint,
      Queue.Consumer,
      Queue.Queue,
      Queue.Subscription,
      R2.Bucket,
      R2.BucketEventNotification,
      R2.BucketSippy,
      R2.DataCatalog,
      Random,
      RealtimeKit.App,
      RealtimeKit.Preset,
      RealtimeKit.Webhook,
      RegionalHostname.RegionalHostname,
      Registrar.Domain,
      ResourceSharing.Share,
      ResourceSharing.ShareRecipient,
      ResourceSharing.ShareResource,
      RiskScoring.Integration,
      Rule.Rule,
      Rules.List,
      Ruleset.AccountEntrypoint,
      Ruleset.CustomRuleset,
      Ruleset.Ruleset,
      Rum.Rule,
      Rum.Site,
      SchemaValidation.OperationSetting,
      SchemaValidation.SchemaValidationSchema,
      SchemaValidation.Settings,
      SecretsStore.Secret,
      SecretsStore.Store,
      SecurityTxt.SecurityTxt,
      Snippets.Snippet,
      Snippets.SnippetRules,
      Spectrum.Application,
      Speed.TestSchedule,
      Ssl.CertificatePack,
      Ssl.UniversalSsl,
      Stream.LiveInput,
      Stream.LiveInputOutput,
      Stream.SigningKey,
      Stream.Watermark,
      Stream.Webhook,
      Tag.Tag,
      Tags.AccountResourceTags,
      Tags.ZoneResourceTags,
      TokenValidation.Rule,
      TokenValidation.TokenConfiguration,
      Tunnel.Configuration,
      Tunnel.HostnameRoute,
      Tunnel.Route,
      Tunnel.Tunnel,
      Tunnel.VirtualNetwork,
      Tunnel.WarpConnector,
      Turnstile.Widget,
      UrlNorm.UrlNormalization,
      Vectorize.Index,
      Vectorize.MetadataIndex,
      VpcService.VpcService,
      VulnScanner.VulnScannerCredential,
      VulnScanner.VulnScannerCredentialSet,
      VulnScanner.VulnScannerTargetEnvironment,
      WaitingRoom.Settings,
      WaitingRoom.WaitingRoom,
      Web3.Hostname,
      Web3.HostnameContentList,
      Workers.AccountSetting,
      Workers.ObservabilityDestination,
      Workers.Subdomain,
      Workers.Worker,
      Workers.WorkerRoute,
      WorkersForPlatforms.DispatchNamespace,
      Workflows.WorkflowResource,
      Zaraz.Config,
      Zone.CustomNameservers,
      Zone.Hold,
      Zone.Setting,
      Zone.Zone,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessApp.ApplicationProvider(),
        AccessApp.ApplicationProvider(),
        AccessCert.CertificateProvider(),
        AccessIdp.IdentityProviderProvider(),
        AccessInfraTarget.InfrastructureTargetProvider(),
        AccessKeyConfig.KeyConfigurationProvider(),
        AccessOrg.OrganizationProvider(),
        AccessOrg.OrganizationProvider(),
        AccessPol.PolicyProvider(),
        AccessPol.PolicyProvider(),
        AccessSvcToken.ServiceTokenProvider(),
        Account.AccountProvider(),
        Account.MemberProvider(),
        Acm.CustomTrustStoreProvider(),
        Acm.TotalTlsProvider(),
        Addressing.AddressMapProvider(),
        Addressing.BgpPrefixProvider(),
        Addressing.PrefixDelegationProvider(),
        Addressing.PrefixProvider(),
        Addressing.ServiceBindingProvider(),
        AI.CustomTopicsProvider(),
        AI.DatasetProvider(),
        AI.DynamicRoutingProvider(),
        AI.EvaluationProvider(),
        AI.GatewayProviderProvider(),
        AI.GatewayResourceProvider(),
        AI.SearchInstanceProvider(),
        AI.SearchNamespaceProvider(),
        AI.SearchTokenProvider(),
        AI.SecuritySettingsProvider(),
        Alerting.NotificationPolicyProvider(),
        Alerting.NotificationWebhookProvider(),
        Alerting.SilenceProvider(),
        ApiShield.ConfigurationProvider(),
        ApiShield.LabelProvider(),
        ApiShield.OperationProvider(),
        ApiShield.UserSchemaProvider(),
        ApiToken.AccountApiTokenProvider(),
        ApiToken.AccountApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        ApiToken.UserApiTokenProvider(),
        Argo.SmartRoutingProvider(),
        Argo.TieredCachingProvider(),
        Bookmark.BookmarkProvider(),
        BotManagement.BotManagementProvider(),
        Cache.OriginCloudRegionProvider(),
        Cache.RegionalTieredCacheProvider(),
        Cache.ReserveProvider(),
        Cache.SmartTieredCacheProvider(),
        Cache.VariantsProvider(),
        Calls.AppProvider(),
        Calls.TurnKeyProvider(),
        Certificate.CertificateProvider(),
        CertificateAuthorities.HostnameAssociationProvider(),
        ClientCertificate.ClientCertificateProvider(),
        CloudConnector.RulesProvider(),
        CloudforceOne.ScanConfigProvider(),
        Configuration.ConfigurationProvider(),
        Connectivity.DirectoryServiceProvider(),
        Containers.ContainerProvider(),
        Containers.ContainerProvider(),
        ContentScanning.ContentScanningProvider(),
        ContentScanning.ExpressionProvider(),
        CustomCertificates.CustomCertificateProvider(),
        CustomHostnames.CustomHostnameProvider(),
        CustomHostnames.FallbackOriginProvider(),
        CustomNameservers.CustomNameserverProvider(),
        CustomPage.CustomPageProvider(),
        D1.DatabaseProvider(),
        D1.DatabaseProvider(),
        DdosProtection.DdosAllowlistEntryProvider(),
        DdosProtection.SynProtectionFilterProvider(),
        DdosProtection.SynProtectionRuleProvider(),
        DdosProtection.TcpFlowProtectionFilterProvider(),
        DdosProtection.TcpFlowProtectionRuleProvider(),
        Devices.DeviceCustomProfileProvider(),
        Devices.DeviceDefaultProfileProvider(),
        Devices.DeviceDefaultProfileProvider(),
        Devices.DeviceDexTestProvider(),
        Devices.DeviceManagedNetworkProvider(),
        Devices.DevicePostureIntegrationProvider(),
        Devices.DevicePostureRuleProvider(),
        Devices.DeviceSettingsProvider(),

        // Split into nested groups: a single flat mergeAll with ~200
        // arguments exceeds tsc's variadic inference ceiling and
        // silently drops the tail layers from the inferred union.
        Layer.mergeAll(
          Diagnostics.EndpointHealthcheckProvider(),
          Dlp.EntryProvider(),
          Dlp.ProfileProvider(),
          Dns.AccountDnsSettingsProvider(),
          Dns.DnssecProvider(),
          Dns.FirewallProvider(),
          Dns.RecordProvider(),
          Dns.RecordProvider(),
          Dns.ViewProvider(),
          Dns.ZoneDnsSettingsProvider(),
          Dns.ZoneTransferAclProvider(),
          Dns.ZoneTransferIncomingProvider(),
          Dns.ZoneTransferOutgoingProvider(),
          Dns.ZoneTransferPeerProvider(),
          Dns.ZoneTransferTsigProvider(),
          Email.AddressProvider(),
          Email.AddressProvider(),
          Email.AllowPolicyProvider(),
          Email.BlockSenderProvider(),
          Email.CatchAllProvider(),
          Email.DomainProvider(),
          Email.ImpersonationRegistryEntryProvider(),
          Email.RoutingProvider(),
          Email.RoutingProvider(),
          Email.RuleProvider(),
          Email.RuleProvider(),
          Email.SendingSubdomainProvider(),
          Email.TrustedDomainProvider(),
          Firewall.AccessRuleProvider(),
          Firewall.LockdownProvider(),
          Firewall.UaRuleProvider(),
          Flagship.AppProvider(),
          Flagship.FlagProvider(),
          Fraud.DetectionSettingsProvider(),
          GoogleTagGateway.GoogleTagGatewayProvider(),
          Group.GroupProvider(),
          Healthcheck.HealthcheckProvider(),
          HostnameTlsSetting.HostnameTlsSettingProvider(),
          Hyperdrive.ConnectionProvider(),
          Hyperdrive.ConnectionProvider(),
          Iam.ResourceGroupProvider(),
          Iam.UserGroupMembershipProvider(),
          Iam.UserGroupProvider(),
          Images.SigningKeyProvider(),
          Images.VariantProvider(),
          Intel.IndicatorFeedPermissionProvider(),
          Intel.IndicatorFeedProvider(),
          KeylessCertificate.KeylessCertificateProvider(),
          KV.NamespaceProvider(),
          KV.NamespaceProvider(),
          LeakedCredentialCheck.LeakedCredentialCheckProvider(),
          LeakedCredentialCheck.LeakedCredentialDetectionProvider(),
          List.ListProvider(),
          Location.LocationProvider(),
          Logging.LoggingProvider(),
          Logpush.JobProvider(),
          LogsControl.CmbConfigProvider(),
          LogsControl.LogsRetentionFlagProvider(),
        ),
        Layer.mergeAll(
          MagicCloudNetworking.CatalogSyncProvider(),
          MagicCloudNetworking.CloudIntegrationProvider(),
          MagicCloudNetworking.OnRampProvider(),
          MagicNetworkMonitoring.ConfigProvider(),
          MagicNetworkMonitoring.RuleProvider(),
          MagicTransit.GreTunnelProvider(),
          MagicTransit.IpsecTunnelProvider(),
          MagicTransit.MagicAppProvider(),
          MagicTransit.MagicSiteAclProvider(),
          MagicTransit.MagicSiteLanProvider(),
          MagicTransit.MagicSiteProvider(),
          MagicTransit.MagicSiteWanProvider(),
          MagicTransit.MagicStaticRouteProvider(),
          ManagedTransforms.ManagedTransformsProvider(),
          McpPortal.McpPortalProvider(),
          MtlsCertificate.MtlsCertificateProvider(),
          NetworkInterconnects.NetworkInterconnectSettingsProvider(),
          Organization.OrganizationProvider(),
          OriginCaCertificate.OriginCaCertificateProvider(),
          OriginPostQuantumEncryption.OriginPostQuantumEncryptionProvider(),
          OriginTlsClientAuth.CertificateProvider(),
          OriginTlsClientAuth.HostnameAssociationProvider(),
          OriginTlsClientAuth.HostnameCertificateProvider(),
          OriginTlsClientAuth.SettingProvider(),
          PageRule.PageRuleProvider(),
          Pages.DeploymentProvider(),
          Pages.DomainProvider(),
          Pages.ProjectProvider(),
          PageShield.PolicyProvider(),
          PageShield.SettingsProvider(),
          Pipelines.LegacyPipelineProvider(),
          Pipelines.PipelineProvider(),
          Pipelines.SinkProvider(),
          Pipelines.StreamProvider(),
          ProxyEndpoint.ProxyEndpointProvider(),
          Queue.ConsumerProvider(),
          Queue.ConsumerProvider(),
          Queue.QueueProvider(),
          Queue.QueueProvider(),
          Queue.SubscriptionProvider(),
          R2.BucketEventNotificationProvider(),
          R2.BucketProvider(),
          R2.BucketProvider(),
          R2.BucketSippyProvider(),
          R2.DataCatalogProvider(),
          RealtimeKit.AppProvider(),
          RealtimeKit.PresetProvider(),
          RealtimeKit.WebhookProvider(),
          RegionalHostname.RegionalHostnameProvider(),
          Registrar.DomainProvider(),
          ResourceSharing.ShareProvider(),
          ResourceSharing.ShareRecipientProvider(),
          ResourceSharing.ShareResourceProvider(),
          RiskScoring.IntegrationProvider(),
          Rule.RuleProvider(),
          Rule.RuleProvider(),
          Rules.ListProvider(),
          Ruleset.AccountEntrypointProvider(),
          Ruleset.CustomRulesetProvider(),
          Ruleset.RulesetProvider(),
          Ruleset.RulesetProvider(),
          Rum.RuleProvider(),
          Rum.SiteProvider(),
          SchemaValidation.OperationSettingProvider(),
          SchemaValidation.SchemaProvider(),
          SchemaValidation.SettingsProvider(),
          SecretsStore.SecretsStoreProvider(),
          SecretsStore.SecretsStoreProvider(),
          SecretsStore.StoreSecretProvider(),
          SecretsStore.StoreSecretProvider(),
          SecurityTxt.SecurityTxtProvider(),
          Snippets.SnippetProvider(),
          Snippets.SnippetRulesProvider(),
          Spectrum.ApplicationProvider(),
          Speed.TestScheduleProvider(),
          Ssl.CertificatePackProvider(),
          Ssl.UniversalSslProvider(),
          Stream.LiveInputOutputProvider(),
          Stream.LiveInputProvider(),
          Stream.SigningKeyProvider(),
          Stream.WatermarkProvider(),
          Stream.WebhookProvider(),
          Tag.TagProvider(),
          Tags.AccountResourceTagsProvider(),
          Tags.ZoneResourceTagsProvider(),
          TokenValidation.RuleProvider(),
          TokenValidation.TokenConfigurationProvider(),
          Tunnel.ConfigurationProvider(),
          Tunnel.ConfigurationProvider(),
          Tunnel.HostnameRouteProvider(),
          Tunnel.RouteProvider(),
          Tunnel.RouteProvider(),
          Tunnel.TunnelProvider(),
          Tunnel.TunnelProvider(),
          Tunnel.VirtualNetworkProvider(),
          Tunnel.WarpConnectorProvider(),
        ),
        Layer.mergeAll(
          Turnstile.WidgetProvider(),
          UrlNorm.UrlNormalizationProvider(),
          Vectorize.IndexProvider(),
          Vectorize.IndexProvider(),
          Vectorize.MetadataIndexProvider(),
          Vectorize.MetadataIndexProvider(),
          VpcService.VpcServiceProvider(),
          VpcService.VpcServiceProvider(),
          VulnScanner.VulnScannerCredentialProvider(),
          VulnScanner.VulnScannerCredentialSetProvider(),
          VulnScanner.VulnScannerTargetEnvironmentProvider(),
          WaitingRoom.SettingsProvider(),
          WaitingRoom.WaitingRoomProvider(),
          Web3.HostnameContentListProvider(),
          Web3.HostnameProvider(),
          Workers.AccountSettingProvider(),
          Workers.ObservabilityDestinationProvider(),
          Workers.SubdomainProvider(),
          Workers.WorkerProvider(),
          Workers.WorkerProvider(),
          Workers.WorkerRouteProvider(),
          WorkersForPlatforms.DispatchNamespaceProvider(),
          Workflows.WorkflowProvider(),
          Workflows.WorkflowProvider(),
          Zaraz.ConfigProvider(),
          Zaraz.ConfigProvider(),
          Zone.CustomNameserversProvider(),
          Zone.HoldProvider(),
          Zone.SettingProvider(),
          Zone.ZoneProvider(),
          Zone.ZoneProvider(),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        LoadBalancer.LoadBalancerProvider(),
        LoadBalancer.MonitorProvider(),
        LoadBalancer.MonitorGroupProvider(),
        LoadBalancer.PoolProvider(),
        Command.providers(),
        KeyPairProvider(),
        RandomProvider(),
      ),
    ),
    Layer.provide(DockerLive),
    Layer.provideMerge(localRuntimeServices()),
    Layer.provideMerge(CloudflareApiLive()),
    Layer.orDie,
  );

/**
 * The foundation every effect tree that talks to the Cloudflare API
 * shares — credentials resolved through the Alchemy auth provider,
 * account environment, Access, profile + credential store — plus a
 * blanket retry policy applied to every Cloudflare API call.
 *
 * Used by {@link providers} and the Cloudflare state store
 * ({@link ../Cloudflare/StateStore/State.ts state}) so that provider
 * lifecycle operations and state-store init/bootstrap probes retry
 * transient failures the same way; without it the state-store
 * subdomain/script/secrets probes run on the SDK's shorter default
 * policy and surface throttling ("Please wait and consider throttling
 * your request speed") to users.
 *
 * The retry policy extends `Retry.makeDefault`'s transient detection
 * (throttling / 5xx / network) with Cloudflare-specific
 * misleadingly-tagged transient cases the SDK doesn't yet mark
 * retryable — see `cloudflareRetryFactory` below. Deliberately
 * narrow: we ONLY add cases where the message unambiguously indicates
 * a transient infrastructure failure (not a real auth/permission
 * failure). Auto-retrying ambiguous cases like `Unauthorized:
 * Authentication error` would silently loop on genuinely invalid
 * tokens.
 *
 * TODO(distilled): once
 * https://github.com/alchemy-run/distilled/pull/233 lands, the retry
 * wrapper can collapse back to `Retry.makeDefault`.
 */
export const CloudflareApiLive = () =>
  Credentials.fromAuthProvider().pipe(
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.provideMerge(Access.AccessLive),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(Layer.succeed(Retry.Retry, cloudflareRetryFactory)),
  );

const cloudflareRetryFactory: Retry.Factory = (lastError) => {
  const defaults = Retry.makeDefault(lastError);
  return {
    while: (error) =>
      defaults.while?.(error) === true || isMisleadinglyTaggedTransient(error),
    schedule: Schedule.max([
      pipe(
        Schedule.exponential(Duration.millis(250), 2),
        Schedule.modifyDelay(
          Effect.fn(function* ({ duration }) {
            const error = yield* Ref.get(lastError);
            // Throttling errors (429): honor a 500ms floor matching the
            // distilled default.
            const isThrottling =
              (error as { _tag?: unknown })?._tag === "TooManyRequests";
            if (isThrottling && Duration.toMillis(duration) < 500) {
              return Duration.toMillis(Duration.millis(500));
            }
            return Duration.toMillis(duration);
          }),
        ),
        Retry.capped(Duration.seconds(5)),
        Retry.jittered,
      ),
      Schedule.recurs(8),
    ]),
  };
};

const isMisleadinglyTaggedTransient = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const tag = (error as { _tag?: unknown })._tag;
  const message = ((error as { message?: unknown }).message ?? "") as string;
  // CF code 10001: "Method not allowed for token" is a real permission
  // failure (NOT retryable), but the same code is also returned with
  // message "internal error" during Cloudflare-side hiccups. The two
  // messages are unambiguously distinct, so we can safely retry only
  // the internal-error variant.
  if (tag === "Forbidden" && /internal error/i.test(message)) return true;
  // CF code 10001: "Unable to authenticate request" intermittently 403s
  // otherwise-valid, long-lived credentials during Cloudflare-side auth/edge
  // blips — it is transient, not a real credential problem (a genuinely
  // invalid/expired token surfaces as `Unauthorized: Authentication error`,
  // code 10000). The retry is bounded (see `cloudflareRetryFactory`), so even
  // a persistent auth failure that somehow used this message would just fail
  // fast after backoff rather than loop forever.
  if (tag === "Forbidden" && /unable to authenticate request/i.test(message))
    return true;
  // CF code 10000: "Authentication error" is a transient throttle Cloudflare
  // returns under high request concurrency — the same call against the same
  // zone succeeds in isolation (verified: an account whose zones are all
  // active and reachable still intermittently rejects with "Authentication
  // error" only when hundreds of calls fan out at once). It surfaces under
  // both a 403 (`Forbidden`) and a 401 (`Unauthorized`) tag depending on the
  // edge node. The retry is bounded (see `cloudflareRetryFactory`: ~8 tries,
  // capped 5s), so a genuinely invalid/expired token — which produces the same
  // message persistently — still fails fast after a few seconds of backoff
  // rather than looping forever; the win is that valid tokens stop flaking
  // under load.
  if (
    (tag === "Forbidden" || tag === "Unauthorized") &&
    /authentication error/i.test(message)
  ) {
    return true;
  }
  return false;
};
