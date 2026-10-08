import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Command from "../Command/index.ts";
import { DockerLive } from "../Docker/Docker.ts";
import * as Provider from "../Provider.ts";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "../Website/Server.ts";
import { GcpAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ListDockerImagesHttp } from "./ArtifactRegistry/ListDockerImagesHttp.ts";
import {
  Repository,
  RepositoryProvider,
} from "./ArtifactRegistry/Repository.ts";
import {
  RepositoriesAttachment,
  RepositoriesAttachmentProvider,
} from "./ArtifactRegistry/RepositoriesAttachment.ts";
import {
  RepositoriesPackagesTag,
  RepositoriesPackagesTagProvider,
} from "./ArtifactRegistry/RepositoriesPackagesTag.ts";
import {
  RepositoriesRule,
  RepositoriesRuleProvider,
} from "./ArtifactRegistry/RepositoriesRule.ts";
import {
  Certificate,
  CertificateProvider,
} from "./CertificateManager/Certificate.ts";
import {
  DnsAuthorization,
  DnsAuthorizationProvider,
} from "./CertificateManager/DnsAuthorization.ts";
import {
  CertificateMap,
  CertificateMapProvider,
} from "./CertificateManager/CertificateMap.ts";
import {
  CertificateMapEntry,
  CertificateMapEntryProvider,
} from "./CertificateManager/CertificateMapEntry.ts";
import {
  TrustConfig,
  TrustConfigProvider,
} from "./CertificateManager/TrustConfig.ts";
import {
  CertificateIssuanceConfig,
  CertificateIssuanceConfigProvider,
} from "./CertificateManager/CertificateIssuanceConfig.ts";
import { CaPool, CaPoolProvider } from "./PrivateCA/CaPool.ts";
import {
  CertificateAuthority,
  CertificateAuthorityProvider,
} from "./PrivateCA/CertificateAuthority.ts";
import {
  CertificateTemplate,
  CertificateTemplateProvider,
} from "./PrivateCA/CertificateTemplate.ts";
import { FetchCaCertsHttp } from "./PrivateCA/FetchCaCertsHttp.ts";
import { GetCertificateAuthorityHttp } from "./PrivateCA/GetCertificateAuthorityHttp.ts";
import { Dataset, DatasetProvider } from "./BigQuery/Dataset.ts";
import { InsertAllHttp } from "./BigQuery/InsertAllHttp.ts";
import {
  Job as BigQueryJob,
  JobProvider as BigQueryJobProvider,
} from "./BigQuery/Job.ts";
import { ListTabledataHttp } from "./BigQuery/ListTabledataHttp.ts";
import { QueryHttp } from "./BigQuery/QueryHttp.ts";
import { Routine, RoutineProvider } from "./BigQuery/Routine.ts";
import {
  RowAccessPolicy,
  RowAccessPolicyProvider,
} from "./BigQuery/RowAccessPolicy.ts";
import { Table, TableProvider } from "./BigQuery/Table.ts";
import {
  Catalog as BiglakeCatalog,
  CatalogProvider as BiglakeCatalogProvider,
} from "./BigLake/Catalog.ts";
import {
  CatalogsDatabase,
  CatalogsDatabaseProvider,
} from "./BigLake/CatalogsDatabase.ts";
import {
  CatalogsDatabasesTable,
  CatalogsDatabasesTableProvider,
} from "./BigLake/CatalogsDatabasesTable.ts";
import { StartManualRunsHttp } from "./BigQueryDataTransfer/StartManualRunsHttp.ts";
import {
  TransferConfig,
  TransferConfigProvider,
} from "./BigQueryDataTransfer/TransferConfig.ts";
import {
  BillingBudget,
  BillingBudgetProvider,
} from "./BillingBudgets/BillingBudget.ts";
import {
  Connection as BigQueryConnection,
  ConnectionProvider as BigQueryConnectionProvider,
} from "./BigQueryConnection/Connection.ts";
import { GetConnectionHttp as BigQueryGetConnectionHttp } from "./BigQueryConnection/GetConnectionHttp.ts";
import {
  Reservation,
  ReservationProvider,
} from "./BigQueryReservation/Reservation.ts";
import {
  CapacityCommitment,
  CapacityCommitmentProvider,
} from "./BigQueryReservation/CapacityCommitment.ts";
import {
  ReservationGroup,
  ReservationGroupProvider,
} from "./BigQueryReservation/ReservationGroup.ts";
import {
  DataPolicy,
  DataPolicyProvider,
} from "./BigQueryDataPolicy/DataPolicy.ts";
import { Channel, ChannelProvider } from "./Eventarc/Channel.ts";
import {
  ChannelConnection,
  ChannelConnectionProvider,
} from "./Eventarc/ChannelConnection.ts";
import { Enrollment, EnrollmentProvider } from "./Eventarc/Enrollment.ts";
import {
  GoogleApiSource,
  GoogleApiSourceProvider,
} from "./Eventarc/GoogleApiSource.ts";
import { MessageBus, MessageBusProvider } from "./Eventarc/MessageBus.ts";
import { Pipeline, PipelineProvider } from "./Eventarc/Pipeline.ts";
import { Trigger, TriggerProvider } from "./Eventarc/Trigger.ts";
import {
  Contact as EssentialcontactsContact,
  ContactProvider as EssentialcontactsContactProvider,
} from "./EssentialContacts/Contact.ts";
import {
  FolderContact,
  FolderContactProvider,
} from "./EssentialContacts/FolderContact.ts";
import {
  OrganizationContact,
  OrganizationContactProvider,
} from "./EssentialContacts/OrganizationContact.ts";
import {
  Connection as CloudBuildConnection,
  ConnectionProvider as CloudBuildConnectionProvider,
} from "./CloudBuild/Connection.ts";
import { AccessReadTokenHttp as CloudBuildAccessReadTokenHttp } from "./CloudBuild/AccessReadTokenHttp.ts";
import { AccessReadWriteTokenHttp as CloudBuildAccessReadWriteTokenHttp } from "./CloudBuild/AccessReadWriteTokenHttp.ts";
import { FetchGitRefsHttp as CloudBuildFetchGitRefsHttp } from "./CloudBuild/FetchGitRefsHttp.ts";
import {
  Repository as CloudBuildRepository,
  RepositoryProvider as CloudBuildRepositoryProvider,
} from "./CloudBuild/Repository.ts";
import {
  Function as CloudFunction,
  FunctionProvider,
} from "./CloudFunctions/Function.ts";
import { GenerateDownloadUrlHttp } from "./CloudFunctions/GenerateDownloadUrlHttp.ts";
import { GetFunctionHttp } from "./CloudFunctions/GetFunctionHttp.ts";
import { Job, JobProvider } from "./CloudScheduler/Job.ts";
import { PauseJobHttp } from "./CloudScheduler/PauseJobHttp.ts";
import { ResumeJobHttp } from "./CloudScheduler/ResumeJobHttp.ts";
import { RunJobHttp } from "./CloudScheduler/RunJobHttp.ts";
import { CreateTaskHttp } from "./CloudTasks/CreateTaskHttp.ts";
import {
  Environment as ComposerEnvironment,
  EnvironmentProvider as ComposerEnvironmentProvider,
} from "./Composer/Environment.ts";
import {
  EnvironmentsUserWorkloadsConfigMap,
  EnvironmentsUserWorkloadsConfigMapProvider,
} from "./Composer/EnvironmentsUserWorkloadsConfigMap.ts";
import {
  EnvironmentsUserWorkloadsSecret,
  EnvironmentsUserWorkloadsSecretProvider,
} from "./Composer/EnvironmentsUserWorkloadsSecret.ts";
import { ExecuteAirflowCommandHttp } from "./Composer/ExecuteAirflowCommandHttp.ts";
import { GetEnvironmentHttp } from "./Composer/GetEnvironmentHttp.ts";
import { GetUserWorkloadsConfigMapHttp } from "./Composer/GetUserWorkloadsConfigMapHttp.ts";
import { GetUserWorkloadsSecretHttp } from "./Composer/GetUserWorkloadsSecretHttp.ts";
import {
  Job as CloudRunJob,
  JobProvider as CloudRunJobProvider,
} from "./Run/Job.ts";
import { RunJobHttp as CloudRunRunJobHttp } from "./Run/RunJobHttp.ts";
import { GetServiceHttp } from "./Run/GetServiceHttp.ts";
import { GetWorkerPoolHttp } from "./Run/GetWorkerPoolHttp.ts";
import { Service, ServiceProvider } from "./Run/Service.ts";
import { WorkerPool, WorkerPoolProvider } from "./Run/WorkerPool.ts";
import { Queue, QueueProvider } from "./CloudTasks/Queue.ts";
import { Cluster, ClusterProvider } from "./Container/Cluster.ts";
import {
  ClustersNodePool,
  ClustersNodePoolProvider,
} from "./Container/ClustersNodePool.ts";
import { GetClusterHttp } from "./Container/GetClusterHttp.ts";
import { GetClustersNodePoolHttp } from "./Container/GetClustersNodePoolHttp.ts";
import { GkeKubernetesAdapter } from "./Container/KubernetesAdapter.ts";
import { GetNodePoolHttp } from "./Container/GetNodePoolHttp.ts";
import { NodePool, NodePoolProvider } from "./Container/NodePool.ts";
import {
  Note as ContaineranalysisNote,
  NoteProvider as ContaineranalysisNoteProvider,
} from "./ContainerAnalysis/Note.ts";
import {
  Occurrence as ContaineranalysisOccurrence,
  OccurrenceProvider as ContaineranalysisOccurrenceProvider,
} from "./ContainerAnalysis/Occurrence.ts";
import {
  LocationsNote,
  LocationsNoteProvider,
} from "./ContainerAnalysis/LocationsNote.ts";
import {
  LocationsOccurrence,
  LocationsOccurrenceProvider,
} from "./ContainerAnalysis/LocationsOccurrence.ts";
import { GetNoteHttp } from "./ContainerAnalysis/GetNoteHttp.ts";
import { GetOccurrenceHttp } from "./ContainerAnalysis/GetOccurrenceHttp.ts";
import {
  Attestor as BinaryauthorizationAttestor,
  AttestorProvider as BinaryauthorizationAttestorProvider,
} from "./BinaryAuthorization/Attestor.ts";
import {
  PlatformsPolicy,
  PlatformsPolicyProvider,
} from "./BinaryAuthorization/PlatformsPolicy.ts";
import { GetAttestorHttp } from "./BinaryAuthorization/GetAttestorHttp.ts";
import { GetPlatformsPolicyHttp } from "./BinaryAuthorization/GetPlatformsPolicyHttp.ts";
import { ValidateAttestationHttp } from "./BinaryAuthorization/ValidateAttestationHttp.ts";
import { EvaluateGkePolicyHttp } from "./BinaryAuthorization/EvaluateGkePolicyHttp.ts";
import {
  BlockchainNode,
  BlockchainNodeProvider,
} from "./BlockchainNodeEngine/BlockchainNode.ts";
import { Address, AddressProvider } from "./Compute/Address.ts";
import {
  RegionNetworkEndpointGroup,
  RegionNetworkEndpointGroupProvider,
} from "./Compute/RegionNetworkEndpointGroup.ts";
import { Disk, DiskProvider } from "./Compute/Disk.ts";
import { RegionDisk, RegionDiskProvider } from "./Compute/RegionDisk.ts";
import { Snapshot, SnapshotProvider } from "./Compute/Snapshot.ts";
import {
  GlobalAddress,
  GlobalAddressProvider,
} from "./Compute/GlobalAddress.ts";
import {
  BackendBucket,
  BackendBucketProvider,
} from "./Compute/BackendBucket.ts";
import {
  BackendService,
  BackendServiceProvider,
} from "./Compute/BackendService.ts";
import {
  RegionBackendService,
  RegionBackendServiceProvider,
} from "./Compute/RegionBackendService.ts";
import { HealthCheck, HealthCheckProvider } from "./Compute/HealthCheck.ts";
import {
  HttpHealthCheck,
  HttpHealthCheckProvider,
} from "./Compute/HttpHealthCheck.ts";
import {
  HttpsHealthCheck,
  HttpsHealthCheckProvider,
} from "./Compute/HttpsHealthCheck.ts";
import {
  CrossSiteNetwork,
  CrossSiteNetworkProvider,
} from "./Compute/CrossSiteNetwork.ts";
import {
  FutureReservation,
  FutureReservationProvider,
} from "./Compute/FutureReservation.ts";
import {
  GlobalPublicDelegatedPrefix,
  GlobalPublicDelegatedPrefixProvider,
} from "./Compute/GlobalPublicDelegatedPrefix.ts";
import {
  GlobalVmExtensionPolicy,
  GlobalVmExtensionPolicyProvider,
} from "./Compute/GlobalVmExtensionPolicy.ts";
import {
  InstanceGroupManagerResizeRequest,
  InstanceGroupManagerResizeRequestProvider,
} from "./Compute/InstanceGroupManagerResizeRequest.ts";
import {
  InstantSnapshot,
  InstantSnapshotProvider,
} from "./Compute/InstantSnapshot.ts";
import {
  InstantSnapshotGroup,
  InstantSnapshotGroupProvider,
} from "./Compute/InstantSnapshotGroup.ts";
import {
  RegionHealthCheck,
  RegionHealthCheckProvider,
} from "./Compute/RegionHealthCheck.ts";
import { Image, ImageProvider } from "./Compute/Image.ts";
import { MachineImage, MachineImageProvider } from "./Compute/MachineImage.ts";
import { Instance, InstanceProvider } from "./Compute/Instance.ts";
import { GetInstanceHttp } from "./Compute/GetInstanceHttp.ts";
import { StartInstanceHttp } from "./Compute/StartInstanceHttp.ts";
import { StopInstanceHttp } from "./Compute/StopInstanceHttp.ts";
import { Autoscaler, AutoscalerProvider } from "./Compute/Autoscaler.ts";
import {
  InstanceGroup,
  InstanceGroupProvider,
} from "./Compute/InstanceGroup.ts";
import {
  InstanceGroupManager,
  InstanceGroupManagerProvider,
} from "./Compute/InstanceGroupManager.ts";
import {
  InstanceTemplate,
  InstanceTemplateProvider,
} from "./Compute/InstanceTemplate.ts";
import {
  RegionInstanceGroupManager,
  RegionInstanceGroupManagerProvider,
} from "./Compute/RegionInstanceGroupManager.ts";
import { Network, NetworkProvider } from "./Compute/Network.ts";
import {
  NetworkEndpointGroup,
  NetworkEndpointGroupProvider,
} from "./Compute/NetworkEndpointGroup.ts";
import {
  GlobalNetworkEndpointGroup,
  GlobalNetworkEndpointGroupProvider,
} from "./Compute/GlobalNetworkEndpointGroup.ts";
import { Subnetwork, SubnetworkProvider } from "./Compute/Subnetwork.ts";
import { Firewall, FirewallProvider } from "./Compute/Firewall.ts";
import {
  FirewallPolicy,
  FirewallPolicyProvider,
} from "./Compute/FirewallPolicy.ts";
import {
  ForwardingRule,
  ForwardingRuleProvider,
} from "./Compute/ForwardingRule.ts";
import {
  PacketMirroring,
  PacketMirroringProvider,
} from "./Compute/PacketMirroring.ts";
import { Route, RouteProvider } from "./Compute/Route.ts";
import {
  ResourcePolicy,
  ResourcePolicyProvider,
} from "./Compute/ResourcePolicy.ts";
import {
  RegionAutoscaler,
  RegionAutoscalerProvider,
} from "./Compute/RegionAutoscaler.ts";
import {
  SecurityPolicy,
  SecurityPolicyProvider,
} from "./Compute/SecurityPolicy.ts";
import {
  OrganizationSecurityPolicy,
  OrganizationSecurityPolicyProvider,
} from "./Compute/OrganizationSecurityPolicy.ts";
import {
  PublicAdvertisedPrefix,
  PublicAdvertisedPrefixProvider,
} from "./Compute/PublicAdvertisedPrefix.ts";
import {
  PublicDelegatedPrefix,
  PublicDelegatedPrefixProvider,
} from "./Compute/PublicDelegatedPrefix.ts";
import {
  RegionBackendBucket,
  RegionBackendBucketProvider,
} from "./Compute/RegionBackendBucket.ts";
import {
  RegionCompositeHealthCheck,
  RegionCompositeHealthCheckProvider,
} from "./Compute/RegionCompositeHealthCheck.ts";
import {
  RegionHealthAggregationPolicy,
  RegionHealthAggregationPolicyProvider,
} from "./Compute/RegionHealthAggregationPolicy.ts";
import {
  RegionHealthCheckService,
  RegionHealthCheckServiceProvider,
} from "./Compute/RegionHealthCheckService.ts";
import {
  RegionHealthSource,
  RegionHealthSourceProvider,
} from "./Compute/RegionHealthSource.ts";
import {
  RegionInstanceGroupManagerResizeRequest,
  RegionInstanceGroupManagerResizeRequestProvider,
} from "./Compute/RegionInstanceGroupManagerResizeRequest.ts";
import {
  RegionInstanceTemplate,
  RegionInstanceTemplateProvider,
} from "./Compute/RegionInstanceTemplate.ts";
import {
  ServiceAttachment,
  ServiceAttachmentProvider,
} from "./Compute/ServiceAttachment.ts";
import { Interconnect, InterconnectProvider } from "./Compute/Interconnect.ts";
import {
  InterconnectAttachment,
  InterconnectAttachmentProvider,
} from "./Compute/InterconnectAttachment.ts";
import {
  InterconnectGroup,
  InterconnectGroupProvider,
} from "./Compute/InterconnectGroup.ts";
import {
  InterconnectAttachmentGroup,
  InterconnectAttachmentGroupProvider,
} from "./Compute/InterconnectAttachmentGroup.ts";
import { License, LicenseProvider } from "./Compute/License.ts";
import {
  NetworkAttachment,
  NetworkAttachmentProvider,
} from "./Compute/NetworkAttachment.ts";
import {
  NetworkEdgeSecurityService,
  NetworkEdgeSecurityServiceProvider,
} from "./Compute/NetworkEdgeSecurityService.ts";
import {
  NetworkFirewallPolicy,
  NetworkFirewallPolicyProvider,
} from "./Compute/NetworkFirewallPolicy.ts";
import { NodeGroup, NodeGroupProvider } from "./Compute/NodeGroup.ts";
import { NodeTemplate, NodeTemplateProvider } from "./Compute/NodeTemplate.ts";
import { Router, RouterProvider } from "./Compute/Router.ts";
import { UrlMap, UrlMapProvider } from "./Compute/UrlMap.ts";
import { RegionUrlMap, RegionUrlMapProvider } from "./Compute/RegionUrlMap.ts";
import {
  TargetHttpProxy,
  TargetHttpProxyProvider,
} from "./Compute/TargetHttpProxy.ts";
import {
  RegionTargetHttpProxy,
  RegionTargetHttpProxyProvider,
} from "./Compute/RegionTargetHttpProxy.ts";
import {
  TargetHttpsProxy,
  TargetHttpsProxyProvider,
} from "./Compute/TargetHttpsProxy.ts";
import {
  TargetInstance,
  TargetInstanceProvider,
} from "./Compute/TargetInstance.ts";
import { TargetPool, TargetPoolProvider } from "./Compute/TargetPool.ts";
import {
  TargetSslProxy,
  TargetSslProxyProvider,
} from "./Compute/TargetSslProxy.ts";
import {
  TargetTcpProxy,
  TargetTcpProxyProvider,
} from "./Compute/TargetTcpProxy.ts";
import {
  TargetGrpcProxy,
  TargetGrpcProxyProvider,
} from "./Compute/TargetGrpcProxy.ts";
import {
  GlobalForwardingRule,
  GlobalForwardingRuleProvider,
} from "./Compute/GlobalForwardingRule.ts";
import {
  SslCertificate,
  SslCertificateProvider,
} from "./Compute/SslCertificate.ts";
import { SslPolicy, SslPolicyProvider } from "./Compute/SslPolicy.ts";
import {
  RegionSslCertificate,
  RegionSslCertificateProvider,
} from "./Compute/RegionSslCertificate.ts";
import {
  RegionSslPolicy,
  RegionSslPolicyProvider,
} from "./Compute/RegionSslPolicy.ts";
import {
  RegionNetworkFirewallPolicy,
  RegionNetworkFirewallPolicyProvider,
} from "./Compute/RegionNetworkFirewallPolicy.ts";
import {
  RegionNotificationEndpoint,
  RegionNotificationEndpointProvider,
} from "./Compute/RegionNotificationEndpoint.ts";
import {
  RegionSecurityPolicy,
  RegionSecurityPolicyProvider,
} from "./Compute/RegionSecurityPolicy.ts";
import {
  RegionSnapshot,
  RegionSnapshotProvider,
} from "./Compute/RegionSnapshot.ts";
import {
  RegionInstantSnapshot,
  RegionInstantSnapshotProvider,
} from "./Compute/RegionInstantSnapshot.ts";
import {
  RegionInstantSnapshotGroup,
  RegionInstantSnapshotGroupProvider,
} from "./Compute/RegionInstantSnapshotGroup.ts";
import {
  RegionTargetHttpsProxy,
  RegionTargetHttpsProxyProvider,
} from "./Compute/RegionTargetHttpsProxy.ts";
import {
  RegionTargetTcpProxy,
  RegionTargetTcpProxyProvider,
} from "./Compute/RegionTargetTcpProxy.ts";
import { VpnGateway, VpnGatewayProvider } from "./Compute/VpnGateway.ts";
import {
  TargetVpnGateway,
  TargetVpnGatewayProvider,
} from "./Compute/TargetVpnGateway.ts";
import {
  ExternalVpnGateway,
  ExternalVpnGatewayProvider,
} from "./Compute/ExternalVpnGateway.ts";
import { VpnTunnel, VpnTunnelProvider } from "./Compute/VpnTunnel.ts";
import {
  Reservation as ComputeReservation,
  ReservationProvider as ComputeReservationProvider,
} from "./Compute/Reservation.ts";
import { RolloutPlan, RolloutPlanProvider } from "./Compute/RolloutPlan.ts";
import { StoragePool, StoragePoolProvider } from "./Compute/StoragePool.ts";
import { WireGroup, WireGroupProvider } from "./Compute/WireGroup.ts";
import {
  ZoneVmExtensionPolicy,
  ZoneVmExtensionPolicyProvider,
} from "./Compute/ZoneVmExtensionPolicy.ts";
import { ManagedZone, ManagedZoneProvider } from "./DNS/ManagedZone.ts";
import {
  Policy as DnsPolicy,
  PolicyProvider as DnsPolicyProvider,
} from "./DNS/Policy.ts";
import {
  ResourceRecordSet,
  ResourceRecordSetProvider,
} from "./DNS/ResourceRecordSet.ts";
import {
  ResponsePolicy,
  ResponsePolicyProvider,
} from "./DNS/ResponsePolicy.ts";
import {
  ResponsePolicyRule,
  ResponsePolicyRuleProvider,
} from "./DNS/ResponsePolicyRule.ts";
import { Database, DatabaseProvider } from "./Firestore/Database.ts";
import {
  DatabasesBackupSchedule,
  DatabasesBackupScheduleProvider,
} from "./Firestore/DatabasesBackupSchedule.ts";
import {
  DatabasesCollectionGroupsIndex,
  DatabasesCollectionGroupsIndexProvider,
} from "./Firestore/DatabasesCollectionGroupsIndex.ts";
import {
  DatabasesUserCred,
  DatabasesUserCredProvider,
} from "./Firestore/DatabasesUserCred.ts";
import { DeleteDocumentHttp } from "./Firestore/DeleteDocumentHttp.ts";
import { GetDocumentHttp } from "./Firestore/GetDocumentHttp.ts";
import { PatchDocumentHttp } from "./Firestore/PatchDocumentHttp.ts";
import {
  Backend as FirebaseapphostingBackend,
  BackendProvider as FirebaseapphostingBackendProvider,
} from "./FirebaseAppHosting/Backend.ts";
import {
  BackendsBuild,
  BackendsBuildProvider,
} from "./FirebaseAppHosting/BackendsBuild.ts";
import {
  BackendsDomain,
  BackendsDomainProvider,
} from "./FirebaseAppHosting/BackendsDomain.ts";
import {
  AppsDebugToken,
  AppsDebugTokenProvider,
} from "./FirebaseAppCheck/AppsDebugToken.ts";
import { ExchangeDebugTokenHttp } from "./FirebaseAppCheck/ExchangeDebugTokenHttp.ts";
import {
  ServicesResourcePolicy,
  ServicesResourcePolicyProvider,
} from "./FirebaseAppCheck/ServicesResourcePolicy.ts";
import {
  Group as FirebaseappdistributionGroup,
  GroupProvider as FirebaseappdistributionGroupProvider,
} from "./FirebaseAppDistribution/Group.ts";
import { ExecuteGraphqlHttp } from "./FirebaseDataConnect/ExecuteGraphqlHttp.ts";
import { ExecuteGraphqlReadHttp } from "./FirebaseDataConnect/ExecuteGraphqlReadHttp.ts";
import { ExecuteMutationHttp } from "./FirebaseDataConnect/ExecuteMutationHttp.ts";
import { ExecuteQueryHttp } from "./FirebaseDataConnect/ExecuteQueryHttp.ts";
import {
  Service as FirebasedataconnectService,
  ServiceProvider as FirebasedataconnectServiceProvider,
} from "./FirebaseDataConnect/Service.ts";
import {
  ServicesConnector,
  ServicesConnectorProvider,
} from "./FirebaseDataConnect/ServicesConnector.ts";
import {
  ServicesSchema,
  ServicesSchemaProvider,
} from "./FirebaseDataConnect/ServicesSchema.ts";
import {
  Release as FirebaserulesRelease,
  ReleaseProvider as FirebaserulesReleaseProvider,
} from "./FirebaseRules/Release.ts";
import {
  Ruleset as FirebaserulesRuleset,
  RulesetProvider as FirebaserulesRulesetProvider,
} from "./FirebaseRules/Ruleset.ts";
import { GetReleaseExecutableHttp } from "./FirebaseRules/GetReleaseExecutableHttp.ts";
import { TestRulesetHttp } from "./FirebaseRules/TestRulesetHttp.ts";
import { fromCredentials } from "./Environment.ts";
import { AcknowledgeHttp } from "./PubSub/AcknowledgeHttp.ts";
import { GetSchemaHttp } from "./PubSub/GetSchemaHttp.ts";
import { PublishHttp } from "./PubSub/PublishHttp.ts";
import { PullHttp } from "./PubSub/PullHttp.ts";
import { Schema, SchemaProvider } from "./PubSub/Schema.ts";
import {
  Snapshot as PubSubSnapshot,
  SnapshotProvider as PubSubSnapshotProvider,
} from "./PubSub/Snapshot.ts";
import { Subscription, SubscriptionProvider } from "./PubSub/Subscription.ts";
import { Topic, TopicProvider } from "./PubSub/Topic.ts";
import { ValidateMessageHttp } from "./PubSub/ValidateMessageHttp.ts";
import {
  AdminReservation,
  AdminReservationProvider,
} from "./PubSubLite/AdminReservation.ts";
import {
  AdminSubscription,
  AdminSubscriptionProvider,
} from "./PubSubLite/AdminSubscription.ts";
import { AdminTopic, AdminTopicProvider } from "./PubSubLite/AdminTopic.ts";
import { CommitCursorHttp } from "./PubSubLite/CommitCursorHttp.ts";
import { ComputeHeadCursorHttp } from "./PubSubLite/ComputeHeadCursorHttp.ts";
import { GetPartitionsHttp } from "./PubSubLite/GetPartitionsHttp.ts";
import { GetReservationHttp as GetPubsubliteReservationHttp } from "./PubSubLite/GetReservationHttp.ts";
import { GetSubscriptionHttp as GetPubsubliteSubscriptionHttp } from "./PubSubLite/GetSubscriptionHttp.ts";
import { GetTopicHttp as GetPubsubliteTopicHttp } from "./PubSubLite/GetTopicHttp.ts";
import { CryptoKey, CryptoKeyProvider } from "./KMS/CryptoKey.ts";
import {
  CryptoKeyVersion,
  CryptoKeyVersionProvider,
} from "./KMS/CryptoKeyVersion.ts";
import { DecryptHttp } from "./KMS/DecryptHttp.ts";
import { EncryptHttp } from "./KMS/EncryptHttp.ts";
import { ImportJob, ImportJobProvider } from "./KMS/ImportJob.ts";
import { KeyRing, KeyRingProvider } from "./KMS/KeyRing.ts";
import {
  SingleTenantHsmInstanceProposal,
  SingleTenantHsmInstanceProposalProvider,
} from "./KMS/SingleTenantHsmInstanceProposal.ts";
import { BucketsLink, BucketsLinkProvider } from "./Logging/BucketsLink.ts";
import { BucketsView, BucketsViewProvider } from "./Logging/BucketsView.ts";
import { Exclusion, ExclusionProvider } from "./Logging/Exclusion.ts";
import { LogBucket, LogBucketProvider } from "./Logging/LogBucket.ts";
import { LogScope, LogScopeProvider } from "./Logging/LogScope.ts";
import { Metric, MetricProvider } from "./Logging/Metric.ts";
import { SavedQuery, SavedQueryProvider } from "./Logging/SavedQuery.ts";
import { Sink, SinkProvider } from "./Logging/Sink.ts";
import {
  BillingBucket,
  BillingBucketProvider,
} from "./Logging/BillingBucket.ts";
import {
  BillingBucketsLink,
  BillingBucketsLinkProvider,
} from "./Logging/BillingBucketsLink.ts";
import {
  BillingBucketsView,
  BillingBucketsViewProvider,
} from "./Logging/BillingBucketsView.ts";
import {
  BillingExclusion,
  BillingExclusionProvider,
} from "./Logging/BillingExclusion.ts";
import {
  BillingSavedQuery,
  BillingSavedQueryProvider,
} from "./Logging/BillingSavedQuery.ts";
import { BillingSink, BillingSinkProvider } from "./Logging/BillingSink.ts";
import {
  FolderExclusion,
  FolderExclusionProvider,
} from "./Logging/FolderExclusion.ts";
import { FolderBucket, FolderBucketProvider } from "./Logging/FolderBucket.ts";
import {
  FolderBucketsLink,
  FolderBucketsLinkProvider,
} from "./Logging/FolderBucketsLink.ts";
import {
  FolderBucketsView,
  FolderBucketsViewProvider,
} from "./Logging/FolderBucketsView.ts";
import {
  FolderLogScope,
  FolderLogScopeProvider,
} from "./Logging/FolderLogScope.ts";
import {
  FolderSavedQuery,
  FolderSavedQueryProvider,
} from "./Logging/FolderSavedQuery.ts";
import { FolderSink, FolderSinkProvider } from "./Logging/FolderSink.ts";
import {
  LocationsBucket,
  LocationsBucketProvider,
} from "./Logging/LocationsBucket.ts";
import {
  LocationsBucketsLink,
  LocationsBucketsLinkProvider,
} from "./Logging/LocationsBucketsLink.ts";
import {
  LocationsBucketsView,
  LocationsBucketsViewProvider,
} from "./Logging/LocationsBucketsView.ts";
import {
  OrganizationExclusion,
  OrganizationExclusionProvider,
} from "./Logging/OrganizationExclusion.ts";
import {
  OrganizationLogBucket,
  OrganizationLogBucketProvider,
} from "./Logging/OrganizationLogBucket.ts";
import {
  OrganizationBucketsLink,
  OrganizationBucketsLinkProvider,
} from "./Logging/OrganizationBucketsLink.ts";
import {
  OrganizationBucketsView,
  OrganizationBucketsViewProvider,
} from "./Logging/OrganizationBucketsView.ts";
import {
  OrganizationLogScope,
  OrganizationLogScopeProvider,
} from "./Logging/OrganizationLogScope.ts";
import {
  OrganizationSavedQuery,
  OrganizationSavedQueryProvider,
} from "./Logging/OrganizationSavedQuery.ts";
import {
  OrganizationSink,
  OrganizationSinkProvider,
} from "./Logging/OrganizationSink.ts";
import { AccessSecretVersionHttp } from "./SecretManager/AccessSecretVersionHttp.ts";
import { AddSecretVersionHttp } from "./SecretManager/AddSecretVersionHttp.ts";
import {
  LocationsSecret,
  LocationsSecretProvider,
} from "./SecretManager/LocationsSecret.ts";
import { Secret, SecretProvider } from "./SecretManager/Secret.ts";
import { GetParameterHttp } from "./ParameterManager/GetParameterHttp.ts";
import { GetParameterVersionHttp } from "./ParameterManager/GetParameterVersionHttp.ts";
import { Parameter, ParameterProvider } from "./ParameterManager/Parameter.ts";
import {
  ParametersVersion,
  ParametersVersionProvider,
} from "./ParameterManager/ParametersVersion.ts";
import { RenderParameterVersionHttp } from "./ParameterManager/RenderParameterVersionHttp.ts";
import { TagValue, TagValueProvider } from "./ResourceManager/TagValue.ts";
import { Bucket, BucketProvider } from "./Storage/Bucket.ts";
import {
  BucketAccessControl,
  BucketAccessControlProvider,
} from "./Storage/BucketAccessControl.ts";
import {
  DefaultObjectAccessControl,
  DefaultObjectAccessControlProvider,
} from "./Storage/DefaultObjectAccessControl.ts";
import { Folder, FolderProvider } from "./Storage/Folder.ts";
import { HmacKey, HmacKeyProvider } from "./Storage/HmacKey.ts";
import { Managed, ManagedProvider } from "./Storage/Managed.ts";
import { Notification, NotificationProvider } from "./Storage/Notification.ts";
import {
  Object as StorageObject,
  ObjectProvider as StorageObjectProvider,
} from "./Storage/Object.ts";
import {
  ObjectAccessControl,
  ObjectAccessControlProvider,
} from "./Storage/ObjectAccessControl.ts";
import { DeleteObjectHttp } from "./Storage/DeleteObjectHttp.ts";
import { GetObjectHttp } from "./Storage/GetObjectHttp.ts";
import { PutObjectHttp } from "./Storage/PutObjectHttp.ts";
import { AgentPool, AgentPoolProvider } from "./StorageTransfer/AgentPool.ts";
import { GetGoogleServiceAccountHttp } from "./StorageTransfer/GetGoogleServiceAccountHttp.ts";
import { RunTransferJobHttp } from "./StorageTransfer/RunTransferJobHttp.ts";
import {
  TransferJob,
  TransferJobProvider,
} from "./StorageTransfer/TransferJob.ts";
import { GetAclPolicyHttp } from "./Redis/GetAclPolicyHttp.ts";
import { GetAuthStringHttp } from "./Redis/GetAuthStringHttp.ts";
import { GetInstanceHttp as GetRedisInstanceHttp } from "./Redis/GetInstanceHttp.ts";
import { ReadRedisHttp } from "./Redis/ReadRedisHttp.ts";
import { ReadWriteRedisHttp } from "./Redis/ReadWriteRedisHttp.ts";
import { WriteRedisHttp } from "./Redis/WriteRedisHttp.ts";
import { AclPolicy, AclPolicyProvider } from "./Redis/AclPolicy.ts";
import {
  Instance as RedisInstance,
  InstanceProvider as RedisInstanceProvider,
} from "./Redis/Instance.ts";
import { GetInstanceHttp as GetMemcacheInstanceHttp } from "./Memcache/GetInstanceHttp.ts";
import {
  Instance as MemcacheInstance,
  InstanceProvider as MemcacheInstanceProvider,
} from "./Memcache/Instance.ts";
import { GetModelHttp as GetMlModelHttp } from "./ML/GetModelHttp.ts";
import { GetVersionHttp as GetMlVersionHttp } from "./ML/GetVersionHttp.ts";
import {
  Model as MlModel,
  ModelProvider as MlModelProvider,
} from "./ML/Model.ts";
import { ModelsVersion, ModelsVersionProvider } from "./ML/ModelsVersion.ts";
import { PredictHttp as PredictMlHttp } from "./ML/PredictHttp.ts";
import { GetBackupHttp as GetFilestoreBackupHttp } from "./Filestore/GetBackupHttp.ts";
import { GetInstanceHttp as GetFilestoreInstanceHttp } from "./Filestore/GetInstanceHttp.ts";
import { GetInstancesSnapshotHttp as GetFilestoreInstancesSnapshotHttp } from "./Filestore/GetInstancesSnapshotHttp.ts";
import {
  Backup as FilestoreBackup,
  BackupProvider as FilestoreBackupProvider,
} from "./Filestore/Backup.ts";
import {
  Instance as FilestoreInstance,
  InstanceProvider as FilestoreInstanceProvider,
} from "./Filestore/Instance.ts";
import {
  InstancesSnapshot as FilestoreInstancesSnapshot,
  InstancesSnapshotProvider as FilestoreInstancesSnapshotProvider,
} from "./Filestore/InstancesSnapshot.ts";
import { GetNodeHttp as GetTpuNodeHttp } from "./TPU/GetNodeHttp.ts";
import { GetQueuedResourceHttp as GetTpuQueuedResourceHttp } from "./TPU/GetQueuedResourceHttp.ts";
import {
  Node as TpuNode,
  NodeProvider as TpuNodeProvider,
} from "./TPU/Node.ts";
import {
  QueuedResource as TpuQueuedResource,
  QueuedResourceProvider as TpuQueuedResourceProvider,
} from "./TPU/QueuedResource.ts";
import {
  ActiveDirectory as NetappActiveDirectory,
  ActiveDirectoryProvider as NetappActiveDirectoryProvider,
} from "./NetApp/ActiveDirectory.ts";
import {
  BackupPolicy as NetappBackupPolicy,
  BackupPolicyProvider as NetappBackupPolicyProvider,
} from "./NetApp/BackupPolicy.ts";
import {
  BackupVault as NetappBackupVault,
  BackupVaultProvider as NetappBackupVaultProvider,
} from "./NetApp/BackupVault.ts";
import {
  BackupVaultsBackup as NetappBackupVaultsBackup,
  BackupVaultsBackupProvider as NetappBackupVaultsBackupProvider,
} from "./NetApp/BackupVaultsBackup.ts";
import {
  HostGroup as NetappHostGroup,
  HostGroupProvider as NetappHostGroupProvider,
} from "./NetApp/HostGroup.ts";
import {
  KmsConfig as NetappKmsConfig,
  KmsConfigProvider as NetappKmsConfigProvider,
} from "./NetApp/KmsConfig.ts";
import {
  StoragePool as NetappStoragePool,
  StoragePoolProvider as NetappStoragePoolProvider,
} from "./NetApp/StoragePool.ts";
import {
  Volume as NetappVolume,
  VolumeProvider as NetappVolumeProvider,
} from "./NetApp/Volume.ts";
import {
  VolumesQuotaRule as NetappVolumesQuotaRule,
  VolumesQuotaRuleProvider as NetappVolumesQuotaRuleProvider,
} from "./NetApp/VolumesQuotaRule.ts";
import { GetInstanceHttp as GetSpannerInstanceHttp } from "./Spanner/GetInstanceHttp.ts";
import { ExecuteSqlHttp as SpannerExecuteSqlHttp } from "./Spanner/ExecuteSqlHttp.ts";
import { GetDdlHttp as SpannerGetDdlHttp } from "./Spanner/GetDdlHttp.ts";
import {
  Database as SpannerDatabase,
  DatabaseProvider as SpannerDatabaseProvider,
} from "./Spanner/Database.ts";
import {
  Instance as SpannerInstance,
  InstanceProvider as SpannerInstanceProvider,
} from "./Spanner/Instance.ts";
import {
  InstanceConfig as SpannerInstanceConfig,
  InstanceConfigProvider as SpannerInstanceConfigProvider,
} from "./Spanner/InstanceConfig.ts";
import {
  InstancesBackup as SpannerInstancesBackup,
  InstancesBackupProvider as SpannerInstancesBackupProvider,
} from "./Spanner/InstancesBackup.ts";
import {
  InstancesDatabasesBackupSchedule as SpannerInstancesDatabasesBackupSchedule,
  InstancesDatabasesBackupScheduleProvider as SpannerInstancesDatabasesBackupScheduleProvider,
} from "./Spanner/InstancesDatabasesBackupSchedule.ts";
import {
  InstancesInstancePartition as SpannerInstancesInstancePartition,
  InstancesInstancePartitionProvider as SpannerInstancesInstancePartitionProvider,
} from "./Spanner/InstancesInstancePartition.ts";
import { GetClusterHttp as GetAlloyDbClusterHttp } from "./AlloyDB/GetClusterHttp.ts";
import { GetConnectionInfoHttp as GetAlloyDbConnectionInfoHttp } from "./AlloyDB/GetConnectionInfoHttp.ts";
import { GetInstanceHttp as GetAlloyDbInstanceHttp } from "./AlloyDB/GetInstanceHttp.ts";
import { GetBackupHttp as GetAlloyDbBackupHttp } from "./AlloyDB/GetBackupHttp.ts";
import { GetUserHttp as GetAlloyDbUserHttp } from "./AlloyDB/GetUserHttp.ts";
import {
  Cluster as AlloyDbCluster,
  ClusterProvider as AlloyDbClusterProvider,
} from "./AlloyDB/Cluster.ts";
import {
  Instance as AlloyDbInstance,
  InstanceProvider as AlloyDbInstanceProvider,
} from "./AlloyDB/Instance.ts";
import {
  Backup as AlloyDbBackup,
  BackupProvider as AlloyDbBackupProvider,
} from "./AlloyDB/Backup.ts";
import {
  ClustersUser as AlloyDbClustersUser,
  ClustersUserProvider as AlloyDbClustersUserProvider,
} from "./AlloyDB/ClustersUser.ts";
import {
  GoldengateDeployment,
  GoldengateDeploymentProvider,
} from "./OracleDatabase/GoldengateDeployment.ts";
import { OdbNetwork, OdbNetworkProvider } from "./OracleDatabase/OdbNetwork.ts";
import {
  OdbNetworksOdbSubnet,
  OdbNetworksOdbSubnetProvider,
} from "./OracleDatabase/OdbNetworksOdbSubnet.ts";
import {
  AutonomousDatabase,
  AutonomousDatabaseProvider,
} from "./OracleDatabase/AutonomousDatabase.ts";
import {
  CloudExadataInfrastructure,
  CloudExadataInfrastructureProvider,
} from "./OracleDatabase/CloudExadataInfrastructure.ts";
import {
  CloudVmCluster,
  CloudVmClusterProvider,
} from "./OracleDatabase/CloudVmCluster.ts";
import { DbSystem, DbSystemProvider } from "./OracleDatabase/DbSystem.ts";
import {
  ExadbVmCluster,
  ExadbVmClusterProvider,
} from "./OracleDatabase/ExadbVmCluster.ts";
import {
  ExascaleDbStorageVault,
  ExascaleDbStorageVaultProvider,
} from "./OracleDatabase/ExascaleDbStorageVault.ts";
import {
  GoldengateConnection,
  GoldengateConnectionProvider,
} from "./OracleDatabase/GoldengateConnection.ts";
import {
  GoldengateConnectionAssignment,
  GoldengateConnectionAssignmentProvider,
} from "./OracleDatabase/GoldengateConnectionAssignment.ts";
import { GetAutonomousDatabaseHttp } from "./OracleDatabase/GetAutonomousDatabaseHttp.ts";
import { GenerateWalletHttp } from "./OracleDatabase/GenerateWalletHttp.ts";
import { StartAutonomousDatabaseHttp } from "./OracleDatabase/StartAutonomousDatabaseHttp.ts";
import { StopAutonomousDatabaseHttp } from "./OracleDatabase/StopAutonomousDatabaseHttp.ts";
import { RestartAutonomousDatabaseHttp } from "./OracleDatabase/RestartAutonomousDatabaseHttp.ts";
import { GetCloudExadataInfrastructureHttp } from "./OracleDatabase/GetCloudExadataInfrastructureHttp.ts";
import { GetCloudVmClusterHttp } from "./OracleDatabase/GetCloudVmClusterHttp.ts";
import { GetDbSystemHttp } from "./OracleDatabase/GetDbSystemHttp.ts";
import { GetExadbVmClusterHttp } from "./OracleDatabase/GetExadbVmClusterHttp.ts";
import { GetExascaleDbStorageVaultHttp } from "./OracleDatabase/GetExascaleDbStorageVaultHttp.ts";
import { GetGoldengateConnectionHttp } from "./OracleDatabase/GetGoldengateConnectionHttp.ts";
import { GetGoldengateConnectionAssignmentHttp } from "./OracleDatabase/GetGoldengateConnectionAssignmentHttp.ts";
import { GetGoldengateDeploymentHttp } from "./OracleDatabase/GetGoldengateDeploymentHttp.ts";
import { GetOdbNetworkHttp } from "./OracleDatabase/GetOdbNetworkHttp.ts";
import { GetOdbNetworksOdbSubnetHttp } from "./OracleDatabase/GetOdbNetworksOdbSubnetHttp.ts";
import { GetInstanceHttp as GetBigtableInstanceHttp } from "./Bigtable/GetInstanceHttp.ts";
import { GetClusterHttp as GetBigtableClusterHttp } from "./Bigtable/GetClusterHttp.ts";
import { GetTableHttp as GetBigtableTableHttp } from "./Bigtable/GetTableHttp.ts";
import {
  AppProfile as BigtableAppProfile,
  AppProfileProvider as BigtableAppProfileProvider,
} from "./Bigtable/AppProfile.ts";
import {
  Cluster as BigtableCluster,
  ClusterProvider as BigtableClusterProvider,
} from "./Bigtable/Cluster.ts";
import {
  Instance as BigtableInstance,
  InstanceProvider as BigtableInstanceProvider,
} from "./Bigtable/Instance.ts";
import {
  Table as BigtableTable,
  TableProvider as BigtableTableProvider,
} from "./Bigtable/Table.ts";
import {
  InstancesClustersBackup as BigtableInstancesClustersBackup,
  InstancesClustersBackupProvider as BigtableInstancesClustersBackupProvider,
} from "./Bigtable/InstancesClustersBackup.ts";
import {
  InstancesLogicalView as BigtableInstancesLogicalView,
  InstancesLogicalViewProvider as BigtableInstancesLogicalViewProvider,
} from "./Bigtable/InstancesLogicalView.ts";
import {
  InstancesMaterializedView as BigtableInstancesMaterializedView,
  InstancesMaterializedViewProvider as BigtableInstancesMaterializedViewProvider,
} from "./Bigtable/InstancesMaterializedView.ts";
import {
  InstancesTablesAuthorizedView as BigtableInstancesTablesAuthorizedView,
  InstancesTablesAuthorizedViewProvider as BigtableInstancesTablesAuthorizedViewProvider,
} from "./Bigtable/InstancesTablesAuthorizedView.ts";
import {
  InstancesTablesSchemaBundle as BigtableInstancesTablesSchemaBundle,
  InstancesTablesSchemaBundleProvider as BigtableInstancesTablesSchemaBundleProvider,
} from "./Bigtable/InstancesTablesSchemaBundle.ts";
import {
  Cluster as DataprocCluster,
  ClusterProvider as DataprocClusterProvider,
} from "./Dataproc/Cluster.ts";
import {
  AutoscalingPolicy as DataprocAutoscalingPolicy,
  AutoscalingPolicyProvider as DataprocAutoscalingPolicyProvider,
} from "./Dataproc/AutoscalingPolicy.ts";
import {
  Batch as DataprocBatche,
  BatchProvider as DataprocBatcheProvider,
} from "./Dataproc/Batch.ts";
import {
  RegionsAutoscalingPolicy as DataprocRegionsAutoscalingPolicy,
  RegionsAutoscalingPolicyProvider as DataprocRegionsAutoscalingPolicyProvider,
} from "./Dataproc/RegionsAutoscalingPolicy.ts";
import {
  RegionsWorkflowTemplate as DataprocRegionsWorkflowTemplate,
  RegionsWorkflowTemplateProvider as DataprocRegionsWorkflowTemplateProvider,
} from "./Dataproc/RegionsWorkflowTemplate.ts";
import {
  Session as DataprocSession,
  SessionProvider as DataprocSessionProvider,
} from "./Dataproc/Session.ts";
import {
  SessionTemplate as DataprocSessionTemplate,
  SessionTemplateProvider as DataprocSessionTemplateProvider,
} from "./Dataproc/SessionTemplate.ts";
import {
  WorkflowTemplate as DataprocWorkflowTemplate,
  WorkflowTemplateProvider as DataprocWorkflowTemplateProvider,
} from "./Dataproc/WorkflowTemplate.ts";
import { AspectType, AspectTypeProvider } from "./Dataplex/AspectType.ts";
import {
  DataAttributeBinding,
  DataAttributeBindingProvider,
} from "./Dataplex/DataAttributeBinding.ts";
import { DataDomain, DataDomainProvider } from "./Dataplex/DataDomain.ts";
import {
  DataDomainsBinding,
  DataDomainsBindingProvider,
} from "./Dataplex/DataDomainsBinding.ts";
import { DataProduct, DataProductProvider } from "./Dataplex/DataProduct.ts";
import {
  DataProductsDataAsset,
  DataProductsDataAssetProvider,
} from "./Dataplex/DataProductsDataAsset.ts";
import { DataScan, DataScanProvider } from "./Dataplex/DataScan.ts";
import {
  EncryptionConfig,
  EncryptionConfigProvider,
} from "./Dataplex/EncryptionConfig.ts";
import { DataTaxonomy, DataTaxonomyProvider } from "./Dataplex/DataTaxonomy.ts";
import {
  DataTaxonomiesAttribute,
  DataTaxonomiesAttributeProvider,
} from "./Dataplex/DataTaxonomiesAttribute.ts";
import { EntryGroup, EntryGroupProvider } from "./Dataplex/EntryGroup.ts";
import {
  EntryGroupsEntry,
  EntryGroupsEntryProvider,
} from "./Dataplex/EntryGroupsEntry.ts";
import {
  EntryGroupsEntryLink,
  EntryGroupsEntryLinkProvider,
} from "./Dataplex/EntryGroupsEntryLink.ts";
import { EntryType, EntryTypeProvider } from "./Dataplex/EntryType.ts";
import { Glossary, GlossaryProvider } from "./Dataplex/Glossary.ts";
import {
  GlossariesCategory,
  GlossariesCategoryProvider,
} from "./Dataplex/GlossariesCategory.ts";
import {
  GlossariesTerm,
  GlossariesTermProvider,
} from "./Dataplex/GlossariesTerm.ts";
import { Lake, LakeProvider } from "./Dataplex/Lake.ts";
import { LakesTask, LakesTaskProvider } from "./Dataplex/LakesTask.ts";
import { LakesZone, LakesZoneProvider } from "./Dataplex/LakesZone.ts";
import { LakesAsset, LakesAssetProvider } from "./Dataplex/LakesAsset.ts";
import { LakesEntity, LakesEntityProvider } from "./Dataplex/LakesEntity.ts";
import {
  LakesEntitiesPartition,
  LakesEntitiesPartitionProvider,
} from "./Dataplex/LakesEntitiesPartition.ts";
import { MetadataFeed, MetadataFeedProvider } from "./Dataplex/MetadataFeed.ts";
import { TagTemplate, TagTemplateProvider } from "./DataCatalog/TagTemplate.ts";
import { Taxonomy, TaxonomyProvider } from "./DataCatalog/Taxonomy.ts";
import {
  TaxonomiesPolicyTag,
  TaxonomiesPolicyTagProvider,
} from "./DataCatalog/TaxonomiesPolicyTag.ts";
import { GetClusterHttp as GetDataprocClusterHttp } from "./Dataproc/GetClusterHttp.ts";
import { SubmitJobHttp as DataprocSubmitJobHttp } from "./Dataproc/SubmitJobHttp.ts";
import { ExecuteSqlHttp } from "./SQL/ExecuteSqlHttp.ts";
import { GetInstanceHttp as GetSqlInstanceHttp } from "./SQL/GetInstanceHttp.ts";
import { GetUserHttp as GetSqlUserHttp } from "./SQL/GetUserHttp.ts";
import {
  Database as SqlDatabase,
  DatabaseProvider as SqlDatabaseProvider,
} from "./SQL/Database.ts";
import {
  Instance as SqlInstance,
  InstanceProvider as SqlInstanceProvider,
} from "./SQL/Instance.ts";
import {
  SslCert as SqlSslCert,
  SslCertProvider as SqlSslCertProvider,
} from "./SQL/SslCert.ts";
import {
  User as SqlUser,
  UserProvider as SqlUserProvider,
} from "./SQL/User.ts";
import {
  Backup as SqlBackupBackup,
  BackupProvider as SqlBackupBackupProvider,
} from "./SQL/Backup.ts";
import {
  BackupRun as SqlBackupRun,
  BackupRunProvider as SqlBackupRunProvider,
} from "./SQL/BackupRun.ts";
import { Connector, ConnectorProvider } from "./VpcAccess/Connector.ts";
import {
  Connection,
  ConnectionProvider,
} from "./ServiceNetworking/Connection.ts";
import { CreateExecutionHttp } from "./Workflows/CreateExecutionHttp.ts";
import { Workflow, WorkflowProvider } from "./Workflows/Workflow.ts";
import { CreateJobHttp } from "./Transcoder/CreateJobHttp.ts";
import { JobTemplate, JobTemplateProvider } from "./Transcoder/JobTemplate.ts";
import { Namespace, NamespaceProvider } from "./ServiceDirectory/Namespace.ts";
import {
  Service as ServiceDirectoryService,
  ServiceProvider as ServiceDirectoryServiceProvider,
} from "./ServiceDirectory/Service.ts";
import {
  Endpoint as ServiceDirectoryEndpoint,
  EndpointProvider as ServiceDirectoryEndpointProvider,
} from "./ServiceDirectory/Endpoint.ts";
import { GetEndpointHttp as ServiceDirectoryGetEndpointHttp } from "./ServiceDirectory/GetEndpointHttp.ts";
import { ResolveHttp as ServiceDirectoryResolveHttp } from "./ServiceDirectory/ResolveHttp.ts";
import {
  Service as ServicemanagementService,
  ServiceProvider as ServicemanagementServiceProvider,
} from "./ServiceManagement/Service.ts";
import { TagKey, TagKeyProvider } from "./ResourceManager/TagKey.ts";
import {
  TagBinding,
  TagBindingProvider,
} from "./ResourceManager/TagBinding.ts";
import {
  Folder as ResourceManagerFolder,
  FolderProvider as ResourceManagerFolderProvider,
} from "./ResourceManager/Folder.ts";
import { Lien, LienProvider } from "./ResourceManager/Lien.ts";
import {
  Project as ResourceManagerProject,
  ProjectProvider as ResourceManagerProjectProvider,
} from "./ResourceManager/Project.ts";
import { Key, KeyProvider } from "./ApiKeys/Key.ts";
import { GetKeyStringHttp } from "./ApiKeys/GetKeyStringHttp.ts";
import {
  Key as RecaptchaenterpriseKey,
  KeyProvider as RecaptchaenterpriseKeyProvider,
} from "./RecaptchaEnterprise/Key.ts";
import {
  Firewallpolicy as RecaptchaenterpriseFirewallpolicy,
  FirewallpolicyProvider as RecaptchaenterpriseFirewallpolicyProvider,
} from "./RecaptchaEnterprise/Firewallpolicy.ts";
import { CreateAssessmentHttp as RecaptchaenterpriseCreateAssessmentHttp } from "./RecaptchaEnterprise/CreateAssessmentHttp.ts";
import {
  Binding as AgentregistryBinding,
  BindingProvider as AgentregistryBindingProvider,
} from "./AgentRegistry/Binding.ts";
import { Policy, PolicyProvider } from "./OrgPolicy/Policy.ts";
import {
  CustomConstraint,
  CustomConstraintProvider,
} from "./OrgPolicy/CustomConstraint.ts";
import {
  FoldersLocationsGlobalPolicyOrchestrator,
  FoldersLocationsGlobalPolicyOrchestratorProvider,
} from "./OSConfig/FoldersLocationsGlobalPolicyOrchestrator.ts";
import {
  OrganizationsLocationsGlobalPolicyOrchestrator,
  OrganizationsLocationsGlobalPolicyOrchestratorProvider,
} from "./OSConfig/OrganizationsLocationsGlobalPolicyOrchestrator.ts";
import {
  ProjectsLocationsGlobalPolicyOrchestrator,
  ProjectsLocationsGlobalPolicyOrchestratorProvider,
} from "./OSConfig/ProjectsLocationsGlobalPolicyOrchestrator.ts";
import {
  AccessPolicy,
  AccessPolicyProvider,
} from "./AccessContextManager/AccessPolicy.ts";
import {
  AccessPoliciesAccessLevel,
  AccessPoliciesAccessLevelProvider,
} from "./AccessContextManager/AccessPoliciesAccessLevel.ts";
import {
  AccessPoliciesAuthorizedOrgsDesc,
  AccessPoliciesAuthorizedOrgsDescProvider,
} from "./AccessContextManager/AccessPoliciesAuthorizedOrgsDesc.ts";
import {
  AccessPoliciesServicePerimeter,
  AccessPoliciesServicePerimeterProvider,
} from "./AccessContextManager/AccessPoliciesServicePerimeter.ts";
import {
  GcpUserAccessBinding,
  GcpUserAccessBindingProvider,
} from "./AccessContextManager/GcpUserAccessBinding.ts";
import { Hub, HubProvider } from "./NetworkConnectivity/Hub.ts";
import { Spoke, SpokeProvider } from "./NetworkConnectivity/Spoke.ts";
import {
  InternalRange,
  InternalRangeProvider,
} from "./NetworkConnectivity/InternalRange.ts";
import {
  PolicyBasedRoute,
  PolicyBasedRouteProvider,
} from "./NetworkConnectivity/PolicyBasedRoute.ts";
import {
  Transport,
  TransportProvider,
} from "./NetworkConnectivity/Transport.ts";
import {
  AutomatedDnsRecord,
  AutomatedDnsRecordProvider,
} from "./NetworkConnectivity/AutomatedDnsRecord.ts";
import {
  MulticloudDataTransferConfig,
  MulticloudDataTransferConfigProvider,
} from "./NetworkConnectivity/MulticloudDataTransferConfig.ts";
import {
  MulticloudDataTransferConfigsDestination,
  MulticloudDataTransferConfigsDestinationProvider,
} from "./NetworkConnectivity/MulticloudDataTransferConfigsDestination.ts";
import {
  RegionalEndpoint,
  RegionalEndpointProvider,
} from "./NetworkConnectivity/RegionalEndpoint.ts";
import {
  ServiceConnectionMap,
  ServiceConnectionMapProvider,
} from "./NetworkConnectivity/ServiceConnectionMap.ts";
import {
  ServiceConnectionPolicy,
  ServiceConnectionPolicyProvider,
} from "./NetworkConnectivity/ServiceConnectionPolicy.ts";
import {
  ServiceConnectionToken,
  ServiceConnectionTokenProvider,
} from "./NetworkConnectivity/ServiceConnectionToken.ts";
import {
  SpokesGatewayAdvertisedRoute,
  SpokesGatewayAdvertisedRouteProvider,
} from "./NetworkConnectivity/SpokesGatewayAdvertisedRoute.ts";
import {
  VpcFlowLogsConfig,
  VpcFlowLogsConfigProvider,
} from "./NetworkManagement/VpcFlowLogsConfig.ts";
import {
  OrganizationsVpcFlowLogsConfig,
  OrganizationsVpcFlowLogsConfigProvider,
} from "./NetworkManagement/OrganizationsVpcFlowLogsConfig.ts";
import {
  ConnectivityTest,
  ConnectivityTestProvider,
} from "./NetworkManagement/ConnectivityTest.ts";
import {
  NetworkMonitoringProvider,
  NetworkMonitoringProviderProvider,
} from "./NetworkManagement/NetworkMonitoringProvider.ts";
import {
  ClientTlsPolicy,
  ClientTlsPolicyProvider,
} from "./NetworkSecurity/ClientTlsPolicy.ts";
import {
  DnsThreatDetector,
  DnsThreatDetectorProvider,
} from "./NetworkSecurity/DnsThreatDetector.ts";
import {
  FirewallEndpoint,
  FirewallEndpointProvider,
} from "./NetworkSecurity/FirewallEndpoint.ts";
import {
  FirewallEndpointAssociation,
  FirewallEndpointAssociationProvider,
} from "./NetworkSecurity/FirewallEndpointAssociation.ts";
import {
  GatewaySecurityPolicy,
  GatewaySecurityPolicyProvider,
} from "./NetworkSecurity/GatewaySecurityPolicy.ts";
import {
  GatewaySecurityPoliciesRule,
  GatewaySecurityPoliciesRuleProvider,
} from "./NetworkSecurity/GatewaySecurityPoliciesRule.ts";
import {
  InterceptDeploymentGroup,
  InterceptDeploymentGroupProvider,
} from "./NetworkSecurity/InterceptDeploymentGroup.ts";
import {
  InterceptDeployment,
  InterceptDeploymentProvider,
} from "./NetworkSecurity/InterceptDeployment.ts";
import {
  InterceptEndpointGroup,
  InterceptEndpointGroupProvider,
} from "./NetworkSecurity/InterceptEndpointGroup.ts";
import {
  InterceptEndpointGroupAssociation,
  InterceptEndpointGroupAssociationProvider,
} from "./NetworkSecurity/InterceptEndpointGroupAssociation.ts";
import {
  MirroringDeploymentGroup,
  MirroringDeploymentGroupProvider,
} from "./NetworkSecurity/MirroringDeploymentGroup.ts";
import {
  MirroringDeployment,
  MirroringDeploymentProvider,
} from "./NetworkSecurity/MirroringDeployment.ts";
import {
  MirroringEndpointGroup,
  MirroringEndpointGroupProvider,
} from "./NetworkSecurity/MirroringEndpointGroup.ts";
import {
  MirroringEndpointGroupAssociation,
  MirroringEndpointGroupAssociationProvider,
} from "./NetworkSecurity/MirroringEndpointGroupAssociation.ts";
import { SacRealm, SacRealmProvider } from "./NetworkSecurity/SacRealm.ts";
import {
  SacAttachment,
  SacAttachmentProvider,
} from "./NetworkSecurity/SacAttachment.ts";
import {
  SecurityProfile,
  SecurityProfileProvider,
} from "./NetworkSecurity/SecurityProfile.ts";
import {
  SecurityProfileGroup,
  SecurityProfileGroupProvider,
} from "./NetworkSecurity/SecurityProfileGroup.ts";
import {
  ServerTlsPolicy,
  ServerTlsPolicyProvider,
} from "./NetworkSecurity/ServerTlsPolicy.ts";
import {
  TlsInspectionPolicy,
  TlsInspectionPolicyProvider,
} from "./NetworkSecurity/TlsInspectionPolicy.ts";
import { UrlList, UrlListProvider } from "./NetworkSecurity/UrlList.ts";
import {
  AddressGroup,
  AddressGroupProvider,
} from "./NetworkSecurity/AddressGroup.ts";
import {
  AuthorizationPolicy,
  AuthorizationPolicyProvider,
} from "./NetworkSecurity/AuthorizationPolicy.ts";
import {
  AuthzPolicy,
  AuthzPolicyProvider,
} from "./NetworkSecurity/AuthzPolicy.ts";
import {
  BackendAuthenticationConfig,
  BackendAuthenticationConfigProvider,
} from "./NetworkSecurity/BackendAuthenticationConfig.ts";
import {
  OrganizationsAddressGroup,
  OrganizationsAddressGroupProvider,
} from "./NetworkSecurity/OrganizationsAddressGroup.ts";
import {
  OrganizationsFirewallEndpoint,
  OrganizationsFirewallEndpointProvider,
} from "./NetworkSecurity/OrganizationsFirewallEndpoint.ts";
import {
  OrganizationsSecurityProfile,
  OrganizationsSecurityProfileProvider,
} from "./NetworkSecurity/OrganizationsSecurityProfile.ts";
import {
  OrganizationsSecurityProfileGroup,
  OrganizationsSecurityProfileGroupProvider,
} from "./NetworkSecurity/OrganizationsSecurityProfileGroup.ts";
import {
  AgentGateway,
  AgentGatewayProvider,
} from "./NetworkServices/AgentGateway.ts";
import {
  AuthzExtension,
  AuthzExtensionProvider,
} from "./NetworkServices/AuthzExtension.ts";
import {
  EndpointPolicy,
  EndpointPolicyProvider,
} from "./NetworkServices/EndpointPolicy.ts";
import {
  Gateway as NetworkservicesGateway,
  GatewayProvider as NetworkservicesGatewayProvider,
} from "./NetworkServices/Gateway.ts";
import { GrpcRoute, GrpcRouteProvider } from "./NetworkServices/GrpcRoute.ts";
import { HttpRoute, HttpRouteProvider } from "./NetworkServices/HttpRoute.ts";
import {
  LbEdgeExtension,
  LbEdgeExtensionProvider,
} from "./NetworkServices/LbEdgeExtension.ts";
import {
  LbRouteExtension,
  LbRouteExtensionProvider,
} from "./NetworkServices/LbRouteExtension.ts";
import {
  WasmPlugin,
  WasmPluginProvider,
} from "./NetworkServices/WasmPlugin.ts";
import {
  WasmPluginsVersion,
  WasmPluginsVersionProvider,
} from "./NetworkServices/WasmPluginsVersion.ts";
import {
  LbTrafficExtension,
  LbTrafficExtensionProvider,
} from "./NetworkServices/LbTrafficExtension.ts";
import { Mesh, MeshProvider } from "./NetworkServices/Mesh.ts";
import {
  MulticastConsumerAssociation,
  MulticastConsumerAssociationProvider,
} from "./NetworkServices/MulticastConsumerAssociation.ts";
import {
  MulticastGroupConsumerActivation,
  MulticastGroupConsumerActivationProvider,
} from "./NetworkServices/MulticastGroupConsumerActivation.ts";
import {
  ServiceBinding,
  ServiceBindingProvider,
} from "./NetworkServices/ServiceBinding.ts";
import {
  ServiceLbPolicy,
  ServiceLbPolicyProvider,
} from "./NetworkServices/ServiceLbPolicy.ts";
import { TcpRoute, TcpRouteProvider } from "./NetworkServices/TcpRoute.ts";
import { TlsRoute, TlsRouteProvider } from "./NetworkServices/TlsRoute.ts";
import { AlertPolicy, AlertPolicyProvider } from "./Monitoring/AlertPolicy.ts";
import {
  NotificationChannel,
  NotificationChannelProvider,
} from "./Monitoring/NotificationChannel.ts";
import {
  UptimeCheckConfig,
  UptimeCheckConfigProvider,
} from "./Monitoring/UptimeCheckConfig.ts";
import {
  Group as MonitoringGroup,
  GroupProvider as MonitoringGroupProvider,
} from "./Monitoring/Group.ts";
import {
  MetricDescriptor,
  MetricDescriptorProvider,
} from "./Monitoring/MetricDescriptor.ts";
import {
  Service as MonitoringService,
  ServiceProvider as MonitoringServiceProvider,
} from "./Monitoring/Service.ts";
import {
  ServicesServiceLevelObjective,
  ServicesServiceLevelObjectiveProvider,
} from "./Monitoring/ServicesServiceLevelObjective.ts";
import { TraceScope, TraceScopeProvider } from "./Observability/TraceScope.ts";
import {
  BucketsDatasetsLink,
  BucketsDatasetsLinkProvider,
} from "./Observability/BucketsDatasetsLink.ts";
import {
  TrainingPipeline,
  TrainingPipelineProvider,
} from "./AIPlatform/TrainingPipeline.ts";
import {
  Dataset as AIPlatformDataset,
  DatasetProvider as AIPlatformDatasetProvider,
} from "./AIPlatform/Dataset.ts";
import {
  DatasetsDatasetVersion,
  DatasetsDatasetVersionProvider,
} from "./AIPlatform/DatasetsDatasetVersion.ts";
import {
  ReasoningEngine,
  ReasoningEngineProvider,
} from "./AIPlatform/ReasoningEngine.ts";
import {
  ReasoningEnginesSandboxEnvironmentTemplate,
  ReasoningEnginesSandboxEnvironmentTemplateProvider,
} from "./AIPlatform/ReasoningEnginesSandboxEnvironmentTemplate.ts";
import {
  ReasoningEnginesSandboxEnvironment,
  ReasoningEnginesSandboxEnvironmentProvider,
} from "./AIPlatform/ReasoningEnginesSandboxEnvironment.ts";
import { CancelTrainingPipelineHttp } from "./AIPlatform/CancelTrainingPipelineHttp.ts";
import { GenerateContentHttp } from "./AIPlatform/GenerateContentHttp.ts";
import { GetReasoningEngineHttp } from "./AIPlatform/GetReasoningEngineHttp.ts";
import { GetSandboxEnvironmentHttp } from "./AIPlatform/GetSandboxEnvironmentHttp.ts";
import { GetSandboxEnvironmentTemplateHttp } from "./AIPlatform/GetSandboxEnvironmentTemplateHttp.ts";
import { GetTrainingPipelineHttp } from "./AIPlatform/GetTrainingPipelineHttp.ts";
import { PauseSandboxEnvironmentHttp } from "./AIPlatform/PauseSandboxEnvironmentHttp.ts";
import { QueryReasoningEngineHttp } from "./AIPlatform/QueryReasoningEngineHttp.ts";
import { ResumeSandboxEnvironmentHttp } from "./AIPlatform/ResumeSandboxEnvironmentHttp.ts";
import {
  ReasoningEnginesSession,
  ReasoningEnginesSessionProvider,
} from "./AIPlatform/ReasoningEnginesSession.ts";
import { Schedule, ScheduleProvider } from "./AIPlatform/Schedule.ts";
import {
  SemanticGovernancePolicy,
  SemanticGovernancePolicyProvider,
} from "./AIPlatform/SemanticGovernancePolicy.ts";
import {
  SpecialistPool,
  SpecialistPoolProvider,
} from "./AIPlatform/SpecialistPool.ts";
import { Study, StudyProvider } from "./AIPlatform/Study.ts";
import {
  StudiesTrial,
  StudiesTrialProvider,
} from "./AIPlatform/StudiesTrial.ts";
import { Tensorboard, TensorboardProvider } from "./AIPlatform/Tensorboard.ts";
import {
  TensorboardsExperiment,
  TensorboardsExperimentProvider,
} from "./AIPlatform/TensorboardsExperiment.ts";
import {
  TensorboardsExperimentsRun,
  TensorboardsExperimentsRunProvider,
} from "./AIPlatform/TensorboardsExperimentsRun.ts";
import {
  TensorboardsExperimentsRunsTimeSeries,
  TensorboardsExperimentsRunsTimeSeriesProvider,
} from "./AIPlatform/TensorboardsExperimentsRunsTimeSeries.ts";
import {
  AnalysisRule,
  AnalysisRuleProvider,
} from "./ContactCenterInsights/AnalysisRule.ts";
import {
  AssessmentRule,
  AssessmentRuleProvider,
} from "./ContactCenterInsights/AssessmentRule.ts";
import {
  AuthorizedViewSet,
  AuthorizedViewSetProvider,
} from "./ContactCenterInsights/AuthorizedViewSet.ts";
import {
  AuthorizedViewSetsAuthorizedView,
  AuthorizedViewSetsAuthorizedViewProvider,
} from "./ContactCenterInsights/AuthorizedViewSetsAuthorizedView.ts";
import {
  AuthorizedViewSetsAuthorizedViewsConversationsAssessment,
  AuthorizedViewSetsAuthorizedViewsConversationsAssessmentProvider,
} from "./ContactCenterInsights/AuthorizedViewSetsAuthorizedViewsConversationsAssessment.ts";
import {
  AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel,
  AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelProvider,
} from "./ContactCenterInsights/AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel.ts";
import {
  AutoLabelingRule,
  AutoLabelingRuleProvider,
} from "./ContactCenterInsights/AutoLabelingRule.ts";
import {
  Conversation,
  ConversationProvider,
} from "./ContactCenterInsights/Conversation.ts";
import {
  ConversationsAnalyses,
  ConversationsAnalysesProvider,
} from "./ContactCenterInsights/ConversationsAnalyses.ts";
import {
  ConversationsAssessment,
  ConversationsAssessmentProvider,
} from "./ContactCenterInsights/ConversationsAssessment.ts";
import {
  ConversationsFeedbackLabel,
  ConversationsFeedbackLabelProvider,
} from "./ContactCenterInsights/ConversationsFeedbackLabel.ts";
import {
  Dashboard,
  DashboardProvider,
} from "./ContactCenterInsights/Dashboard.ts";
import {
  DashboardsChart,
  DashboardsChartProvider,
} from "./ContactCenterInsights/DashboardsChart.ts";
import {
  DatasetsConversationsFeedbackLabel,
  DatasetsConversationsFeedbackLabelProvider,
} from "./ContactCenterInsights/DatasetsConversationsFeedbackLabel.ts";
import {
  IssueModel,
  IssueModelProvider,
} from "./ContactCenterInsights/IssueModel.ts";
import {
  IssueModelsIssue,
  IssueModelsIssueProvider,
} from "./ContactCenterInsights/IssueModelsIssue.ts";
import {
  PhraseMatcher,
  PhraseMatcherProvider,
} from "./ContactCenterInsights/PhraseMatcher.ts";
import {
  QaQuestionTag,
  QaQuestionTagProvider,
} from "./ContactCenterInsights/QaQuestionTag.ts";
import {
  QaScorecard,
  QaScorecardProvider,
} from "./ContactCenterInsights/QaScorecard.ts";
import {
  QaScorecardsRevision,
  QaScorecardsRevisionProvider,
} from "./ContactCenterInsights/QaScorecardsRevision.ts";
import {
  QaScorecardsRevisionsQaQuestion,
  QaScorecardsRevisionsQaQuestionProvider,
} from "./ContactCenterInsights/QaScorecardsRevisionsQaQuestion.ts";
import { View, ViewProvider } from "./ContactCenterInsights/View.ts";
import {
  ContactCenter,
  ContactCenterProvider,
} from "./ContactCenterAIPlatform/ContactCenter.ts";
import {
  Domain as GmailpostmastertoolsDomain,
  DomainProvider as GmailpostmastertoolsDomainProvider,
} from "./GmailPostmasterTools/Domain.ts";
import {
  DomainsUser,
  DomainsUserProvider,
} from "./GmailPostmasterTools/DomainsUser.ts";
import {
  SettingsDatasource,
  SettingsDatasourceProvider,
} from "./CloudSearch/SettingsDatasource.ts";
import {
  SettingsSearchapplication,
  SettingsSearchapplicationProvider,
} from "./CloudSearch/SettingsSearchapplication.ts";
import {
  SupportEventSubscription,
  SupportEventSubscriptionProvider,
} from "./CloudSupport/SupportEventSubscription.ts";
import { Matter, MatterProvider } from "./Vault/Matter.ts";
import { MattersExport, MattersExportProvider } from "./Vault/MattersExport.ts";
import { MattersHold, MattersHoldProvider } from "./Vault/MattersHold.ts";
import {
  MattersSavedQuery,
  MattersSavedQueryProvider,
} from "./Vault/MattersSavedQuery.ts";
import {
  Subscription as WorkspaceeventsSubscription,
  SubscriptionProvider as WorkspaceeventsSubscriptionProvider,
} from "./WorkspaceEvents/Subscription.ts";
import {
  TasksPushNotificationConfig,
  TasksPushNotificationConfigProvider,
} from "./WorkspaceEvents/TasksPushNotificationConfig.ts";
import {
  Tenant as JobsTenant,
  TenantProvider as JobsTenantProvider,
} from "./Jobs/Tenant.ts";
import {
  TenantsCompany,
  TenantsCompanyProvider,
} from "./Jobs/TenantsCompany.ts";
import { TenantsJob, TenantsJobProvider } from "./Jobs/TenantsJob.ts";
import {
  Product as VisionProduct,
  ProductProvider as VisionProductProvider,
} from "./Vision/Product.ts";
import {
  ProductSet as VisionProductSet,
  ProductSetProvider as VisionProductSetProvider,
} from "./Vision/ProductSet.ts";
import {
  ProductsReferenceImage,
  ProductsReferenceImageProvider,
} from "./Vision/ProductsReferenceImage.ts";
import { CustomClass, CustomClassProvider } from "./Speech/CustomClass.ts";
import { PhraseSet, PhraseSetProvider } from "./Speech/PhraseSet.ts";
import { GetCustomClassHttp } from "./Speech/GetCustomClassHttp.ts";
import { GetPhraseSetHttp } from "./Speech/GetPhraseSetHttp.ts";
import { RecognizeHttp } from "./Speech/RecognizeHttp.ts";
import {
  MonetizationSubscription,
  MonetizationSubscriptionProvider,
} from "./AndroidPublisher/MonetizationSubscription.ts";
import {
  MonetizationSubscriptionsBasePlansOffer,
  MonetizationSubscriptionsBasePlansOfferProvider,
} from "./AndroidPublisher/MonetizationSubscriptionsBasePlansOffer.ts";
import { Edit, EditProvider } from "./AndroidPublisher/Edit.ts";
import {
  Inappproduct,
  InappproductProvider,
} from "./AndroidPublisher/Inappproduct.ts";
import {
  AchievementConfiguration,
  AchievementConfigurationProvider,
} from "./GamesConfiguration/AchievementConfiguration.ts";
import {
  LeaderboardConfiguration,
  LeaderboardConfigurationProvider,
} from "./GamesConfiguration/LeaderboardConfiguration.ts";
import {
  Storelayoutcluster,
  StorelayoutclusterProvider,
} from "./AndroidEnterprise/Storelayoutcluster.ts";
import {
  Storelayoutpage,
  StorelayoutpageProvider,
} from "./AndroidEnterprise/Storelayoutpage.ts";
import { Webapp, WebappProvider } from "./AndroidEnterprise/Webapp.ts";
import {
  CustomersConfiguration,
  CustomersConfigurationProvider,
} from "./AndroidDeviceProvisioning/CustomersConfiguration.ts";
import {
  CustomersConnectorConfig,
  CustomersConnectorConfigProvider,
} from "./ChromeManagement/CustomersConnectorConfig.ts";
import {
  Enterprise as AndroidmanagementEnterprise,
  EnterpriseProvider as AndroidmanagementEnterpriseProvider,
} from "./AndroidManagement/Enterprise.ts";
import {
  EnterprisesEnrollmentToken,
  EnterprisesEnrollmentTokenProvider,
} from "./AndroidManagement/EnterprisesEnrollmentToken.ts";
import {
  EnterprisesWebApp,
  EnterprisesWebAppProvider,
} from "./AndroidManagement/EnterprisesWebApp.ts";
import {
  AppsAuthorizedCertificate,
  AppsAuthorizedCertificateProvider,
} from "./AppEngine/AppsAuthorizedCertificate.ts";
import {
  AppsDomainMapping,
  AppsDomainMappingProvider,
} from "./AppEngine/AppsDomainMapping.ts";
import {
  AppsFirewallIngressRule,
  AppsFirewallIngressRuleProvider,
} from "./AppEngine/AppsFirewallIngressRule.ts";
import {
  AppsServicesVersion,
  AppsServicesVersionProvider,
} from "./AppEngine/AppsServicesVersion.ts";
import {
  ApplicationsAuthorizedCertificate,
  ApplicationsAuthorizedCertificateProvider,
} from "./AppEngine/ApplicationsAuthorizedCertificate.ts";
import {
  ApplicationsDomainMapping,
  ApplicationsDomainMappingProvider,
} from "./AppEngine/ApplicationsDomainMapping.ts";
import {
  UsersSshPublicKey,
  UsersSshPublicKeyProvider,
} from "./OSLogin/UsersSshPublicKey.ts";
import {
  LicenseAssignment,
  LicenseAssignmentProvider,
} from "./Licensing/LicenseAssignment.ts";
import {
  WebResource,
  WebResourceProvider,
} from "./SiteVerification/WebResource.ts";
import {
  Feed as CloudassetFeed,
  FeedProvider as CloudassetFeedProvider,
} from "./CloudAsset/Feed.ts";
import {
  SavedQuery as CloudassetSavedQuery,
  SavedQueryProvider as CloudassetSavedQueryProvider,
} from "./CloudAsset/SavedQuery.ts";
import {
  Device as CloudidentityDevice,
  DeviceProvider as CloudidentityDeviceProvider,
} from "./CloudIdentity/Device.ts";
import {
  Group as CloudidentityGroup,
  GroupProvider as CloudidentityGroupProvider,
} from "./CloudIdentity/Group.ts";
import {
  GroupsMembership,
  GroupsMembershipProvider,
} from "./CloudIdentity/GroupsMembership.ts";
import {
  InboundOidcSsoProfile,
  InboundOidcSsoProfileProvider,
} from "./CloudIdentity/InboundOidcSsoProfile.ts";
import {
  InboundSamlSsoProfile,
  InboundSamlSsoProfileProvider,
} from "./CloudIdentity/InboundSamlSsoProfile.ts";
import {
  InboundSsoAssignment,
  InboundSsoAssignmentProvider,
} from "./CloudIdentity/InboundSsoAssignment.ts";
import {
  Customer as CloudchannelCustomer,
  CustomerProvider as CloudchannelCustomerProvider,
} from "./CloudChannel/Customer.ts";
import {
  ChannelPartnerLinksCustomer,
  ChannelPartnerLinksCustomerProvider,
} from "./CloudChannel/ChannelPartnerLinksCustomer.ts";
import {
  CustomersCustomerRepricingConfig,
  CustomersCustomerRepricingConfigProvider,
} from "./CloudChannel/CustomersCustomerRepricingConfig.ts";
import {
  ChannelPartnerLinksChannelPartnerRepricingConfig,
  ChannelPartnerLinksChannelPartnerRepricingConfigProvider,
} from "./CloudChannel/ChannelPartnerLinksChannelPartnerRepricingConfig.ts";
import {
  Customer as CloudcontrolspartnerCustomer,
  CustomerProvider as CloudcontrolspartnerCustomerProvider,
} from "./CloudControlsPartner/Customer.ts";
import {
  Deployment as DeploymentmanagerDeployment,
  DeploymentProvider as DeploymentmanagerDeploymentProvider,
} from "./DeploymentManager/Deployment.ts";
import {
  Dataset as HealthcareDataset,
  DatasetProvider as HealthcareDatasetProvider,
} from "./Healthcare/Dataset.ts";
import {
  DatasetsConsentStore,
  DatasetsConsentStoreProvider,
} from "./Healthcare/DatasetsConsentStore.ts";
import {
  DatasetsConsentStoresAttributeDefinition,
  DatasetsConsentStoresAttributeDefinitionProvider,
} from "./Healthcare/DatasetsConsentStoresAttributeDefinition.ts";
import {
  DatasetsConsentStoresConsent,
  DatasetsConsentStoresConsentProvider,
} from "./Healthcare/DatasetsConsentStoresConsent.ts";
import {
  DatasetsConsentStoresConsentArtifact,
  DatasetsConsentStoresConsentArtifactProvider,
} from "./Healthcare/DatasetsConsentStoresConsentArtifact.ts";
import {
  DatasetsConsentStoresUserDataMapping,
  DatasetsConsentStoresUserDataMappingProvider,
} from "./Healthcare/DatasetsConsentStoresUserDataMapping.ts";
import {
  DatasetsDicomStore,
  DatasetsDicomStoreProvider,
} from "./Healthcare/DatasetsDicomStore.ts";
import {
  DatasetsFhirStore,
  DatasetsFhirStoreProvider,
} from "./Healthcare/DatasetsFhirStore.ts";
import {
  DatasetsHl7V2Store,
  DatasetsHl7V2StoreProvider,
} from "./Healthcare/DatasetsHl7V2Store.ts";
import {
  DatasetsHl7V2StoresMessage,
  DatasetsHl7V2StoresMessageProvider,
} from "./Healthcare/DatasetsHl7V2StoresMessage.ts";
import {
  BrandsIdentityAwareProxyClient,
  BrandsIdentityAwareProxyClientProvider,
} from "./IAP/BrandsIdentityAwareProxyClient.ts";
import { IapDestGroup, IapDestGroupProvider } from "./IAP/IapDestGroup.ts";
import {
  AgentsEntityType,
  AgentsEntityTypeProvider,
} from "./Dialogflow/AgentsEntityType.ts";
import {
  AgentsEnvironment,
  AgentsEnvironmentProvider,
} from "./Dialogflow/AgentsEnvironment.ts";
import {
  AgentsEnvironmentsExperiment,
  AgentsEnvironmentsExperimentProvider,
} from "./Dialogflow/AgentsEnvironmentsExperiment.ts";
import {
  AgentsEnvironmentsSessionsEntityType,
  AgentsEnvironmentsSessionsEntityTypeProvider,
} from "./Dialogflow/AgentsEnvironmentsSessionsEntityType.ts";
import { AgentsFlow, AgentsFlowProvider } from "./Dialogflow/AgentsFlow.ts";
import {
  AgentsFlowsPage,
  AgentsFlowsPageProvider,
} from "./Dialogflow/AgentsFlowsPage.ts";
import {
  AgentsFlowsTransitionRouteGroup,
  AgentsFlowsTransitionRouteGroupProvider,
} from "./Dialogflow/AgentsFlowsTransitionRouteGroup.ts";
import {
  AgentsFlowsVersion,
  AgentsFlowsVersionProvider,
} from "./Dialogflow/AgentsFlowsVersion.ts";
import {
  AgentsGenerator,
  AgentsGeneratorProvider,
} from "./Dialogflow/AgentsGenerator.ts";
import {
  AgentsIntent,
  AgentsIntentProvider,
} from "./Dialogflow/AgentsIntent.ts";
import {
  AgentsPlaybook,
  AgentsPlaybookProvider,
} from "./Dialogflow/AgentsPlaybook.ts";
import {
  AgentsPlaybooksExample,
  AgentsPlaybooksExampleProvider,
} from "./Dialogflow/AgentsPlaybooksExample.ts";
import {
  AgentsPlaybooksVersion,
  AgentsPlaybooksVersionProvider,
} from "./Dialogflow/AgentsPlaybooksVersion.ts";
import {
  AgentsSessionsEntityType,
  AgentsSessionsEntityTypeProvider,
} from "./Dialogflow/AgentsSessionsEntityType.ts";
import { AgentsTool, AgentsToolProvider } from "./Dialogflow/AgentsTool.ts";
import {
  AgentsToolsVersion,
  AgentsToolsVersionProvider,
} from "./Dialogflow/AgentsToolsVersion.ts";
import {
  AgentsTransitionRouteGroup,
  AgentsTransitionRouteGroupProvider,
} from "./Dialogflow/AgentsTransitionRouteGroup.ts";
import {
  AgentsWebhook,
  AgentsWebhookProvider,
} from "./Dialogflow/AgentsWebhook.ts";
import {
  SecuritySetting,
  SecuritySettingProvider,
} from "./Dialogflow/SecuritySetting.ts";
import { ContentPolicy, ContentPolicyProvider } from "./DLP/ContentPolicy.ts";
import {
  DeidentifyTemplate,
  DeidentifyTemplateProvider,
} from "./DLP/DeidentifyTemplate.ts";
import {
  DiscoveryConfig,
  DiscoveryConfigProvider,
} from "./DLP/DiscoveryConfig.ts";
import { DlpJob, DlpJobProvider } from "./DLP/DlpJob.ts";
import {
  InspectTemplate,
  InspectTemplateProvider,
} from "./DLP/InspectTemplate.ts";
import { JobTrigger, JobTriggerProvider } from "./DLP/JobTrigger.ts";
import {
  LocationsDeidentifyTemplate,
  LocationsDeidentifyTemplateProvider,
} from "./DLP/LocationsDeidentifyTemplate.ts";
import {
  LocationsDlpJob,
  LocationsDlpJobProvider,
} from "./DLP/LocationsDlpJob.ts";
import {
  LocationsInspectTemplate,
  LocationsInspectTemplateProvider,
} from "./DLP/LocationsInspectTemplate.ts";
import {
  LocationsJobTrigger,
  LocationsJobTriggerProvider,
} from "./DLP/LocationsJobTrigger.ts";
import {
  LocationsStoredInfoType,
  LocationsStoredInfoTypeProvider,
} from "./DLP/LocationsStoredInfoType.ts";
import {
  OrganizationStoredInfoType,
  OrganizationStoredInfoTypeProvider,
} from "./DLP/OrganizationStoredInfoType.ts";
import {
  StoredInfoType,
  StoredInfoTypeProvider,
} from "./DLP/StoredInfoType.ts";
import {
  OrganizationsDeidentifyTemplate,
  OrganizationsDeidentifyTemplateProvider,
} from "./DLP/OrganizationsDeidentifyTemplate.ts";
import {
  OrganizationsInspectTemplate,
  OrganizationsInspectTemplateProvider,
} from "./DLP/OrganizationsInspectTemplate.ts";
import {
  OrganizationsLocationsConnection,
  OrganizationsLocationsConnectionProvider,
} from "./DLP/OrganizationsLocationsConnection.ts";
import {
  OrganizationsLocationsDeidentifyTemplate,
  OrganizationsLocationsDeidentifyTemplateProvider,
} from "./DLP/OrganizationsLocationsDeidentifyTemplate.ts";
import {
  OrganizationsLocationsDiscoveryConfig,
  OrganizationsLocationsDiscoveryConfigProvider,
} from "./DLP/OrganizationsLocationsDiscoveryConfig.ts";
import {
  OrganizationsLocationsInspectTemplate,
  OrganizationsLocationsInspectTemplateProvider,
} from "./DLP/OrganizationsLocationsInspectTemplate.ts";
import {
  OrganizationsLocationsJobTrigger,
  OrganizationsLocationsJobTriggerProvider,
} from "./DLP/OrganizationsLocationsJobTrigger.ts";
import {
  OrganizationsLocationsStoredInfoType,
  OrganizationsLocationsStoredInfoTypeProvider,
} from "./DLP/OrganizationsLocationsStoredInfoType.ts";
import {
  FolderBigQueryExport,
  FolderBigQueryExportProvider,
} from "./SecurityCenter/FolderBigQueryExport.ts";
import {
  FolderEventThreatDetectionSettingsCustomModule,
  FolderEventThreatDetectionSettingsCustomModuleProvider,
} from "./SecurityCenter/FolderEventThreatDetectionSettingsCustomModule.ts";
import {
  FolderMuteConfig,
  FolderMuteConfigProvider,
} from "./SecurityCenter/FolderMuteConfig.ts";
import {
  FolderNotificationConfig,
  FolderNotificationConfigProvider,
} from "./SecurityCenter/FolderNotificationConfig.ts";
import {
  FolderSecurityHealthAnalyticsSettingsCustomModule,
  FolderSecurityHealthAnalyticsSettingsCustomModuleProvider,
} from "./SecurityCenter/FolderSecurityHealthAnalyticsSettingsCustomModule.ts";
import {
  OrganizationBigQueryExport,
  OrganizationBigQueryExportProvider,
} from "./SecurityCenter/OrganizationBigQueryExport.ts";
import {
  OrganizationEventThreatDetectionSettingsCustomModule,
  OrganizationEventThreatDetectionSettingsCustomModuleProvider,
} from "./SecurityCenter/OrganizationEventThreatDetectionSettingsCustomModule.ts";
import {
  OrganizationMuteConfig,
  OrganizationMuteConfigProvider,
} from "./SecurityCenter/OrganizationMuteConfig.ts";
import {
  NotificationConfig,
  NotificationConfigProvider,
} from "./SecurityCenter/NotificationConfig.ts";
import {
  OrganizationsNotificationConfig,
  OrganizationsNotificationConfigProvider,
} from "./SecurityCenter/OrganizationsNotificationConfig.ts";
import { MuteConfig, MuteConfigProvider } from "./SecurityCenter/MuteConfig.ts";
import {
  BigQueryExport,
  BigQueryExportProvider,
} from "./SecurityCenter/BigQueryExport.ts";
import {
  EventThreatDetectionSettingsCustomModule,
  EventThreatDetectionSettingsCustomModuleProvider,
} from "./SecurityCenter/EventThreatDetectionSettingsCustomModule.ts";
import {
  SecurityHealthAnalyticsSettingsCustomModule,
  SecurityHealthAnalyticsSettingsCustomModuleProvider,
} from "./SecurityCenter/SecurityHealthAnalyticsSettingsCustomModule.ts";
import {
  OrganizationsSecurityHealthAnalyticsSettingsCustomModule,
  OrganizationsSecurityHealthAnalyticsSettingsCustomModuleProvider,
} from "./SecurityCenter/OrganizationsSecurityHealthAnalyticsSettingsCustomModule.ts";
import { Posture, PostureProvider } from "./SecurityPosture/Posture.ts";
import {
  PostureDeployment,
  PostureDeploymentProvider,
} from "./SecurityPosture/PostureDeployment.ts";
import {
  AppgroupsAppsKey,
  AppgroupsAppsKeyProvider,
} from "./Apigee/AppgroupsAppsKey.ts";
import {
  Datacollector,
  DatacollectorProvider,
} from "./Apigee/Datacollector.ts";
import { Developer, DeveloperProvider } from "./Apigee/Developer.ts";
import {
  DevelopersApp,
  DevelopersAppProvider,
} from "./Apigee/DevelopersApp.ts";
import {
  DevelopersAppsKey,
  DevelopersAppsKeyProvider,
} from "./Apigee/DevelopersAppsKey.ts";
import { DnsZone, DnsZoneProvider } from "./Apigee/DnsZone.ts";
import {
  EndpointAttachment,
  EndpointAttachmentProvider,
} from "./Apigee/EndpointAttachment.ts";
import { Envgroup, EnvgroupProvider } from "./Apigee/Envgroup.ts";
import {
  EnvgroupsAttachment,
  EnvgroupsAttachmentProvider,
} from "./Apigee/EnvgroupsAttachment.ts";
import {
  Environment as ApigeeEnvironment,
  EnvironmentProvider as ApigeeEnvironmentProvider,
} from "./Apigee/Environment.ts";
import {
  DataStoresBranchesDocument,
  DataStoresBranchesDocumentProvider,
} from "./DiscoveryEngine/DataStoresBranchesDocument.ts";
import {
  DataStoresControl,
  DataStoresControlProvider,
} from "./DiscoveryEngine/DataStoresControl.ts";
import {
  DataStoresConversation,
  DataStoresConversationProvider,
} from "./DiscoveryEngine/DataStoresConversation.ts";
import {
  DataStoresSchema,
  DataStoresSchemaProvider,
} from "./DiscoveryEngine/DataStoresSchema.ts";
import {
  DataStoresServingConfig,
  DataStoresServingConfigProvider,
} from "./DiscoveryEngine/DataStoresServingConfig.ts";
import {
  DataStoresSession,
  DataStoresSessionProvider,
} from "./DiscoveryEngine/DataStoresSession.ts";
import {
  DataStoresSiteSearchEngineTargetSite,
  DataStoresSiteSearchEngineTargetSiteProvider,
} from "./DiscoveryEngine/DataStoresSiteSearchEngineTargetSite.ts";
import {
  IdentityMappingStore,
  IdentityMappingStoreProvider,
} from "./DiscoveryEngine/IdentityMappingStore.ts";
import { DataStore, DataStoreProvider } from "./DiscoveryEngine/DataStore.ts";
import {
  CollectionsEngine,
  CollectionsEngineProvider,
} from "./DiscoveryEngine/CollectionsEngine.ts";
import {
  CollectionsEnginesAssistant,
  CollectionsEnginesAssistantProvider,
} from "./DiscoveryEngine/CollectionsEnginesAssistant.ts";
import {
  CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig,
  CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigProvider,
} from "./DiscoveryEngine/CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig.ts";
import {
  CollectionsEnginesControl,
  CollectionsEnginesControlProvider,
} from "./DiscoveryEngine/CollectionsEnginesControl.ts";
import {
  CollectionsEnginesConversation,
  CollectionsEnginesConversationProvider,
} from "./DiscoveryEngine/CollectionsEnginesConversation.ts";
import {
  CollectionsEnginesServingConfig,
  CollectionsEnginesServingConfigProvider,
} from "./DiscoveryEngine/CollectionsEnginesServingConfig.ts";
import {
  CollectionsEnginesSession,
  CollectionsEnginesSessionProvider,
} from "./DiscoveryEngine/CollectionsEnginesSession.ts";
import {
  CollectionsDataStore,
  CollectionsDataStoreProvider,
} from "./DiscoveryEngine/CollectionsDataStore.ts";
import {
  CollectionsDataStoresBranchesDocument,
  CollectionsDataStoresBranchesDocumentProvider,
} from "./DiscoveryEngine/CollectionsDataStoresBranchesDocument.ts";
import {
  CollectionsDataStoresControl,
  CollectionsDataStoresControlProvider,
} from "./DiscoveryEngine/CollectionsDataStoresControl.ts";
import {
  CollectionsDataStoresConversation,
  CollectionsDataStoresConversationProvider,
} from "./DiscoveryEngine/CollectionsDataStoresConversation.ts";
import {
  CollectionsDataStoresSchema,
  CollectionsDataStoresSchemaProvider,
} from "./DiscoveryEngine/CollectionsDataStoresSchema.ts";
import {
  CollectionsDataStoresServingConfig,
  CollectionsDataStoresServingConfigProvider,
} from "./DiscoveryEngine/CollectionsDataStoresServingConfig.ts";
import {
  CollectionsDataStoresSession,
  CollectionsDataStoresSessionProvider,
} from "./DiscoveryEngine/CollectionsDataStoresSession.ts";
import {
  CollectionsDataStoresSiteSearchEngineTargetSite,
  CollectionsDataStoresSiteSearchEngineTargetSiteProvider,
} from "./DiscoveryEngine/CollectionsDataStoresSiteSearchEngineTargetSite.ts";
import {
  Deployment as ApihubDeployment,
  DeploymentProvider as ApihubDeploymentProvider,
} from "./ApiHub/Deployment.ts";
import { ExternalApi, ExternalApiProvider } from "./ApiHub/ExternalApi.ts";
import { Plugin, PluginProvider } from "./ApiHub/Plugin.ts";
import {
  PluginsInstance,
  PluginsInstanceProvider,
} from "./ApiHub/PluginsInstance.ts";
import {
  RuntimeProjectAttachment,
  RuntimeProjectAttachmentProvider,
} from "./ApiHub/RuntimeProjectAttachment.ts";
import {
  ApiHubInstance,
  ApiHubInstanceProvider,
} from "./ApiHub/ApiHubInstance.ts";
import {
  Api as ApihubApi,
  ApiProvider as ApihubApiProvider,
} from "./ApiHub/Api.ts";
import { ApisVersion, ApisVersionProvider } from "./ApiHub/ApisVersion.ts";
import {
  ApisVersionsOperation,
  ApisVersionsOperationProvider,
} from "./ApiHub/ApisVersionsOperation.ts";
import {
  ApisVersionsSpec,
  ApisVersionsSpecProvider,
} from "./ApiHub/ApisVersionsSpec.ts";
import {
  Attribute as ApihubAttribute,
  AttributeProvider as ApihubAttributeProvider,
} from "./ApiHub/Attribute.ts";
import { Curation, CurationProvider } from "./ApiHub/Curation.ts";
import { Dependency, DependencyProvider } from "./ApiHub/Dependency.ts";
import { Application, ApplicationProvider } from "./AppHub/Application.ts";
import {
  ApplicationsService,
  ApplicationsServiceProvider,
} from "./AppHub/ApplicationsService.ts";
import {
  ApplicationsWorkload,
  ApplicationsWorkloadProvider,
} from "./AppHub/ApplicationsWorkload.ts";
import {
  ServiceProjectAttachment,
  ServiceProjectAttachmentProvider,
} from "./AppHub/ServiceProjectAttachment.ts";
import {
  ObservationJob,
  ObservationJobProvider,
} from "./Apim/ObservationJob.ts";
import {
  ObservationSource,
  ObservationSourceProvider,
} from "./Apim/ObservationSource.ts";
import { ApisConfig, ApisConfigProvider } from "./ApiGateway/ApisConfig.ts";
import {
  DataExchange,
  DataExchangeProvider,
} from "./AnalyticsHub/DataExchange.ts";
import {
  DataExchangesListing,
  DataExchangesListingProvider,
} from "./AnalyticsHub/DataExchangesListing.ts";
import {
  DataExchangesQueryTemplate,
  DataExchangesQueryTemplateProvider,
} from "./AnalyticsHub/DataExchangesQueryTemplate.ts";
import {
  BuyersClientsUser,
  BuyersClientsUserProvider,
} from "./AuthorizedBuyersMarketplace/BuyersClientsUser.ts";
import {
  AccountTypesUserList,
  AccountTypesUserListProvider,
} from "./DataManager/AccountTypesUserList.ts";
import {
  BiddersPretargetingConfig,
  BiddersPretargetingConfigProvider,
} from "./RealTimeBidding/BiddersPretargetingConfig.ts";
import {
  Pipeline as DatapipelinesPipeline,
  PipelineProvider as DatapipelinesPipelineProvider,
} from "./DataPipelines/Pipeline.ts";
import { RunPipelineHttp } from "./DataPipelines/RunPipelineHttp.ts";
import { StopPipelineHttp } from "./DataPipelines/StopPipelineHttp.ts";
import {
  Index as DatastoreIndex,
  IndexProvider as DatastoreIndexProvider,
} from "./Datastore/Indexes.ts";
import { LookupHttp } from "./Datastore/LookupHttp.ts";
import { CommitHttp } from "./Datastore/CommitHttp.ts";
import { RunQueryHttp } from "./Datastore/RunQueryHttp.ts";
import {
  AuthProvider as AgentidentityAuthProvider,
  AuthProviderProvider as AgentidentityAuthProviderProvider,
} from "./AgentIdentity/AuthProvider.ts";
import {
  MerchantReview,
  MerchantReviewProvider,
} from "./MerchantApiReviews/MerchantReview.ts";
import {
  ProductReview,
  ProductReviewProvider,
} from "./MerchantApiReviews/ProductReview.ts";
import {
  DocumentSchema as ContentwarehouseDocumentSchema,
  DocumentSchemaProvider as ContentwarehouseDocumentSchemaProvider,
} from "./ContentWarehouse/DocumentSchema.ts";
import {
  Document as ContentwarehouseDocument,
  DocumentProvider as ContentwarehouseDocumentProvider,
} from "./ContentWarehouse/Document.ts";
import {
  RuleSet as ContentwarehouseRuleSet,
  RuleSetProvider as ContentwarehouseRuleSetProvider,
} from "./ContentWarehouse/RuleSet.ts";
import {
  SynonymSet as ContentwarehouseSynonymSet,
  SynonymSetProvider as ContentwarehouseSynonymSetProvider,
} from "./ContentWarehouse/SynonymSet.ts";
import { GetDocumentSchemaHttp } from "./ContentWarehouse/GetDocumentSchemaHttp.ts";
import { GetDocumentHttp as GetContentwarehouseDocumentHttp } from "./ContentWarehouse/GetDocumentHttp.ts";
import { GetRuleSetHttp } from "./ContentWarehouse/GetRuleSetHttp.ts";
import { GetSynonymSetHttp } from "./ContentWarehouse/GetSynonymSetHttp.ts";

import {
  SfdcInstance,
  SfdcInstanceProvider,
} from "./Integrations/SfdcInstance.ts";
import {
  SfdcInstancesSfdcChannel,
  SfdcInstancesSfdcChannelProvider,
} from "./Integrations/SfdcInstancesSfdcChannel.ts";
import {
  Template as IntegrationsTemplate,
  TemplateProvider as IntegrationsTemplateProvider,
} from "./Integrations/Template.ts";
import { AuthConfig, AuthConfigProvider } from "./Integrations/AuthConfig.ts";
import {
  IntegrationsVersion,
  IntegrationsVersionProvider,
} from "./Integrations/IntegrationsVersion.ts";
import {
  IntegrationsVersionsTestCases,
  IntegrationsVersionsTestCasesProvider,
} from "./Integrations/IntegrationsVersionsTestCases.ts";
import {
  ProductsAuthConfig,
  ProductsAuthConfigProvider,
} from "./Integrations/ProductsAuthConfig.ts";
import {
  ProductsCertificate,
  ProductsCertificateProvider,
} from "./Integrations/ProductsCertificate.ts";
import {
  ProductsIntegrationsVersion,
  ProductsIntegrationsVersionProvider,
} from "./Integrations/ProductsIntegrationsVersion.ts";
import {
  ProductsSfdcInstance,
  ProductsSfdcInstanceProvider,
} from "./Integrations/ProductsSfdcInstance.ts";
import {
  ProductsSfdcInstancesSfdcChannel,
  ProductsSfdcInstancesSfdcChannelProvider,
} from "./Integrations/ProductsSfdcInstancesSfdcChannel.ts";
import {
  AssetsExportJob as MigrationcenterAssetsExportJob,
  AssetsExportJobProvider as MigrationcenterAssetsExportJobProvider,
} from "./MigrationCenter/AssetsExportJob.ts";
import {
  DiscoveryClient as MigrationcenterDiscoveryClient,
  DiscoveryClientProvider as MigrationcenterDiscoveryClientProvider,
} from "./MigrationCenter/DiscoveryClient.ts";
import {
  Group as MigrationcenterGroup,
  GroupProvider as MigrationcenterGroupProvider,
} from "./MigrationCenter/Group.ts";
import {
  ImportJob as MigrationcenterImportJob,
  ImportJobProvider as MigrationcenterImportJobProvider,
} from "./MigrationCenter/ImportJob.ts";
import {
  ImportJobsImportDataFile as MigrationcenterImportJobsImportDataFile,
  ImportJobsImportDataFileProvider as MigrationcenterImportJobsImportDataFileProvider,
} from "./MigrationCenter/ImportJobsImportDataFile.ts";
import {
  PreferenceSet as MigrationcenterPreferenceSet,
  PreferenceSetProvider as MigrationcenterPreferenceSetProvider,
} from "./MigrationCenter/PreferenceSet.ts";
import {
  ReportConfig as MigrationcenterReportConfig,
  ReportConfigProvider as MigrationcenterReportConfigProvider,
} from "./MigrationCenter/ReportConfig.ts";
import {
  ReportConfigsReport as MigrationcenterReportConfigsReport,
  ReportConfigsReportProvider as MigrationcenterReportConfigsReportProvider,
} from "./MigrationCenter/ReportConfigsReport.ts";
import {
  Source as MigrationcenterSource,
  SourceProvider as MigrationcenterSourceProvider,
} from "./MigrationCenter/Source.ts";
import {
  Collector as RapidmigrationassessmentCollector,
  CollectorProvider as RapidmigrationassessmentCollectorProvider,
} from "./RapidMigrationAssessment/Collector.ts";
import { PauseCollectorHttp } from "./RapidMigrationAssessment/PauseCollectorHttp.ts";
import { RegisterCollectorHttp } from "./RapidMigrationAssessment/RegisterCollectorHttp.ts";
import { ResumeCollectorHttp } from "./RapidMigrationAssessment/ResumeCollectorHttp.ts";
import {
  Federation as MetastoreFederation,
  FederationProvider as MetastoreFederationProvider,
} from "./Metastore/Federation.ts";
import {
  Service as MetastoreService,
  ServiceProvider as MetastoreServiceProvider,
} from "./Metastore/Service.ts";
import {
  ServicesBackup as MetastoreServicesBackup,
  ServicesBackupProvider as MetastoreServicesBackupProvider,
} from "./Metastore/ServicesBackup.ts";
import {
  ProjectsLocationsFolder,
  ProjectsLocationsFolderProvider,
} from "./Dataform/ProjectsLocationsFolder.ts";
import {
  RepositoriesReleaseConfig,
  RepositoriesReleaseConfigProvider,
} from "./Dataform/RepositoriesReleaseConfig.ts";
import {
  RepositoriesWorkflowConfig,
  RepositoriesWorkflowConfigProvider,
} from "./Dataform/RepositoriesWorkflowConfig.ts";
import {
  RepositoriesWorkflowInvocation,
  RepositoriesWorkflowInvocationProvider,
} from "./Dataform/RepositoriesWorkflowInvocation.ts";
import {
  RepositoriesWorkspace,
  RepositoriesWorkspaceProvider,
} from "./Dataform/RepositoriesWorkspace.ts";
import {
  Repository as DataformRepository,
  RepositoryProvider as DataformRepositoryProvider,
} from "./Dataform/Repository.ts";
import { Team, TeamProvider } from "./Dataform/Team.ts";
import {
  VolumesReplication,
  VolumesReplicationProvider,
} from "./NetApp/VolumesReplication.ts";
import {
  VmwareEngineNetwork,
  VmwareEngineNetworkProvider,
} from "./VMwareEngine/VmwareEngineNetwork.ts";
import {
  PrivateConnection,
  PrivateConnectionProvider,
} from "./VMwareEngine/PrivateConnection.ts";
import {
  PrivateCloudsManagementDnsZoneBinding,
  PrivateCloudsManagementDnsZoneBindingProvider,
} from "./VMwareEngine/PrivateCloudsManagementDnsZoneBinding.ts";
import {
  Datastore as VmwareengineDatastore,
  DatastoreProvider as VmwareengineDatastoreProvider,
} from "./VMwareEngine/Datastore.ts";
import {
  NetworkPeering,
  NetworkPeeringProvider,
} from "./VMwareEngine/NetworkPeering.ts";
import {
  NetworkPolicy as VmwareengineNetworkPolicy,
  NetworkPolicyProvider as VmwareengineNetworkPolicyProvider,
} from "./VMwareEngine/NetworkPolicy.ts";
import {
  NetworkPoliciesExternalAccessRule,
  NetworkPoliciesExternalAccessRuleProvider,
} from "./VMwareEngine/NetworkPoliciesExternalAccessRule.ts";
import {
  PrivateCloud,
  PrivateCloudProvider,
} from "./VMwareEngine/PrivateCloud.ts";
import {
  PrivateCloudsCluster,
  PrivateCloudsClusterProvider,
} from "./VMwareEngine/PrivateCloudsCluster.ts";
import {
  PrivateCloudsExternalAddress,
  PrivateCloudsExternalAddressProvider,
} from "./VMwareEngine/PrivateCloudsExternalAddress.ts";
import {
  PrivateCloudsLoggingServer,
  PrivateCloudsLoggingServerProvider,
} from "./VMwareEngine/PrivateCloudsLoggingServer.ts";
import {
  VolumesSnapshot,
  VolumesSnapshotProvider,
} from "./NetApp/VolumesSnapshot.ts";
import {
  BackupChannel,
  BackupChannelProvider,
} from "./GKEBackup/BackupChannel.ts";
import { BackupPlan, BackupPlanProvider } from "./GKEBackup/BackupPlan.ts";
import {
  BackupPlansBackup,
  BackupPlansBackupProvider,
} from "./GKEBackup/BackupPlansBackup.ts";
import {
  RestoreChannel,
  RestoreChannelProvider,
} from "./GKEBackup/RestoreChannel.ts";
import { RestorePlan, RestorePlanProvider } from "./GKEBackup/RestorePlan.ts";
import {
  RestorePlansRestore,
  RestorePlansRestoreProvider,
} from "./GKEBackup/RestorePlansRestore.ts";
import {
  MembershipsFeature,
  MembershipsFeatureProvider,
} from "./GKEHub/MembershipsFeature.ts";
import {
  InstancesBackup,
  InstancesBackupProvider,
} from "./Looker/InstancesBackup.ts";
import {
  BareMetalCluster,
  BareMetalClusterProvider,
} from "./GKEOnPrem/BareMetalCluster.ts";
import {
  BareMetalClustersBareMetalNodePool,
  BareMetalClustersBareMetalNodePoolProvider,
} from "./GKEOnPrem/BareMetalClustersBareMetalNodePool.ts";
import {
  VmwareCluster as GkeonpremVmwareCluster,
  VmwareClusterProvider as GkeonpremVmwareClusterProvider,
} from "./GKEOnPrem/VmwareCluster.ts";
import {
  VmwareClustersVmwareNodePool,
  VmwareClustersVmwareNodePoolProvider,
} from "./GKEOnPrem/VmwareClustersVmwareNodePool.ts";
import {
  BackupVault as BackupdrBackupVault,
  BackupVaultProvider as BackupdrBackupVaultProvider,
} from "./BackupDR/BackupVault.ts";
import {
  BackupPlan as BackupdrBackupPlan,
  BackupPlanProvider as BackupdrBackupPlanProvider,
} from "./BackupDR/BackupPlan.ts";
import {
  BackupPlanAssociation,
  BackupPlanAssociationProvider,
} from "./BackupDR/BackupPlanAssociation.ts";
import {
  ManagementServer as BackupdrManagementServer,
  ManagementServerProvider as BackupdrManagementServerProvider,
} from "./BackupDR/ManagementServer.ts";
import {
  NfsShare as BaremetalsolutionNfsShare,
  NfsShareProvider as BaremetalsolutionNfsShareProvider,
} from "./BareMetalSolution/NfsShare.ts";
import {
  VolumesSnapshot as BaremetalsolutionVolumesSnapshot,
  VolumesSnapshotProvider as BaremetalsolutionVolumesSnapshotProvider,
} from "./BareMetalSolution/VolumesSnapshot.ts";
import {
  Domain as ManagedidentitiesDomain,
  DomainProvider as ManagedidentitiesDomainProvider,
} from "./ManagedIdentities/Domain.ts";
import {
  DomainsBackup as ManagedidentitiesDomainsBackup,
  DomainsBackupProvider as ManagedidentitiesDomainsBackupProvider,
} from "./ManagedIdentities/DomainsBackup.ts";
import {
  Peering as ManagedidentitiesPeering,
  PeeringProvider as ManagedidentitiesPeeringProvider,
} from "./ManagedIdentities/Peering.ts";
import {
  CustomTargetType,
  CustomTargetTypeProvider,
} from "./CloudDeploy/CustomTargetType.ts";
import {
  DeliveryPipeline,
  DeliveryPipelineProvider,
} from "./CloudDeploy/DeliveryPipeline.ts";
import {
  DeliveryPipelinesAutomation,
  DeliveryPipelinesAutomationProvider,
} from "./CloudDeploy/DeliveryPipelinesAutomation.ts";
import {
  DeployPolicy,
  DeployPolicyProvider,
} from "./CloudDeploy/DeployPolicy.ts";
import {
  Target as ClouddeployTarget,
  TargetProvider as ClouddeployTargetProvider,
} from "./CloudDeploy/Target.ts";
import {
  DeploymentGroup as ConfigDeploymentGroup,
  DeploymentGroupProvider as ConfigDeploymentGroupProvider,
} from "./Config/DeploymentGroup.ts";
import {
  Preview as ConfigPreview,
  PreviewProvider as ConfigPreviewProvider,
} from "./Config/Preview.ts";
import { App as CesApp, AppProvider as CesAppProvider } from "./CES/App.ts";
import { AppsAgent, AppsAgentProvider } from "./CES/AppsAgent.ts";
import {
  AppsDeployment,
  AppsDeploymentProvider,
} from "./CES/AppsDeployment.ts";
import { AppsExample, AppsExampleProvider } from "./CES/AppsExample.ts";
import { AppsGuardrail, AppsGuardrailProvider } from "./CES/AppsGuardrail.ts";
import { AppsTool, AppsToolProvider } from "./CES/AppsTool.ts";
import { AppsToolset, AppsToolsetProvider } from "./CES/AppsToolset.ts";
import { AppsVersion, AppsVersionProvider } from "./CES/AppsVersion.ts";
import {
  CustomersDeployment as SasportalCustomersDeployment,
  CustomersDeploymentProvider as SasportalCustomersDeploymentProvider,
} from "./SasPortal/CustomersDeployment.ts";
import {
  CustomersDevice as SasportalCustomersDevice,
  CustomersDeviceProvider as SasportalCustomersDeviceProvider,
} from "./SasPortal/CustomersDevice.ts";
import {
  CustomersNode as SasportalCustomersNode,
  CustomersNodeProvider as SasportalCustomersNodeProvider,
} from "./SasPortal/CustomersNode.ts";
import {
  NodesDevice as SasportalNodesDevice,
  NodesDeviceProvider as SasportalNodesDeviceProvider,
} from "./SasPortal/NodesDevice.ts";
import {
  NodesNode as SasportalNodesNode,
  NodesNodeProvider as SasportalNodesNodeProvider,
} from "./SasPortal/NodesNode.ts";
import {
  AnnotationSpecSet as DatalabelingAnnotationSpecSet,
  AnnotationSpecSetProvider as DatalabelingAnnotationSpecSetProvider,
} from "./DataLabeling/AnnotationSpecSet.ts";
import {
  Dataset as DatalabelingDataset,
  DatasetProvider as DatalabelingDatasetProvider,
} from "./DataLabeling/Dataset.ts";
import {
  DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage,
  DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageProvider,
} from "./DataLabeling/DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage.ts";
import {
  EvaluationJob as DatalabelingEvaluationJob,
  EvaluationJobProvider as DatalabelingEvaluationJobProvider,
} from "./DataLabeling/EvaluationJob.ts";
import {
  Instruction as DatalabelingInstruction,
  InstructionProvider as DatalabelingInstructionProvider,
} from "./DataLabeling/Instruction.ts";
import { Process, ProcessProvider } from "./DataLineage/Process.ts";
import {
  ProcessesRun,
  ProcessesRunProvider,
} from "./DataLineage/ProcessesRun.ts";
import {
  ProcessesRunsLineageEvent,
  ProcessesRunsLineageEventProvider,
} from "./DataLineage/ProcessesRunsLineageEvent.ts";
import {
  Saa as SaasservicemgmtSaa,
  SaaProvider as SaasservicemgmtSaaProvider,
} from "./SaasServiceManagement/Saa.ts";
import {
  Tenant as SaasservicemgmtTenant,
  TenantProvider as SaasservicemgmtTenantProvider,
} from "./SaasServiceManagement/Tenant.ts";
import {
  UnitKind as SaasservicemgmtUnitKind,
  UnitKindProvider as SaasservicemgmtUnitKindProvider,
} from "./SaasServiceManagement/UnitKind.ts";
import {
  Unit as SaasservicemgmtUnit,
  UnitProvider as SaasservicemgmtUnitProvider,
} from "./SaasServiceManagement/Unit.ts";
import {
  Release as SaasservicemgmtRelease,
  ReleaseProvider as SaasservicemgmtReleaseProvider,
} from "./SaasServiceManagement/Release.ts";
import {
  RolloutKind as SaasservicemgmtRolloutKind,
  RolloutKindProvider as SaasservicemgmtRolloutKindProvider,
} from "./SaasServiceManagement/RolloutKind.ts";
import {
  Rollout as SaasservicemgmtRollout,
  RolloutProvider as SaasservicemgmtRolloutProvider,
} from "./SaasServiceManagement/Rollout.ts";
import {
  UnitOperation as SaasservicemgmtUnitOperation,
  UnitOperationProvider as SaasservicemgmtUnitOperationProvider,
} from "./SaasServiceManagement/UnitOperation.ts";
import {
  RegistryBook,
  RegistryBookProvider,
} from "./CloudNumberRegistry/RegistryBook.ts";
import { Realm, RealmProvider } from "./CloudNumberRegistry/Realm.ts";
import {
  CustomRange,
  CustomRangeProvider,
} from "./CloudNumberRegistry/CustomRange.ts";
import {
  IpamAdminScope,
  IpamAdminScopeProvider,
} from "./CloudNumberRegistry/IpamAdminScope.ts";
import {
  Group as VmmigrationGroup,
  GroupProvider as VmmigrationGroupProvider,
} from "./VMMigration/Group.ts";
import {
  ImageImport as VmmigrationImageImport,
  ImageImportProvider as VmmigrationImageImportProvider,
} from "./VMMigration/ImageImport.ts";
import {
  Source as VmmigrationSource,
  SourceProvider as VmmigrationSourceProvider,
} from "./VMMigration/Source.ts";
import {
  SourcesDatacenterConnector,
  SourcesDatacenterConnectorProvider,
} from "./VMMigration/SourcesDatacenterConnector.ts";
import {
  SourcesDiskMigrationJob,
  SourcesDiskMigrationJobProvider,
} from "./VMMigration/SourcesDiskMigrationJob.ts";
import {
  SourcesMigratingVm,
  SourcesMigratingVmProvider,
} from "./VMMigration/SourcesMigratingVm.ts";
import {
  SourcesUtilizationReport,
  SourcesUtilizationReportProvider,
} from "./VMMigration/SourcesUtilizationReport.ts";
import {
  Target as VmmigrationTarget,
  TargetProvider as VmmigrationTargetProvider,
} from "./VMMigration/Target.ts";
import {
  ConnectionProfile as DatamigrationConnectionProfile,
  ConnectionProfileProvider as DatamigrationConnectionProfileProvider,
} from "./DataMigration/ConnectionProfile.ts";
import {
  ConversionWorkspace as DatamigrationConversionWorkspace,
  ConversionWorkspaceProvider as DatamigrationConversionWorkspaceProvider,
} from "./DataMigration/ConversionWorkspace.ts";
import {
  ConversionWorkspacesMappingRule,
  ConversionWorkspacesMappingRuleProvider,
} from "./DataMigration/ConversionWorkspacesMappingRule.ts";
import {
  MigrationJob as DatamigrationMigrationJob,
  MigrationJobProvider as DatamigrationMigrationJobProvider,
} from "./DataMigration/MigrationJob.ts";
import {
  PrivateConnection as DatamigrationPrivateConnection,
  PrivateConnectionProvider as DatamigrationPrivateConnectionProvider,
} from "./DataMigration/PrivateConnection.ts";
import {
  ConnectionProfile as DatastreamConnectionProfile,
  ConnectionProfileProvider as DatastreamConnectionProfileProvider,
} from "./Datastream/ConnectionProfile.ts";
import {
  PrivateConnection as DatastreamPrivateConnection,
  PrivateConnectionProvider as DatastreamPrivateConnectionProvider,
} from "./Datastream/PrivateConnection.ts";
import {
  PrivateConnectionsRoute,
  PrivateConnectionsRouteProvider,
} from "./Datastream/PrivateConnectionsRoute.ts";
import {
  Stream as DatastreamStream,
  StreamProvider as DatastreamStreamProvider,
} from "./Datastream/Stream.ts";
import {
  AccountConnector,
  AccountConnectorProvider,
} from "./DeveloperConnect/AccountConnector.ts";
import {
  Connection as DeveloperconnectConnection,
  ConnectionProvider as DeveloperconnectConnectionProvider,
} from "./DeveloperConnect/Connection.ts";
import {
  ConnectionsGitRepositoryLink,
  ConnectionsGitRepositoryLinkProvider,
} from "./DeveloperConnect/ConnectionsGitRepositoryLink.ts";
import { FetchGitRefsHttp as DeveloperconnectFetchGitRefsHttp } from "./DeveloperConnect/FetchGitRefsHttp.ts";
import { FetchReadTokenHttp as DeveloperconnectFetchReadTokenHttp } from "./DeveloperConnect/FetchReadTokenHttp.ts";
import { FetchReadWriteTokenHttp as DeveloperconnectFetchReadWriteTokenHttp } from "./DeveloperConnect/FetchReadWriteTokenHttp.ts";
import {
  InsightsConfig,
  InsightsConfigProvider,
} from "./DeveloperConnect/InsightsConfig.ts";
import {
  AppConnection,
  AppConnectionProvider,
} from "./BeyondCorp/AppConnection.ts";
import {
  AppConnector,
  AppConnectorProvider,
} from "./BeyondCorp/AppConnector.ts";
import { AppGateway, AppGatewayProvider } from "./BeyondCorp/AppGateway.ts";
import {
  SecurityGateway,
  SecurityGatewayProvider,
} from "./BeyondCorp/SecurityGateway.ts";
import {
  SecurityGatewaysApplication,
  SecurityGatewaysApplicationProvider,
} from "./BeyondCorp/SecurityGatewaysApplication.ts";
import {
  Cluster as ManagedKafkaCluster,
  ClusterProvider as ManagedKafkaClusterProvider,
} from "./ManagedKafka/Cluster.ts";
import {
  ClustersAcl,
  ClustersAclProvider,
} from "./ManagedKafka/ClustersAcl.ts";
import {
  ClustersTopic,
  ClustersTopicProvider,
} from "./ManagedKafka/ClustersTopic.ts";
import {
  ConnectCluster as ManagedKafkaConnectCluster,
  ConnectClusterProvider as ManagedKafkaConnectClusterProvider,
} from "./ManagedKafka/ConnectCluster.ts";
import {
  ConnectClustersConnector,
  ConnectClustersConnectorProvider,
} from "./ManagedKafka/ConnectClustersConnector.ts";
import {
  SchemaRegistry as ManagedKafkaSchemaRegistry,
  SchemaRegistryProvider as ManagedKafkaSchemaRegistryProvider,
} from "./ManagedKafka/SchemaRegistry.ts";
import {
  SchemaRegistriesSubjectsVersion,
  SchemaRegistriesSubjectsVersionProvider,
} from "./ManagedKafka/SchemaRegistriesSubjectsVersion.ts";
import {
  SchemaRegistriesContextsSubjectsVersion,
  SchemaRegistriesContextsSubjectsVersionProvider,
} from "./ManagedKafka/SchemaRegistriesContextsSubjectsVersion.ts";
import {
  RepositoriesBranchRule,
  RepositoriesBranchRuleProvider,
} from "./SecureSourceManager/RepositoriesBranchRule.ts";
import {
  RepositoriesHook,
  RepositoriesHookProvider,
} from "./SecureSourceManager/RepositoriesHook.ts";
import {
  RepositoriesIssue,
  RepositoriesIssueProvider,
} from "./SecureSourceManager/RepositoriesIssue.ts";
import {
  RepositoriesIssuesIssueComment,
  RepositoriesIssuesIssueCommentProvider,
} from "./SecureSourceManager/RepositoriesIssuesIssueComment.ts";
import {
  RepositoriesPullRequestsPullRequestComment,
  RepositoriesPullRequestsPullRequestCommentProvider,
} from "./SecureSourceManager/RepositoriesPullRequestsPullRequestComment.ts";
import { GetClusterHttp as GetManagedKafkaClusterHttp } from "./ManagedKafka/GetClusterHttp.ts";
import { GetTopicHttp as GetManagedKafkaTopicHttp } from "./ManagedKafka/GetTopicHttp.ts";
import { GetConnectClusterHttp as GetManagedKafkaConnectClusterHttp } from "./ManagedKafka/GetConnectClusterHttp.ts";
import { GetSchemaRegistryHttp as GetManagedKafkaSchemaRegistryHttp } from "./ManagedKafka/GetSchemaRegistryHttp.ts";
import {
  CatalogsBranchesProduct,
  CatalogsBranchesProductProvider,
} from "./Retail/CatalogsBranchesProduct.ts";
import {
  CatalogsControl,
  CatalogsControlProvider,
} from "./Retail/CatalogsControl.ts";
import {
  CatalogsModel,
  CatalogsModelProvider,
} from "./Retail/CatalogsModel.ts";
import {
  CatalogsServingConfig,
  CatalogsServingConfigProvider,
} from "./Retail/CatalogsServingConfig.ts";
import { SearchHttp as RetailSearchHttp } from "./Retail/SearchHttp.ts";
import { PredictHttp as RetailPredictHttp } from "./Retail/PredictHttp.ts";
import {
  CatalogsCatalogItem,
  CatalogsCatalogItemProvider,
} from "./RecommendationEngine/CatalogsCatalogItem.ts";
import { GetCatalogItemHttp } from "./RecommendationEngine/GetCatalogItemHttp.ts";
import {
  Processor as DocumentaiProcessor,
  ProcessorProvider as DocumentaiProcessorProvider,
} from "./DocumentAI/Processor.ts";
import {
  Schema as DocumentaiSchema,
  SchemaProvider as DocumentaiSchemaProvider,
} from "./DocumentAI/Schema.ts";
import {
  SchemasSchemaVersion,
  SchemasSchemaVersionProvider,
} from "./DocumentAI/SchemasSchemaVersion.ts";
import { ProcessHttp as DocumentaiProcessHttp } from "./DocumentAI/ProcessHttp.ts";
import { GetProcessorHttp } from "./DocumentAI/GetProcessorHttp.ts";
import { GetSchemaHttp as DocumentaiGetSchemaHttp } from "./DocumentAI/GetSchemaHttp.ts";
import { GetSchemaVersionHttp } from "./DocumentAI/GetSchemaVersionHttp.ts";
import {
  AdaptiveMtDataset,
  AdaptiveMtDatasetProvider,
} from "./Translate/AdaptiveMtDataset.ts";
import {
  GlossariesGlossaryEntry,
  GlossariesGlossaryEntryProvider,
} from "./Translate/GlossariesGlossaryEntry.ts";
import {
  Model as TranslateModel,
  ModelProvider as TranslateModelProvider,
} from "./Translate/Model.ts";
import { AdaptiveMtTranslateHttp } from "./Translate/AdaptiveMtTranslateHttp.ts";
import { GetAdaptiveMtDatasetHttp } from "./Translate/GetAdaptiveMtDatasetHttp.ts";
import { GetGlossariesGlossaryEntryHttp } from "./Translate/GetGlossariesGlossaryEntryHttp.ts";
import { GetModelHttp as TranslateGetModelHttp } from "./Translate/GetModelHttp.ts";
import { TranslateTextHttp } from "./Translate/TranslateTextHttp.ts";
import {
  WorkstationCluster,
  WorkstationClusterProvider,
} from "./Workstations/WorkstationCluster.ts";
import {
  WorkstationClustersWorkstationConfig,
  WorkstationClustersWorkstationConfigProvider,
} from "./Workstations/WorkstationClustersWorkstationConfig.ts";
import {
  WorkstationClustersWorkstationConfigsWorkstation,
  WorkstationClustersWorkstationConfigsWorkstationProvider,
} from "./Workstations/WorkstationClustersWorkstationConfigsWorkstation.ts";
import { GetWorkstationClusterHttp } from "./Workstations/GetWorkstationClusterHttp.ts";
import { GetWorkstationConfigHttp } from "./Workstations/GetWorkstationConfigHttp.ts";
import { GetWorkstationHttp } from "./Workstations/GetWorkstationHttp.ts";
import { GenerateAccessTokenHttp } from "./Workstations/GenerateAccessTokenHttp.ts";
import { StartWorkstationHttp } from "./Workstations/StartWorkstationHttp.ts";
import { StopWorkstationHttp } from "./Workstations/StopWorkstationHttp.ts";
import {
  Evaluation as WorkloadmanagerEvaluation,
  EvaluationProvider as WorkloadmanagerEvaluationProvider,
} from "./WorkloadManager/Evaluation.ts";
import {
  DeploymentsActuation,
  DeploymentsActuationProvider,
} from "./WorkloadManager/DeploymentsActuation.ts";
import {
  Workload as AssuredworkloadsWorkload,
  WorkloadProvider as AssuredworkloadsWorkloadProvider,
} from "./AssuredWorkloads/Workload.ts";
import {
  ConnectionsEntityTypesEntity,
  ConnectionsEntityTypesEntityProvider,
} from "./Connectors/ConnectionsEntityTypesEntity.ts";
import { GetEntityHttp } from "./Connectors/GetEntityHttp.ts";

import { Agent, AgentProvider } from "./AIPlatform/Agent.ts";
import {
  BatchPredictionJob,
  BatchPredictionJobProvider,
} from "./AIPlatform/BatchPredictionJob.ts";
import {
  CachedContent,
  CachedContentProvider,
} from "./AIPlatform/CachedContent.ts";
import { CustomJob, CustomJobProvider } from "./AIPlatform/CustomJob.ts";
import {
  DataLabelingJob,
  DataLabelingJobProvider,
} from "./AIPlatform/DataLabelingJob.ts";
import {
  DeploymentResourcePool,
  DeploymentResourcePoolProvider,
} from "./AIPlatform/DeploymentResourcePool.ts";
import {
  EvaluationItem,
  EvaluationItemProvider,
} from "./AIPlatform/EvaluationItem.ts";
import {
  EvaluationRun,
  EvaluationRunProvider,
} from "./AIPlatform/EvaluationRun.ts";
import {
  EvaluationSet,
  EvaluationSetProvider,
} from "./AIPlatform/EvaluationSet.ts";
import {
  FeatureGroup,
  FeatureGroupProvider,
} from "./AIPlatform/FeatureGroup.ts";
import {
  FeatureGroupsFeature,
  FeatureGroupsFeatureProvider,
} from "./AIPlatform/FeatureGroupsFeature.ts";
import {
  FeatureOnlineStore,
  FeatureOnlineStoreProvider,
} from "./AIPlatform/FeatureOnlineStore.ts";
import {
  Featurestore,
  FeaturestoreProvider,
} from "./AIPlatform/Featurestore.ts";
import {
  FeaturestoresEntityType,
  FeaturestoresEntityTypeProvider,
} from "./AIPlatform/FeaturestoresEntityType.ts";
import {
  HyperparameterTuningJob,
  HyperparameterTuningJobProvider,
} from "./AIPlatform/HyperparameterTuningJob.ts";
import { TuningJob, TuningJobProvider } from "./AIPlatform/TuningJob.ts";
import {
  Index as AIPlatformIndex,
  IndexProvider as AIPlatformIndexProvider,
} from "./AIPlatform/Indexes.ts";
import {
  Endpoint as AIPlatformEndpoint,
  EndpointProvider as AIPlatformEndpointProvider,
} from "./AIPlatform/Endpoint.ts";
import {
  IndexEndpoint,
  IndexEndpointProvider,
} from "./AIPlatform/IndexEndpoint.ts";
import {
  MetadataStore,
  MetadataStoreProvider,
} from "./AIPlatform/MetadataStore.ts";
import {
  MetadataStoresArtifact,
  MetadataStoresArtifactProvider,
} from "./AIPlatform/MetadataStoresArtifact.ts";
import {
  MetadataStoresContext,
  MetadataStoresContextProvider,
} from "./AIPlatform/MetadataStoresContext.ts";
import {
  MetadataStoresExecution,
  MetadataStoresExecutionProvider,
} from "./AIPlatform/MetadataStoresExecution.ts";
import { NasJob, NasJobProvider } from "./AIPlatform/NasJob.ts";
import {
  NotebookExecutionJob,
  NotebookExecutionJobProvider,
} from "./AIPlatform/NotebookExecutionJob.ts";
import {
  NotebookRuntimeTemplate,
  NotebookRuntimeTemplateProvider,
} from "./AIPlatform/NotebookRuntimeTemplate.ts";
import {
  OnlineEvaluator,
  OnlineEvaluatorProvider,
} from "./AIPlatform/OnlineEvaluator.ts";
import {
  PersistentResource,
  PersistentResourceProvider,
} from "./AIPlatform/PersistentResource.ts";
import { PipelineJob, PipelineJobProvider } from "./AIPlatform/PipelineJob.ts";
import { RagCorpora, RagCorporaProvider } from "./AIPlatform/RagCorpora.ts";
import {
  ReasoningEnginesMemory,
  ReasoningEnginesMemoryProvider,
} from "./AIPlatform/ReasoningEnginesMemory.ts";
import {
  AnalyticsDatastore,
  AnalyticsDatastoreProvider,
} from "./Apigee/AnalyticsDatastore.ts";
import {
  ApimServiceExtension,
  ApimServiceExtensionProvider,
} from "./Apigee/ApimServiceExtension.ts";
import { Apiproduct, ApiproductProvider } from "./Apigee/Apiproduct.ts";
import {
  ApiproductsRateplan,
  ApiproductsRateplanProvider,
} from "./Apigee/ApiproductsRateplan.ts";
import {
  ApisKeyvaluemap,
  ApisKeyvaluemapProvider,
} from "./Apigee/ApisKeyvaluemap.ts";
import {
  ApisKeyvaluemapsEntry,
  ApisKeyvaluemapsEntryProvider,
} from "./Apigee/ApisKeyvaluemapsEntry.ts";
import { Appgroup, AppgroupProvider } from "./Apigee/Appgroup.ts";
import { AppgroupsApp, AppgroupsAppProvider } from "./Apigee/AppgroupsApp.ts";
import {
  EnvironmentsKeystore,
  EnvironmentsKeystoreProvider,
} from "./Apigee/EnvironmentsKeystore.ts";
import {
  EnvironmentsKeyvaluemap,
  EnvironmentsKeyvaluemapProvider,
} from "./Apigee/EnvironmentsKeyvaluemap.ts";
import {
  EnvironmentsReference,
  EnvironmentsReferenceProvider,
} from "./Apigee/EnvironmentsReference.ts";
import {
  EnvironmentsResourcefile,
  EnvironmentsResourcefileProvider,
} from "./Apigee/EnvironmentsResourcefile.ts";
import {
  EnvironmentsSecurityAction,
  EnvironmentsSecurityActionProvider,
} from "./Apigee/EnvironmentsSecurityAction.ts";
import {
  EnvironmentsTargetserver,
  EnvironmentsTargetserverProvider,
} from "./Apigee/EnvironmentsTargetserver.ts";
import {
  InstancesAttachment,
  InstancesAttachmentProvider,
} from "./Apigee/InstancesAttachment.ts";
import {
  InstancesNatAddress,
  InstancesNatAddressProvider,
} from "./Apigee/InstancesNatAddress.ts";
import { Keyvaluemap, KeyvaluemapProvider } from "./Apigee/Keyvaluemap.ts";
import {
  KeyvaluemapsEntry,
  KeyvaluemapsEntryProvider,
} from "./Apigee/KeyvaluemapsEntry.ts";
import { Organization, OrganizationProvider } from "./Apigee/Organization.ts";
import {
  SecurityFeedback,
  SecurityFeedbackProvider,
} from "./Apigee/SecurityFeedback.ts";
import {
  SecurityProfilesV2,
  SecurityProfilesV2Provider,
} from "./Apigee/SecurityProfilesV2.ts";
import { Sharedflow, SharedflowProvider } from "./Apigee/Sharedflow.ts";
import {
  SitesApicategory,
  SitesApicategoryProvider,
} from "./Apigee/SitesApicategory.ts";
import { SitesApidoc, SitesApidocProvider } from "./Apigee/SitesApidoc.ts";
import {
  Assignment,
  AssignmentProvider,
} from "./BigQueryReservation/Assignment.ts";
import { AndroidApp, AndroidAppProvider } from "./Firebase/AndroidApp.ts";
import {
  CustomersDeploymentsDevice as SasportalCustomersDeploymentsDevice,
  CustomersDeploymentsDeviceProvider as SasportalCustomersDeploymentsDeviceProvider,
} from "./SasPortal/CustomersDeploymentsDevice.ts";
import {
  CustomersNodesDeployment as SasportalCustomersNodesDeployment,
  CustomersNodesDeploymentProvider as SasportalCustomersNodesDeploymentProvider,
} from "./SasPortal/CustomersNodesDeployment.ts";
import {
  CustomersNodesDevice as SasportalCustomersNodesDevice,
  CustomersNodesDeviceProvider as SasportalCustomersNodesDeviceProvider,
} from "./SasPortal/CustomersNodesDevice.ts";
import {
  CustomersNodesNode as SasportalCustomersNodesNode,
  CustomersNodesNodeProvider as SasportalCustomersNodesNodeProvider,
} from "./SasPortal/CustomersNodesNode.ts";
import {
  NodesDeploymentsDevice as SasportalNodesDeploymentsDevice,
  NodesDeploymentsDeviceProvider as SasportalNodesDeploymentsDeviceProvider,
} from "./SasPortal/NodesDeploymentsDevice.ts";
import {
  NodesNodesDeployment as SasportalNodesNodesDeployment,
  NodesNodesDeploymentProvider as SasportalNodesNodesDeploymentProvider,
} from "./SasPortal/NodesNodesDeployment.ts";
import {
  NodesNodesDevice as SasportalNodesNodesDevice,
  NodesNodesDeviceProvider as SasportalNodesNodesDeviceProvider,
} from "./SasPortal/NodesNodesDevice.ts";
import {
  NodesNodesNode as SasportalNodesNodesNode,
  NodesNodesNodeProvider as SasportalNodesNodesNodeProvider,
} from "./SasPortal/NodesNodesNode.ts";
import {
  SignedCustomersDevice as SasportalSignedCustomersDevice,
  SignedCustomersDeviceProvider as SasportalSignedCustomersDeviceProvider,
} from "./SasPortal/SignedCustomersDevice.ts";
import {
  SignedCustomersNodesDevice as SasportalSignedCustomersNodesDevice,
  SignedCustomersNodesDeviceProvider as SasportalSignedCustomersNodesDeviceProvider,
} from "./SasPortal/SignedCustomersNodesDevice.ts";
import {
  SignedNodesDevice as SasportalSignedNodesDevice,
  SignedNodesDeviceProvider as SasportalSignedNodesDeviceProvider,
} from "./SasPortal/SignedNodesDevice.ts";
import {
  SignedNodesNodesDevice as SasportalSignedNodesNodesDevice,
  SignedNodesNodesDeviceProvider as SasportalSignedNodesNodesDeviceProvider,
} from "./SasPortal/SignedNodesNodesDevice.ts";
import {
  ScanConfig,
  ScanConfigProvider,
} from "./WebSecurityScanner/ScanConfig.ts";
import {
  FeaturestoresEntityTypesFeature,
  FeaturestoresEntityTypesFeatureProvider,
} from "./AIPlatform/FeaturestoresEntityTypesFeature.ts";
import {
  ModelDeploymentMonitoringJob,
  ModelDeploymentMonitoringJobProvider,
} from "./AIPlatform/ModelDeploymentMonitoringJob.ts";
import {
  FeatureOnlineStoresFeatureView,
  FeatureOnlineStoresFeatureViewProvider,
} from "./AIPlatform/FeatureOnlineStoresFeatureView.ts";
import {
  EnvironmentsKeystoresAlias,
  EnvironmentsKeystoresAliasProvider,
} from "./Apigee/EnvironmentsKeystoresAlias.ts";
import {
  EnvironmentsKeyvaluemapsEntry,
  EnvironmentsKeyvaluemapsEntryProvider,
} from "./Apigee/EnvironmentsKeyvaluemapsEntry.ts";
import {
  SecurityMonitoringCondition,
  SecurityMonitoringConditionProvider,
} from "./Apigee/SecurityMonitoringCondition.ts";
import {
  EnvironmentsArchiveDeployment,
  EnvironmentsArchiveDeploymentProvider,
} from "./Apigee/EnvironmentsArchiveDeployment.ts";
import {
  EnvironmentsTraceConfigOverride,
  EnvironmentsTraceConfigOverrideProvider,
} from "./Apigee/EnvironmentsTraceConfigOverride.ts";
import {
  EnvironmentsApisRevisionsDebugsession,
  EnvironmentsApisRevisionsDebugsessionProvider,
} from "./Apigee/EnvironmentsApisRevisionsDebugsession.ts";
import {
  HostServiceAccount,
  HostServiceAccountProvider,
} from "./IAM/HostServiceAccount.ts";
import {
  Member as IamMember,
  MemberProvider as IamMemberProvider,
} from "./IAM/Member.ts";
import {
  Policy as IamPolicy,
  PolicyProvider as IamPolicyProvider,
} from "./IAM/Policy.ts";
import {
  SignedCustomersDeploymentsDevice as SasportalSignedCustomersDeploymentsDevice,
  SignedCustomersDeploymentsDeviceProvider as SasportalSignedCustomersDeploymentsDeviceProvider,
} from "./SasPortal/SignedCustomersDeploymentsDevice.ts";
import {
  SignedNodesDeploymentsDevice as SasportalSignedNodesDeploymentsDevice,
  SignedNodesDeploymentsDeviceProvider as SasportalSignedNodesDeploymentsDeviceProvider,
} from "./SasPortal/SignedNodesDeploymentsDevice.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "GCP",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all GCP resource providers, the GCP
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as GCP from "alchemy/GCP";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: GCP.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
/** Auth + env + HTTP client for resource providers, HTTP bindings, and GKE. */
const gcpLive = fromCredentials().pipe(
  Layer.provideMerge(Credentials.fromAuthProvider()),
  Layer.provideMerge(GcpAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const makeProviders = () =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      // Each `Provider.collection` chunk is erased to its runtime shape:
      // its requirements (one Provider<X> per resource type) are satisfied
      // by the `Layer.provide` below, and letting tsc infer ~1,000 of them
      // exhausts the type-checker's memory.
      const merged: Record<string, any> = {};
      Object.assign(
        merged,
        (yield* Provider.collection([
          Bucket,
          Notification,
          HmacKey,
          BucketAccessControl,
          DefaultObjectAccessControl,
          Folder,
          Managed,
          ObjectAccessControl,
          StorageObject,
          AgentPool,
          TransferJob,
          Topic,
          Subscription,
          Schema,
          PubSubSnapshot,
          AdminReservation,
          AdminTopic,
          AdminSubscription,
          KeyRing,
          CryptoKey,
          CryptoKeyVersion,
          ImportJob,
          SingleTenantHsmInstanceProposal,
          Sink,
          Metric,
          LogBucket,
          Exclusion,
          BucketsView,
          BucketsLink,
          LogScope,
          SavedQuery,
          BillingExclusion,
          BillingBucket,
          BillingBucketsLink,
          BillingBucketsView,
          BillingSavedQuery,
          BillingSink,
          FolderExclusion,
          FolderBucket,
          FolderBucketsLink,
          FolderBucketsView,
          FolderLogScope,
          FolderSavedQuery,
          FolderSink,
          LocationsBucket,
          LocationsBucketsLink,
          LocationsBucketsView,
          OrganizationExclusion,
          OrganizationLogBucket,
          OrganizationBucketsLink,
          OrganizationBucketsView,
          OrganizationLogScope,
          OrganizationSavedQuery,
          OrganizationSink,
          Secret,
          LocationsSecret,
          Parameter,
          ParametersVersion,
          TagValue,
          Certificate,
          CertificateMap,
          CertificateMapEntry,
          DnsAuthorization,
          TrustConfig,
          CertificateIssuanceConfig,
          CaPool,
          CertificateAuthority,
          CertificateTemplate,
          Dataset,
          Table,
          Routine,
          BigQueryJob,
          RowAccessPolicy,
          DataPolicy,
          TransferConfig,
          BillingBudget,
          BigQueryConnection,
          Reservation,
          CapacityCommitment,
          ReservationGroup,
          CloudFunction,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          Database,
          DatabasesBackupSchedule,
          DatabasesCollectionGroupsIndex,
          DatabasesUserCred,
          DatastoreIndex,
          RedisInstance,
          AclPolicy,
          CatalogsBranchesProduct,
          CatalogsControl,
          CatalogsModel,
          CatalogsServingConfig,
          CatalogsCatalogItem,
          MemcacheInstance,
          MlModel,
          ModelsVersion,
          FilestoreInstance,
          FilestoreBackup,
          FilestoreInstancesSnapshot,
          TpuNode,
          TpuQueuedResource,
          FirebaseapphostingBackend,
          BackendsBuild,
          BackendsDomain,
          FirebaserulesRuleset,
          FirebaserulesRelease,
          AppsDebugToken,
          ServicesResourcePolicy,
          FirebaseappdistributionGroup,
          FirebasedataconnectService,
          ServicesSchema,
          ServicesConnector,
          NetappActiveDirectory,
          NetappBackupPolicy,
          NetappBackupVault,
          NetappBackupVaultsBackup,
          NetappHostGroup,
          NetappKmsConfig,
          NetappStoragePool,
          NetappVolume,
          NetappVolumesQuotaRule,
          SpannerInstance,
          SpannerDatabase,
          SpannerInstanceConfig,
          SpannerInstancesBackup,
          SpannerInstancesDatabasesBackupSchedule,
          SpannerInstancesInstancePartition,
          AlloyDbCluster,
          AlloyDbInstance,
          AlloyDbBackup,
          AlloyDbClustersUser,
          GoldengateDeployment,
          OdbNetwork,
          OdbNetworksOdbSubnet,
          AutonomousDatabase,
          CloudExadataInfrastructure,
          CloudVmCluster,
          DbSystem,
          ExadbVmCluster,
          ExascaleDbStorageVault,
          GoldengateConnection,
          GoldengateConnectionAssignment,
          BigtableInstance,
          BigtableCluster,
          BigtableAppProfile,
          BigtableTable,
          BigtableInstancesClustersBackup,
          BigtableInstancesLogicalView,
          BigtableInstancesMaterializedView,
          BigtableInstancesTablesAuthorizedView,
          BigtableInstancesTablesSchemaBundle,
          DataprocCluster,
          DataprocAutoscalingPolicy,
          DataprocBatche,
          DataprocRegionsAutoscalingPolicy,
          DataprocRegionsWorkflowTemplate,
          DataprocSession,
          DataprocSessionTemplate,
          DataprocWorkflowTemplate,
          Cluster,
          NodePool,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          ClustersNodePool,
          SqlInstance,
          SqlDatabase,
          SqlSslCert,
          SqlUser,
          SqlBackupBackup,
          SqlBackupRun,
          Repository,
          RepositoriesAttachment,
          RepositoriesPackagesTag,
          RepositoriesRule,
          Queue,
          Job,
          CloudRunJob,
          Service,
          WebsiteServer,
          WorkerPool,
          ManagedZone,
          DnsPolicy,
          ResourceRecordSet,
          ResponsePolicy,
          ResponsePolicyRule,
          Address,
          BackendBucket,
          BackendService,
          RegionBackendService,
          HealthCheck,
          HttpHealthCheck,
          HttpsHealthCheck,
          RegionHealthCheck,
          Image,
          MachineImage,
          Instance,
          InstanceGroup,
          InstanceGroupManager,
          Autoscaler,
          RegionAutoscaler,
          InstanceTemplate,
          RegionInstanceGroupManager,
          Disk,
          RegionDisk,
          Snapshot,
          InstantSnapshot,
          InstantSnapshotGroup,
          CrossSiteNetwork,
          FutureReservation,
          GlobalPublicDelegatedPrefix,
          GlobalVmExtensionPolicy,
          InstanceGroupManagerResizeRequest,
          Network,
          NetworkEndpointGroup,
          GlobalNetworkEndpointGroup,
          Subnetwork,
          GlobalAddress,
          RegionNetworkEndpointGroup,
          Route,
          ResourcePolicy,
          SecurityPolicy,
          OrganizationSecurityPolicy,
          PublicAdvertisedPrefix,
          PublicDelegatedPrefix,
          RegionBackendBucket,
          RegionCompositeHealthCheck,
          RegionHealthAggregationPolicy,
          RegionHealthCheckService,
          RegionHealthSource,
          RegionInstanceGroupManagerResizeRequest,
          RegionInstanceTemplate,
          ServiceAttachment,
          Interconnect,
          InterconnectAttachment,
          InterconnectGroup,
          InterconnectAttachmentGroup,
          License,
          NetworkAttachment,
          NetworkEdgeSecurityService,
          NetworkFirewallPolicy,
          NodeGroup,
          NodeTemplate,
          Router,
          Firewall,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          FirewallPolicy,
          ForwardingRule,
          PacketMirroring,
          UrlMap,
          RegionUrlMap,
          TargetHttpProxy,
          RegionTargetHttpProxy,
          TargetHttpsProxy,
          TargetInstance,
          TargetPool,
          TargetSslProxy,
          TargetTcpProxy,
          TargetGrpcProxy,
          GlobalForwardingRule,
          SslCertificate,
          SslPolicy,
          RegionSslCertificate,
          RegionSslPolicy,
          RegionNetworkFirewallPolicy,
          RegionNotificationEndpoint,
          RegionSecurityPolicy,
          RegionSnapshot,
          RegionInstantSnapshot,
          RegionInstantSnapshotGroup,
          RegionTargetHttpsProxy,
          RegionTargetTcpProxy,
          VpnGateway,
          TargetVpnGateway,
          ExternalVpnGateway,
          VpnTunnel,
          ComputeReservation,
          RolloutPlan,
          StoragePool,
          WireGroup,
          ZoneVmExtensionPolicy,
          Connector,
          Connection,
          CloudBuildConnection,
          CloudBuildRepository,
          Workflow,
          Trigger,
          Channel,
          MessageBus,
          Pipeline,
          Enrollment,
          GoogleApiSource,
          ChannelConnection,
          EssentialcontactsContact,
          FolderContact,
          OrganizationContact,
          Namespace,
          ServiceDirectoryService,
          ServiceDirectoryEndpoint,
          ServicemanagementService,
          TagKey,
          TagBinding,
          ResourceManagerFolder,
          Lien,
          ResourceManagerProject,
          Key,
          AgentregistryBinding,
          RecaptchaenterpriseKey,
          RecaptchaenterpriseFirewallpolicy,
          Policy,
          CustomConstraint,
          AccessPolicy,
          AccessPoliciesAccessLevel,
          AccessPoliciesAuthorizedOrgsDesc,
          AccessPoliciesServicePerimeter,
          GcpUserAccessBinding,
          Hub,
          Spoke,
          InternalRange,
          PolicyBasedRoute,
          Transport,
          AutomatedDnsRecord,
          MulticloudDataTransferConfig,
          MulticloudDataTransferConfigsDestination,
          RegionalEndpoint,
          ServiceConnectionMap,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          ServiceConnectionPolicy,
          ServiceConnectionToken,
          SpokesGatewayAdvertisedRoute,
          VpcFlowLogsConfig,
          OrganizationsVpcFlowLogsConfig,
          ConnectivityTest,
          NetworkMonitoringProvider,
          AlertPolicy,
          NotificationChannel,
          UptimeCheckConfig,
          MonitoringGroup,
          MetricDescriptor,
          MonitoringService,
          ServicesServiceLevelObjective,
          TraceScope,
          BucketsDatasetsLink,
          ComposerEnvironment,
          EnvironmentsUserWorkloadsConfigMap,
          EnvironmentsUserWorkloadsSecret,
          AppgroupsAppsKey,
          Datacollector,
          Developer,
          DevelopersApp,
          DevelopersAppsKey,
          DnsZone,
          EndpointAttachment,
          Envgroup,
          EnvgroupsAttachment,
          ApigeeEnvironment,
          TrainingPipeline,
          AIPlatformDataset,
          DatasetsDatasetVersion,
          ReasoningEngine,
          ReasoningEnginesSandboxEnvironmentTemplate,
          ReasoningEnginesSandboxEnvironment,
          ReasoningEnginesSession,
          Schedule,
          SemanticGovernancePolicy,
          SpecialistPool,
          Study,
          StudiesTrial,
          Tensorboard,
          TensorboardsExperiment,
          TensorboardsExperimentsRun,
          TensorboardsExperimentsRunsTimeSeries,
          ClientTlsPolicy,
          DnsThreatDetector,
          FirewallEndpoint,
          FirewallEndpointAssociation,
          GatewaySecurityPolicy,
          GatewaySecurityPoliciesRule,
          InterceptDeploymentGroup,
          InterceptDeployment,
          InterceptEndpointGroup,
          InterceptEndpointGroupAssociation,
          MirroringDeploymentGroup,
          MirroringDeployment,
          MirroringEndpointGroup,
          MirroringEndpointGroupAssociation,
          SacRealm,
          SacAttachment,
          SecurityProfile,
          SecurityProfileGroup,
          ServerTlsPolicy,
          TlsInspectionPolicy,
          UrlList,
          AddressGroup,
          AuthorizationPolicy,
          AuthzPolicy,
          BackendAuthenticationConfig,
          OrganizationsAddressGroup,
          OrganizationsFirewallEndpoint,
          OrganizationsSecurityProfile,
          OrganizationsSecurityProfileGroup,
          AgentGateway,
          AuthzExtension,
          EndpointPolicy,
          NetworkservicesGateway,
          GrpcRoute,
          HttpRoute,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          LbEdgeExtension,
          LbRouteExtension,
          WasmPlugin,
          WasmPluginsVersion,
          LbTrafficExtension,
          Mesh,
          MulticastConsumerAssociation,
          MulticastGroupConsumerActivation,
          ServiceBinding,
          ServiceLbPolicy,
          TcpRoute,
          TlsRoute,
          AspectType,
          DataAttributeBinding,
          DataDomain,
          DataDomainsBinding,
          DataProduct,
          DataProductsDataAsset,
          DataScan,
          EncryptionConfig,
          DataTaxonomy,
          DataTaxonomiesAttribute,
          EntryGroup,
          EntryGroupsEntry,
          EntryGroupsEntryLink,
          EntryType,
          Glossary,
          GlossariesCategory,
          GlossariesTerm,
          Lake,
          LakesTask,
          LakesZone,
          LakesAsset,
          LakesEntity,
          LakesEntitiesPartition,
          MetadataFeed,
          TagTemplate,
          Taxonomy,
          TaxonomiesPolicyTag,
          DataStoresBranchesDocument,
          DataStoresControl,
          DataStoresConversation,
          DataStoresSchema,
          DataStoresServingConfig,
          DataStoresSession,
          DataStoresSiteSearchEngineTargetSite,
          IdentityMappingStore,
          DataStore,
          CollectionsEngine,
          CollectionsEnginesAssistant,
          CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig,
          CollectionsEnginesControl,
          CollectionsEnginesConversation,
          CollectionsEnginesServingConfig,
          CollectionsEnginesSession,
          CollectionsDataStore,
          CollectionsDataStoresBranchesDocument,
          CollectionsDataStoresControl,
          CollectionsDataStoresConversation,
          CollectionsDataStoresSchema,
          CollectionsDataStoresServingConfig,
          CollectionsDataStoresSession,
          CollectionsDataStoresSiteSearchEngineTargetSite,
          AnalysisRule,
          AssessmentRule,
          AuthorizedViewSet,
          AuthorizedViewSetsAuthorizedView,
          AuthorizedViewSetsAuthorizedViewsConversationsAssessment,
          AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel,
          AutoLabelingRule,
          Conversation,
          ConversationsAnalyses,
          ConversationsAssessment,
          ConversationsFeedbackLabel,
          Dashboard,
          DashboardsChart,
          DatasetsConversationsFeedbackLabel,
          IssueModel,
          IssueModelsIssue,
          PhraseMatcher,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          QaQuestionTag,
          QaScorecard,
          QaScorecardsRevision,
          QaScorecardsRevisionsQaQuestion,
          View,
          ContactCenter,
          AgentsEntityType,
          AgentsEnvironment,
          AgentsEnvironmentsExperiment,
          AgentsEnvironmentsSessionsEntityType,
          AgentsFlow,
          AgentsFlowsPage,
          AgentsFlowsTransitionRouteGroup,
          AgentsFlowsVersion,
          AgentsGenerator,
          AgentsIntent,
          AgentsPlaybook,
          AgentsPlaybooksExample,
          AgentsPlaybooksVersion,
          AgentsSessionsEntityType,
          AgentsTool,
          AgentsToolsVersion,
          AgentsTransitionRouteGroup,
          AgentsWebhook,
          SecuritySetting,
          OrganizationStoredInfoType,
          DeidentifyTemplate,
          DlpJob,
          InspectTemplate,
          JobTrigger,
          ContentPolicy,
          LocationsDeidentifyTemplate,
          LocationsDlpJob,
          LocationsInspectTemplate,
          LocationsJobTrigger,
          LocationsStoredInfoType,
          StoredInfoType,
          DiscoveryConfig,
          OrganizationsDeidentifyTemplate,
          OrganizationsInspectTemplate,
          OrganizationsLocationsConnection,
          OrganizationsLocationsDeidentifyTemplate,
          OrganizationsLocationsDiscoveryConfig,
          OrganizationsLocationsInspectTemplate,
          OrganizationsLocationsJobTrigger,
          OrganizationsLocationsStoredInfoType,
          GmailpostmastertoolsDomain,
          DomainsUser,
          SettingsDatasource,
          SettingsSearchapplication,
          SupportEventSubscription,
          Matter,
          MattersExport,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          MattersHold,
          MattersSavedQuery,
          WorkspaceeventsSubscription,
          TasksPushNotificationConfig,
          JobsTenant,
          TenantsCompany,
          TenantsJob,
          VisionProductSet,
          VisionProduct,
          ProductsReferenceImage,
          CustomClass,
          PhraseSet,
          MonetizationSubscription,
          MonetizationSubscriptionsBasePlansOffer,
          Edit,
          Inappproduct,
          AchievementConfiguration,
          LeaderboardConfiguration,
          Storelayoutcluster,
          Storelayoutpage,
          Webapp,
          AndroidmanagementEnterprise,
          EnterprisesEnrollmentToken,
          EnterprisesWebApp,
          CustomersConfiguration,
          CustomersConnectorConfig,
          AppsAuthorizedCertificate,
          AppsDomainMapping,
          AppsFirewallIngressRule,
          AppsServicesVersion,
          ApplicationsAuthorizedCertificate,
          ApplicationsDomainMapping,
          UsersSshPublicKey,
          LicenseAssignment,
          WebResource,
          CloudassetFeed,
          CloudassetSavedQuery,
          CloudidentityDevice,
          CloudidentityGroup,
          GroupsMembership,
          InboundOidcSsoProfile,
          InboundSamlSsoProfile,
          InboundSsoAssignment,
          CloudchannelCustomer,
          ChannelPartnerLinksCustomer,
          CustomersCustomerRepricingConfig,
          ChannelPartnerLinksChannelPartnerRepricingConfig,
          CloudcontrolspartnerCustomer,
          DeploymentmanagerDeployment,
          HealthcareDataset,
          DatasetsConsentStore,
          DatasetsConsentStoresAttributeDefinition,
          DatasetsConsentStoresConsent,
          DatasetsConsentStoresConsentArtifact,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          DatasetsConsentStoresUserDataMapping,
          DatasetsDicomStore,
          DatasetsFhirStore,
          DatasetsHl7V2Store,
          DatasetsHl7V2StoresMessage,
          BrandsIdentityAwareProxyClient,
          IapDestGroup,
          FolderBigQueryExport,
          FolderEventThreatDetectionSettingsCustomModule,
          FolderMuteConfig,
          FolderNotificationConfig,
          FolderSecurityHealthAnalyticsSettingsCustomModule,
          OrganizationBigQueryExport,
          OrganizationEventThreatDetectionSettingsCustomModule,
          OrganizationMuteConfig,
          NotificationConfig,
          OrganizationsNotificationConfig,
          MuteConfig,
          BigQueryExport,
          EventThreatDetectionSettingsCustomModule,
          SecurityHealthAnalyticsSettingsCustomModule,
          OrganizationsSecurityHealthAnalyticsSettingsCustomModule,
          Posture,
          PostureDeployment,
          ApihubDeployment,
          ExternalApi,
          Plugin,
          PluginsInstance,
          RuntimeProjectAttachment,
          ApiHubInstance,
          ApihubApi,
          ApisVersion,
          ApisVersionsOperation,
          ApisVersionsSpec,
          ApihubAttribute,
          Curation,
          Dependency,
          Application,
          ApplicationsService,
          ApplicationsWorkload,
          ServiceProjectAttachment,
          ObservationJob,
          ObservationSource,
          ApisConfig,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          MerchantReview,
          ProductReview,
          ContentwarehouseDocumentSchema,
          ContentwarehouseDocument,
          ContentwarehouseRuleSet,
          ContentwarehouseSynonymSet,
          SfdcInstance,
          SfdcInstancesSfdcChannel,
          IntegrationsTemplate,
          AuthConfig,
          IntegrationsVersion,
          IntegrationsVersionsTestCases,
          ProductsAuthConfig,
          ProductsCertificate,
          ProductsIntegrationsVersion,
          ProductsSfdcInstance,
          ProductsSfdcInstancesSfdcChannel,
          MigrationcenterSource,
          MigrationcenterAssetsExportJob,
          MigrationcenterDiscoveryClient,
          MigrationcenterGroup,
          MigrationcenterImportJob,
          MigrationcenterImportJobsImportDataFile,
          MigrationcenterPreferenceSet,
          MigrationcenterReportConfig,
          MigrationcenterReportConfigsReport,
          RapidmigrationassessmentCollector,
          MetastoreFederation,
          MetastoreService,
          MetastoreServicesBackup,
          DataformRepository,
          ProjectsLocationsFolder,
          RepositoriesReleaseConfig,
          RepositoriesWorkflowConfig,
          RepositoriesWorkflowInvocation,
          RepositoriesWorkspace,
          Team,
          VolumesSnapshot,
          VolumesReplication,
          VmwareEngineNetwork,
          PrivateConnection,
          PrivateCloudsManagementDnsZoneBinding,
          VmwareengineDatastore,
          NetworkPeering,
          VmwareengineNetworkPolicy,
          NetworkPoliciesExternalAccessRule,
          PrivateCloud,
          PrivateCloudsCluster,
          PrivateCloudsExternalAddress,
          PrivateCloudsLoggingServer,
          CesApp,
          AppsAgent,
          AppsDeployment,
          AppsExample,
          AppsGuardrail,
          AppsTool,
          AppsToolset,
          AppsVersion,
          SasportalCustomersDeployment,
          SasportalCustomersDevice,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          SasportalCustomersNode,
          SasportalNodesDevice,
          SasportalNodesNode,
          DatalabelingAnnotationSpecSet,
          DatalabelingDataset,
          DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage,
          DatalabelingEvaluationJob,
          DatalabelingInstruction,
          Process,
          ProcessesRun,
          ProcessesRunsLineageEvent,
          DataExchange,
          DataExchangesListing,
          DataExchangesQueryTemplate,
          SaasservicemgmtSaa,
          SaasservicemgmtTenant,
          SaasservicemgmtUnitKind,
          SaasservicemgmtUnit,
          SaasservicemgmtRelease,
          SaasservicemgmtRolloutKind,
          SaasservicemgmtRollout,
          SaasservicemgmtUnitOperation,
          RegistryBook,
          Realm,
          CustomRange,
          IpamAdminScope,
          VmmigrationGroup,
          VmmigrationImageImport,
          VmmigrationSource,
          SourcesDatacenterConnector,
          SourcesDiskMigrationJob,
          SourcesMigratingVm,
          SourcesUtilizationReport,
          VmmigrationTarget,
          DatamigrationConnectionProfile,
          DatamigrationConversionWorkspace,
          ConversionWorkspacesMappingRule,
          DatamigrationMigrationJob,
          DatamigrationPrivateConnection,
          DatastreamConnectionProfile,
          DatastreamPrivateConnection,
          PrivateConnectionsRoute,
          DatastreamStream,
          AccountConnector,
          DeveloperconnectConnection,
          ConnectionsGitRepositoryLink,
          InsightsConfig,
          BackupChannel,
          BackupPlan,
          BackupPlansBackup,
          RestoreChannel,
          RestorePlan,
          RestorePlansRestore,
          MembershipsFeature,
          InstancesBackup,
          BareMetalCluster,
          BareMetalClustersBareMetalNodePool,
          GkeonpremVmwareCluster,
          VmwareClustersVmwareNodePool,
          BackupdrBackupVault,
          BackupdrBackupPlan,
          BackupPlanAssociation,
          BackupdrManagementServer,
          BaremetalsolutionNfsShare,
          BaremetalsolutionVolumesSnapshot,
          ManagedidentitiesDomain,
          ManagedidentitiesDomainsBackup,
          ManagedidentitiesPeering,
          CustomTargetType,
          DeliveryPipeline,
          DeliveryPipelinesAutomation,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          DeployPolicy,
          ClouddeployTarget,
          ConfigDeploymentGroup,
          ConfigPreview,
          AppConnection,
          AppConnector,
          AppGateway,
          SecurityGateway,
          SecurityGatewaysApplication,
          ManagedKafkaCluster,
          ClustersAcl,
          ClustersTopic,
          ManagedKafkaConnectCluster,
          ConnectClustersConnector,
          ManagedKafkaSchemaRegistry,
          SchemaRegistriesSubjectsVersion,
          SchemaRegistriesContextsSubjectsVersion,
          RepositoriesBranchRule,
          RepositoriesHook,
          RepositoriesIssue,
          RepositoriesIssuesIssueComment,
          RepositoriesPullRequestsPullRequestComment,
          ContaineranalysisNote,
          ContaineranalysisOccurrence,
          LocationsNote,
          LocationsOccurrence,
          BinaryauthorizationAttestor,
          PlatformsPolicy,
          BlockchainNode,
          BuyersClientsUser,
          AccountTypesUserList,
          BiddersPretargetingConfig,
          DatapipelinesPipeline,
          AgentidentityAuthProvider,
          BiglakeCatalog,
          CatalogsDatabase,
          CatalogsDatabasesTable,
          DocumentaiProcessor,
          DocumentaiSchema,
          SchemasSchemaVersion,
          FoldersLocationsGlobalPolicyOrchestrator,
          OrganizationsLocationsGlobalPolicyOrchestrator,
          ProjectsLocationsGlobalPolicyOrchestrator,
          AdaptiveMtDataset,
          GlossariesGlossaryEntry,
          TranslateModel,
          WorkstationCluster,
          WorkstationClustersWorkstationConfig,
          WorkstationClustersWorkstationConfigsWorkstation,
          AssuredworkloadsWorkload,
          WorkloadmanagerEvaluation,
          DeploymentsActuation,
          ConnectionsEntityTypesEntity,
          Agent,
          BatchPredictionJob,
          CachedContent,
          CustomJob,
          DataLabelingJob,
          DeploymentResourcePool,
          EvaluationItem,
          EvaluationRun,
          EvaluationSet,
          FeatureGroup,
          FeatureGroupsFeature,
          FeatureOnlineStore,
          Featurestore,
          FeaturestoresEntityType,
          HyperparameterTuningJob,
          TuningJob,
          AIPlatformIndex,
          IndexEndpoint,
          AIPlatformEndpoint,
          MetadataStore,
          MetadataStoresArtifact,
          MetadataStoresContext,
          MetadataStoresExecution,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          NasJob,
          NotebookExecutionJob,
          NotebookRuntimeTemplate,
          OnlineEvaluator,
          PersistentResource,
          PipelineJob,
          RagCorpora,
          ReasoningEnginesMemory,
          AnalyticsDatastore,
          ApimServiceExtension,
          Apiproduct,
          ApiproductsRateplan,
          ApisKeyvaluemap,
          ApisKeyvaluemapsEntry,
          Appgroup,
          AppgroupsApp,
          EnvironmentsKeystore,
          EnvironmentsKeyvaluemap,
          EnvironmentsReference,
          EnvironmentsResourcefile,
          EnvironmentsSecurityAction,
          EnvironmentsTargetserver,
          InstancesAttachment,
          InstancesNatAddress,
          Keyvaluemap,
          KeyvaluemapsEntry,
          Organization,
          SecurityFeedback,
          SecurityProfilesV2,
          Sharedflow,
          SitesApicategory,
          SitesApidoc,
          Assignment,
          AndroidApp,
          SasportalCustomersDeploymentsDevice,
          SasportalCustomersNodesDeployment,
          SasportalCustomersNodesDevice,
          SasportalCustomersNodesNode,
          SasportalNodesDeploymentsDevice,
          SasportalNodesNodesDeployment,
          SasportalNodesNodesDevice,
          SasportalNodesNodesNode,
          SasportalSignedCustomersDevice,
          SasportalSignedCustomersNodesDevice,
          SasportalSignedNodesDevice,
          SasportalSignedNodesNodesDevice,
          ScanConfig,
          FeaturestoresEntityTypesFeature,
          ModelDeploymentMonitoringJob,
          FeatureOnlineStoresFeatureView,
          EnvironmentsKeystoresAlias,
          EnvironmentsKeyvaluemapsEntry,
          SecurityMonitoringCondition,
          EnvironmentsArchiveDeployment,
          EnvironmentsTraceConfigOverride,
          EnvironmentsApisRevisionsDebugsession,
          IamPolicy,
          HostServiceAccount,
          IamMember,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      Object.assign(
        merged,
        (yield* Provider.collection([
          SasportalSignedCustomersDeploymentsDevice,
          SasportalSignedNodesDeploymentsDevice,
          JobTemplate,
        ]) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers,
      );
      return {
        kind: "ProviderCollection" as const,
        get: (service: string) => merged[service],
        providers: merged,
      };
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mergeAll(
          Layer.mergeAll(
            BucketProvider(),
            NotificationProvider(),
            TopicProvider(),
            SubscriptionProvider(),
            SchemaProvider(),
            PubSubSnapshotProvider(),
            Layer.mergeAll(
              KeyRingProvider(),
              CryptoKeyProvider(),
              CryptoKeyVersionProvider(),
              ImportJobProvider(),
              SingleTenantHsmInstanceProposalProvider(),
            ),
            SinkProvider(),
            MetricProvider(),
            Layer.mergeAll(SecretProvider(), LocationsSecretProvider()),
            Layer.mergeAll(ParameterProvider(), ParametersVersionProvider()),
            CertificateProvider(),
            CertificateMapProvider(),
            CertificateMapEntryProvider(),
            DnsAuthorizationProvider(),
            TrustConfigProvider(),
            CertificateIssuanceConfigProvider(),
            DatasetProvider(),
            TableProvider(),
          ),
          Layer.mergeAll(
            BucketAccessControlProvider(),
            DefaultObjectAccessControlProvider(),
            FolderProvider(),
            ManagedProvider(),
            ObjectAccessControlProvider(),
            StorageObjectProvider(),
            AgentPoolProvider(),
            TransferJobProvider(),
          ),
        ),
        Layer.mergeAll(
          FunctionProvider(),
          RoutineProvider(),
          HmacKeyProvider(),
          Layer.mergeAll(
            DatabaseProvider(),
            DatabasesBackupScheduleProvider(),
            DatabasesCollectionGroupsIndexProvider(),
            DatabasesUserCredProvider(),
            DatastoreIndexProvider(),
          ),
          Layer.mergeAll(RedisInstanceProvider(), AclPolicyProvider()),
          MemcacheInstanceProvider(),
          Layer.mergeAll(MlModelProvider(), ModelsVersionProvider()),
          Layer.mergeAll(
            FilestoreInstanceProvider(),
            FilestoreBackupProvider(),
            FilestoreInstancesSnapshotProvider(),
            TpuNodeProvider(),
            TpuQueuedResourceProvider(),
          ),
          Layer.mergeAll(
            ClusterProvider(),
            NodePoolProvider(),
            ClustersNodePoolProvider(),
          ),
          Layer.mergeAll(
            SqlInstanceProvider(),
            SqlDatabaseProvider(),
            SqlSslCertProvider(),
            SqlUserProvider(),
            SqlBackupBackupProvider(),
            SqlBackupRunProvider(),
          ),
          RepositoryProvider(),
          QueueProvider(),
          JobProvider(),
          CloudRunJobProvider(),
          ServiceProvider(),
          WebsiteServerProvider(),
          WorkerPoolProvider(),
        ),
        Layer.mergeAll(
          ManagedZoneProvider(),
          ResourceRecordSetProvider(),
          DnsPolicyProvider(),
          ResponsePolicyProvider(),
          ResponsePolicyRuleProvider(),
          RepositoriesAttachmentProvider(),
          RepositoriesPackagesTagProvider(),
          RepositoriesRuleProvider(),
          BigQueryJobProvider(),
          RowAccessPolicyProvider(),
          DataPolicyProvider(),
        ),
        Layer.mergeAll(
          AddressProvider(),
          BackendBucketProvider(),
          BackendServiceProvider(),
          HealthCheckProvider(),
          ImageProvider(),
          MachineImageProvider(),
          InstanceProvider(),
          InstanceGroupProvider(),
          InstanceGroupManagerProvider(),
          AutoscalerProvider(),
          RegionAutoscalerProvider(),
          InstanceTemplateProvider(),
          RegionInstanceGroupManagerProvider(),
          NetworkProvider(),
          NetworkEndpointGroupProvider(),
          SubnetworkProvider(),
          DiskProvider(),
          GlobalAddressProvider(),
          RegionNetworkEndpointGroupProvider(),
        ),
        Layer.mergeAll(
          SnapshotProvider(),
          RegionDiskProvider(),
          RouteProvider(),
          RegionBackendServiceProvider(),
          RegionHealthCheckProvider(),
          HttpHealthCheckProvider(),
          ResourcePolicyProvider(),
          SecurityPolicyProvider(),
          ServiceAttachmentProvider(),
          RouterProvider(),
          FirewallProvider(),
          FirewallPolicyProvider(),
          ForwardingRuleProvider(),
          UrlMapProvider(),
          RegionUrlMapProvider(),
          TargetHttpProxyProvider(),
          RegionTargetHttpProxyProvider(),
          TargetHttpsProxyProvider(),
          TargetInstanceProvider(),
        ),
        Layer.mergeAll(
          TargetPoolProvider(),
          HttpsHealthCheckProvider(),
          InstantSnapshotProvider(),
          InstantSnapshotGroupProvider(),
          CrossSiteNetworkProvider(),
          FutureReservationProvider(),
          GlobalPublicDelegatedPrefixProvider(),
          GlobalVmExtensionPolicyProvider(),
          InstanceGroupManagerResizeRequestProvider(),
          GlobalNetworkEndpointGroupProvider(),
        ),
        Layer.mergeAll(
          OrganizationSecurityPolicyProvider(),
          PublicAdvertisedPrefixProvider(),
          PublicDelegatedPrefixProvider(),
          RegionBackendBucketProvider(),
          RegionCompositeHealthCheckProvider(),
          RegionHealthAggregationPolicyProvider(),
          RegionHealthCheckServiceProvider(),
          RegionHealthSourceProvider(),
          RegionInstanceGroupManagerResizeRequestProvider(),
          RegionInstanceTemplateProvider(),
        ),
        Layer.mergeAll(
          RegionSslCertificateProvider(),
          RegionSslPolicyProvider(),
          RegionNetworkFirewallPolicyProvider(),
          RegionNotificationEndpointProvider(),
          RegionSecurityPolicyProvider(),
          RegionSnapshotProvider(),
          RegionInstantSnapshotProvider(),
          RegionInstantSnapshotGroupProvider(),
          RegionTargetHttpsProxyProvider(),
          RegionTargetTcpProxyProvider(),
        ),
        Layer.mergeAll(
          TargetSslProxyProvider(),
          TargetTcpProxyProvider(),
          TargetGrpcProxyProvider(),
          GlobalForwardingRuleProvider(),
          SslCertificateProvider(),
          SslPolicyProvider(),
          VpnGatewayProvider(),
          TargetVpnGatewayProvider(),
          ExternalVpnGatewayProvider(),
          VpnTunnelProvider(),
          PacketMirroringProvider(),
          ConnectorProvider(),
          WorkflowProvider(),
          TriggerProvider(),
          ChannelProvider(),
          NamespaceProvider(),
          TagKeyProvider(),
          TagValueProvider(),
          TagBindingProvider(),
        ),
        Layer.mergeAll(
          MessageBusProvider(),
          PipelineProvider(),
          EnrollmentProvider(),
          GoogleApiSourceProvider(),
          ChannelConnectionProvider(),
          ResourceManagerFolderProvider(),
          LienProvider(),
          ResourceManagerProjectProvider(),
        ),
        Layer.mergeAll(
          ConnectionProvider(),
          CloudBuildConnectionProvider(),
          CloudBuildRepositoryProvider(),
          ServiceDirectoryServiceProvider(),
          ServiceDirectoryEndpointProvider(),
          CaPoolProvider(),
          CertificateAuthorityProvider(),
          CertificateTemplateProvider(),
          PolicyProvider(),
          HubProvider(),
          SpokeProvider(),
          InternalRangeProvider(),
          PolicyBasedRouteProvider(),
          TransferConfigProvider(),
          ComposerEnvironmentProvider(),
          ReservationProvider(),
          DataprocClusterProvider(),
          BigtableInstanceProvider(),
          BigtableAppProfileProvider(),
        ),
        Layer.mergeAll(ServicemanagementServiceProvider()),
        Layer.mergeAll(
          EnvironmentsUserWorkloadsConfigMapProvider(),
          EnvironmentsUserWorkloadsSecretProvider(),
          CustomConstraintProvider(),
        ),
        Layer.mergeAll(
          CapacityCommitmentProvider(),
          ReservationGroupProvider(),
        ),
        Layer.mergeAll(
          DataprocAutoscalingPolicyProvider(),
          DataprocBatcheProvider(),
          DataprocRegionsAutoscalingPolicyProvider(),
          DataprocRegionsWorkflowTemplateProvider(),
          DataprocSessionProvider(),
          DataprocSessionTemplateProvider(),
          DataprocWorkflowTemplateProvider(),
        ),
        Layer.mergeAll(
          BigtableInstancesClustersBackupProvider(),
          BigtableInstancesLogicalViewProvider(),
          BigtableInstancesMaterializedViewProvider(),
          BigtableInstancesTablesAuthorizedViewProvider(),
          BigtableInstancesTablesSchemaBundleProvider(),
        ),
        Layer.mergeAll(
          Layer.mergeAll(
            TransportProvider(),
            AutomatedDnsRecordProvider(),
            MulticloudDataTransferConfigProvider(),
            MulticloudDataTransferConfigsDestinationProvider(),
            RegionalEndpointProvider(),
            ServiceConnectionMapProvider(),
            ServiceConnectionPolicyProvider(),
            ServiceConnectionTokenProvider(),
            SpokesGatewayAdvertisedRouteProvider(),
          ),
          Layer.mergeAll(
            VpcFlowLogsConfigProvider(),
            OrganizationsVpcFlowLogsConfigProvider(),
            ConnectivityTestProvider(),
            NetworkMonitoringProviderProvider(),
          ),
          Layer.mergeAll(
            KeyProvider(),
            AlloyDbClusterProvider(),
            AlloyDbInstanceProvider(),
            LogBucketProvider(),
            ExclusionProvider(),
            BucketsViewProvider(),
            BucketsLinkProvider(),
            LogScopeProvider(),
            SavedQueryProvider(),
            SpannerInstanceProvider(),
            SpannerDatabaseProvider(),
            BigQueryConnectionProvider(),
            AlertPolicyProvider(),
            NotificationChannelProvider(),
            UptimeCheckConfigProvider(),
            BigtableClusterProvider(),
            BigtableTableProvider(),
          ),
          Layer.mergeAll(
            SpannerInstanceConfigProvider(),
            SpannerInstancesBackupProvider(),
            SpannerInstancesDatabasesBackupScheduleProvider(),
            SpannerInstancesInstancePartitionProvider(),
            AlloyDbBackupProvider(),
            AlloyDbClustersUserProvider(),
          ),
          Layer.mergeAll(
            MonitoringGroupProvider(),
            MetricDescriptorProvider(),
            MonitoringServiceProvider(),
            ServicesServiceLevelObjectiveProvider(),
            TraceScopeProvider(),
            BucketsDatasetsLinkProvider(),
          ),
          Layer.mergeAll(
            BillingExclusionProvider(),
            BillingBucketProvider(),
            BillingBucketsLinkProvider(),
            BillingBucketsViewProvider(),
            BillingSavedQueryProvider(),
            BillingSinkProvider(),
            FolderExclusionProvider(),
            FolderBucketProvider(),
            FolderBucketsLinkProvider(),
            FolderBucketsViewProvider(),
            FolderLogScopeProvider(),
            FolderSavedQueryProvider(),
            FolderSinkProvider(),
            LocationsBucketProvider(),
            LocationsBucketsLinkProvider(),
            LocationsBucketsViewProvider(),
          ),
          Layer.mergeAll(
            OrganizationExclusionProvider(),
            OrganizationLogBucketProvider(),
            OrganizationBucketsLinkProvider(),
            OrganizationBucketsViewProvider(),
            OrganizationLogScopeProvider(),
            OrganizationSavedQueryProvider(),
            OrganizationSinkProvider(),
          ),
          Layer.mergeAll(
            ComputeReservationProvider(),
            RolloutPlanProvider(),
            StoragePoolProvider(),
            WireGroupProvider(),
            ZoneVmExtensionPolicyProvider(),
            GoldengateDeploymentProvider(),
            OdbNetworkProvider(),
            OdbNetworksOdbSubnetProvider(),
            AutonomousDatabaseProvider(),
            CloudExadataInfrastructureProvider(),
            CloudVmClusterProvider(),
            DbSystemProvider(),
            ExadbVmClusterProvider(),
            ExascaleDbStorageVaultProvider(),
            GoldengateConnectionProvider(),
            GoldengateConnectionAssignmentProvider(),
          ),
          Layer.mergeAll(
            InterconnectProvider(),
            InterconnectAttachmentProvider(),
            InterconnectGroupProvider(),
            InterconnectAttachmentGroupProvider(),
            LicenseProvider(),
            NetworkAttachmentProvider(),
            NetworkEdgeSecurityServiceProvider(),
            NetworkFirewallPolicyProvider(),
            NodeGroupProvider(),
            NodeTemplateProvider(),
          ),
          Layer.mergeAll(
            TrainingPipelineProvider(),
            AIPlatformDatasetProvider(),
            DatasetsDatasetVersionProvider(),
            ReasoningEngineProvider(),
            ReasoningEnginesSandboxEnvironmentTemplateProvider(),
            ReasoningEnginesSandboxEnvironmentProvider(),
          ),
          Layer.mergeAll(
            ReasoningEnginesSessionProvider(),
            ScheduleProvider(),
            SemanticGovernancePolicyProvider(),
            SpecialistPoolProvider(),
            StudyProvider(),
            StudiesTrialProvider(),
            TensorboardProvider(),
            TensorboardsExperimentProvider(),
            TensorboardsExperimentsRunProvider(),
            TensorboardsExperimentsRunsTimeSeriesProvider(),
          ),
          Layer.mergeAll(
            AppgroupsAppsKeyProvider(),
            DatacollectorProvider(),
            DeveloperProvider(),
            DevelopersAppProvider(),
            DevelopersAppsKeyProvider(),
            DnsZoneProvider(),
            EndpointAttachmentProvider(),
            EnvgroupProvider(),
            EnvgroupsAttachmentProvider(),
            ApigeeEnvironmentProvider(),
          ),
          Layer.mergeAll(
            ClientTlsPolicyProvider(),
            DnsThreatDetectorProvider(),
            FirewallEndpointProvider(),
            FirewallEndpointAssociationProvider(),
            GatewaySecurityPolicyProvider(),
            GatewaySecurityPoliciesRuleProvider(),
            InterceptDeploymentGroupProvider(),
            InterceptDeploymentProvider(),
          ),
          Layer.mergeAll(
            InterceptEndpointGroupProvider(),
            InterceptEndpointGroupAssociationProvider(),
            MirroringDeploymentGroupProvider(),
            MirroringDeploymentProvider(),
            MirroringEndpointGroupProvider(),
            MirroringEndpointGroupAssociationProvider(),
            SacRealmProvider(),
            SacAttachmentProvider(),
          ),
          Layer.mergeAll(
            SecurityProfileProvider(),
            SecurityProfileGroupProvider(),
            ServerTlsPolicyProvider(),
            TlsInspectionPolicyProvider(),
            UrlListProvider(),
          ),
          Layer.mergeAll(
            AddressGroupProvider(),
            AuthorizationPolicyProvider(),
            AuthzPolicyProvider(),
            BackendAuthenticationConfigProvider(),
            OrganizationsAddressGroupProvider(),
            OrganizationsFirewallEndpointProvider(),
            OrganizationsSecurityProfileProvider(),
            OrganizationsSecurityProfileGroupProvider(),
          ),
        ),
        Layer.mergeAll(
          Layer.mergeAll(
            Layer.mergeAll(
              AgentGatewayProvider(),
              AuthzExtensionProvider(),
              EndpointPolicyProvider(),
              NetworkservicesGatewayProvider(),
              GrpcRouteProvider(),
              HttpRouteProvider(),
              LbEdgeExtensionProvider(),
              LbRouteExtensionProvider(),
              WasmPluginProvider(),
              WasmPluginsVersionProvider(),
            ),
            Layer.mergeAll(
              LbTrafficExtensionProvider(),
              MeshProvider(),
              MulticastConsumerAssociationProvider(),
              MulticastGroupConsumerActivationProvider(),
              ServiceBindingProvider(),
              ServiceLbPolicyProvider(),
              TcpRouteProvider(),
              TlsRouteProvider(),
            ),
          ),
          Layer.mergeAll(
            AspectTypeProvider(),
            DataAttributeBindingProvider(),
            DataDomainProvider(),
            DataDomainsBindingProvider(),
            DataProductProvider(),
            DataProductsDataAssetProvider(),
            DataScanProvider(),
            EncryptionConfigProvider(),
          ),
          Layer.mergeAll(
            DataTaxonomyProvider(),
            DataTaxonomiesAttributeProvider(),
            EntryGroupProvider(),
            EntryGroupsEntryProvider(),
            EntryGroupsEntryLinkProvider(),
            EntryTypeProvider(),
            GlossaryProvider(),
            GlossariesCategoryProvider(),
          ),
          Layer.mergeAll(
            GlossariesTermProvider(),
            LakeProvider(),
            LakesTaskProvider(),
            LakesZoneProvider(),
            LakesAssetProvider(),
            LakesEntityProvider(),
            LakesEntitiesPartitionProvider(),
            MetadataFeedProvider(),
          ),
          Layer.mergeAll(
            TagTemplateProvider(),
            TaxonomyProvider(),
            TaxonomiesPolicyTagProvider(),
          ),
          Layer.mergeAll(
            DataStoresBranchesDocumentProvider(),
            DataStoresControlProvider(),
            DataStoresConversationProvider(),
            DataStoresSchemaProvider(),
            DataStoresServingConfigProvider(),
            DataStoresSessionProvider(),
            DataStoresSiteSearchEngineTargetSiteProvider(),
            IdentityMappingStoreProvider(),
          ),
          Layer.mergeAll(
            DataStoreProvider(),
            CollectionsEngineProvider(),
            CollectionsEnginesAssistantProvider(),
            CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigProvider(),
            CollectionsEnginesControlProvider(),
            CollectionsEnginesConversationProvider(),
            CollectionsEnginesServingConfigProvider(),
            CollectionsEnginesSessionProvider(),
          ),
          Layer.mergeAll(
            CollectionsDataStoreProvider(),
            CollectionsDataStoresBranchesDocumentProvider(),
            CollectionsDataStoresControlProvider(),
            CollectionsDataStoresConversationProvider(),
            CollectionsDataStoresSchemaProvider(),
            CollectionsDataStoresServingConfigProvider(),
            CollectionsDataStoresSessionProvider(),
            CollectionsDataStoresSiteSearchEngineTargetSiteProvider(),
          ),
          Layer.mergeAll(
            Layer.mergeAll(
              AnalysisRuleProvider(),
              AssessmentRuleProvider(),
              AuthorizedViewSetProvider(),
              AuthorizedViewSetsAuthorizedViewProvider(),
              AuthorizedViewSetsAuthorizedViewsConversationsAssessmentProvider(),
              AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelProvider(),
              AutoLabelingRuleProvider(),
              ConversationProvider(),
              ConversationsAnalysesProvider(),
              ConversationsAssessmentProvider(),
              ConversationsFeedbackLabelProvider(),
              DashboardProvider(),
              DashboardsChartProvider(),
              DatasetsConversationsFeedbackLabelProvider(),
              IssueModelProvider(),
              IssueModelsIssueProvider(),
            ),
            Layer.mergeAll(
              PhraseMatcherProvider(),
              QaQuestionTagProvider(),
              QaScorecardProvider(),
              QaScorecardsRevisionProvider(),
              QaScorecardsRevisionsQaQuestionProvider(),
              ViewProvider(),
            ),
            ContactCenterProvider(),
          ),
          Layer.mergeAll(
            Layer.mergeAll(
              AgentsEntityTypeProvider(),
              AgentsEnvironmentProvider(),
              AgentsEnvironmentsExperimentProvider(),
              AgentsEnvironmentsSessionsEntityTypeProvider(),
              AgentsFlowProvider(),
              AgentsFlowsPageProvider(),
              AgentsFlowsTransitionRouteGroupProvider(),
              AgentsFlowsVersionProvider(),
            ),
            Layer.mergeAll(
              AgentsGeneratorProvider(),
              AgentsIntentProvider(),
              AgentsPlaybookProvider(),
              AgentsPlaybooksExampleProvider(),
              AgentsPlaybooksVersionProvider(),
              AgentsSessionsEntityTypeProvider(),
              AgentsToolProvider(),
              AgentsToolsVersionProvider(),
            ),
            Layer.mergeAll(
              AgentsTransitionRouteGroupProvider(),
              AgentsWebhookProvider(),
              SecuritySettingProvider(),
            ),
          ),
          Layer.mergeAll(
            OrganizationStoredInfoTypeProvider(),
            DeidentifyTemplateProvider(),
            DlpJobProvider(),
            InspectTemplateProvider(),
            JobTriggerProvider(),
            ContentPolicyProvider(),
            LocationsDeidentifyTemplateProvider(),
            LocationsDlpJobProvider(),
            LocationsInspectTemplateProvider(),
            LocationsJobTriggerProvider(),
            LocationsStoredInfoTypeProvider(),
            StoredInfoTypeProvider(),
            DiscoveryConfigProvider(),
          ),
          Layer.mergeAll(
            Layer.mergeAll(
              OrganizationsDeidentifyTemplateProvider(),
              OrganizationsInspectTemplateProvider(),
              OrganizationsLocationsConnectionProvider(),
              OrganizationsLocationsDeidentifyTemplateProvider(),
              OrganizationsLocationsDiscoveryConfigProvider(),
              OrganizationsLocationsInspectTemplateProvider(),
              OrganizationsLocationsJobTriggerProvider(),
              OrganizationsLocationsStoredInfoTypeProvider(),
            ),
            Layer.mergeAll(
              FolderBigQueryExportProvider(),
              FolderEventThreatDetectionSettingsCustomModuleProvider(),
              FolderMuteConfigProvider(),
              FolderNotificationConfigProvider(),
              FolderSecurityHealthAnalyticsSettingsCustomModuleProvider(),
              OrganizationBigQueryExportProvider(),
              OrganizationEventThreatDetectionSettingsCustomModuleProvider(),
              OrganizationMuteConfigProvider(),
              NotificationConfigProvider(),
              OrganizationsNotificationConfigProvider(),
              MuteConfigProvider(),
              BigQueryExportProvider(),
              EventThreatDetectionSettingsCustomModuleProvider(),
              SecurityHealthAnalyticsSettingsCustomModuleProvider(),
              OrganizationsSecurityHealthAnalyticsSettingsCustomModuleProvider(),
            ),
          ),
          Layer.mergeAll(PostureProvider(), PostureDeploymentProvider()),
          Layer.mergeAll(
            GmailpostmastertoolsDomainProvider(),
            DomainsUserProvider(),
            SettingsDatasourceProvider(),
            SettingsSearchapplicationProvider(),
            MonetizationSubscriptionProvider(),
            MonetizationSubscriptionsBasePlansOfferProvider(),
            EditProvider(),
            InappproductProvider(),
          ),
          Layer.mergeAll(
            AchievementConfigurationProvider(),
            LeaderboardConfigurationProvider(),
          ),
        ),
        Layer.mergeAll(
          Layer.mergeAll(
            MatterProvider(),
            MattersExportProvider(),
            MattersHoldProvider(),
            MattersSavedQueryProvider(),
          ),
          Layer.mergeAll(
            StorelayoutclusterProvider(),
            StorelayoutpageProvider(),
            WebappProvider(),
            AndroidmanagementEnterpriseProvider(),
            EnterprisesEnrollmentTokenProvider(),
            EnterprisesWebAppProvider(),
            CustomersConfigurationProvider(),
            CustomersConnectorConfigProvider(),
          ),
          Layer.mergeAll(
            WorkspaceeventsSubscriptionProvider(),
            TasksPushNotificationConfigProvider(),
            SupportEventSubscriptionProvider(),
          ),
          Layer.mergeAll(
            JobsTenantProvider(),
            TenantsCompanyProvider(),
            TenantsJobProvider(),
            VisionProductSetProvider(),
            VisionProductProvider(),
            ProductsReferenceImageProvider(),
            CustomClassProvider(),
            PhraseSetProvider(),
          ),
          Layer.mergeAll(
            AppsAuthorizedCertificateProvider(),
            AppsDomainMappingProvider(),
            AppsFirewallIngressRuleProvider(),
            AppsServicesVersionProvider(),
            ApplicationsAuthorizedCertificateProvider(),
            ApplicationsDomainMappingProvider(),
          ),
          Layer.mergeAll(
            EssentialcontactsContactProvider(),
            FolderContactProvider(),
            OrganizationContactProvider(),
          ),
          Layer.mergeAll(UsersSshPublicKeyProvider()),
          Layer.mergeAll(LicenseAssignmentProvider()),
          Layer.mergeAll(WebResourceProvider()),
        ),
        Layer.mergeAll(
          Layer.mergeAll(
            CloudassetFeedProvider(),
            CloudassetSavedQueryProvider(),
          ),
          Layer.mergeAll(
            CloudidentityDeviceProvider(),
            CloudidentityGroupProvider(),
            GroupsMembershipProvider(),
            InboundOidcSsoProfileProvider(),
            InboundSamlSsoProfileProvider(),
            InboundSsoAssignmentProvider(),
          ),
          Layer.mergeAll(
            CloudchannelCustomerProvider(),
            ChannelPartnerLinksCustomerProvider(),
            CustomersCustomerRepricingConfigProvider(),
            ChannelPartnerLinksChannelPartnerRepricingConfigProvider(),
          ),
          Layer.mergeAll(
            CloudcontrolspartnerCustomerProvider(),
            DeploymentmanagerDeploymentProvider(),
          ),
          Layer.mergeAll(
            BackupChannelProvider(),
            BackupPlanProvider(),
            BackupPlansBackupProvider(),
            RestoreChannelProvider(),
            RestorePlanProvider(),
            RestorePlansRestoreProvider(),
          ),
          Layer.mergeAll(MembershipsFeatureProvider()),
          Layer.mergeAll(InstancesBackupProvider(), JobTemplateProvider()),
          Layer.mergeAll(
            BareMetalClusterProvider(),
            BareMetalClustersBareMetalNodePoolProvider(),
            GkeonpremVmwareClusterProvider(),
            VmwareClustersVmwareNodePoolProvider(),
          ),
          Layer.mergeAll(
            BackupdrBackupVaultProvider(),
            BackupdrBackupPlanProvider(),
            BackupPlanAssociationProvider(),
            BackupdrManagementServerProvider(),
            BaremetalsolutionNfsShareProvider(),
            BaremetalsolutionVolumesSnapshotProvider(),
          ),
          Layer.mergeAll(
            ManagedidentitiesDomainProvider(),
            ManagedidentitiesDomainsBackupProvider(),
            ManagedidentitiesPeeringProvider(),
          ),
          Layer.mergeAll(
            CustomTargetTypeProvider(),
            DeliveryPipelineProvider(),
            DeliveryPipelinesAutomationProvider(),
            DeployPolicyProvider(),
            ClouddeployTargetProvider(),
          ),
          Layer.mergeAll(
            ConfigDeploymentGroupProvider(),
            ConfigPreviewProvider(),
          ),
          Layer.mergeAll(
            FirebaseapphostingBackendProvider(),
            BackendsBuildProvider(),
            BackendsDomainProvider(),
            AppsDebugTokenProvider(),
            ServicesResourcePolicyProvider(),
            FirebaseappdistributionGroupProvider(),
          ),
          Layer.mergeAll(
            FirebasedataconnectServiceProvider(),
            ServicesSchemaProvider(),
            ServicesConnectorProvider(),
          ),
          Layer.mergeAll(
            FirebaserulesRulesetProvider(),
            FirebaserulesReleaseProvider(),
          ),
        ),
        Layer.mergeAll(
          Layer.mergeAll(
            HealthcareDatasetProvider(),
            DatasetsConsentStoreProvider(),
            DatasetsConsentStoresAttributeDefinitionProvider(),
            DatasetsConsentStoresConsentProvider(),
            DatasetsConsentStoresConsentArtifactProvider(),
            DatasetsConsentStoresUserDataMappingProvider(),
            DatasetsDicomStoreProvider(),
            DatasetsFhirStoreProvider(),
            DatasetsHl7V2StoreProvider(),
            DatasetsHl7V2StoresMessageProvider(),
          ),
          Layer.mergeAll(
            BrandsIdentityAwareProxyClientProvider(),
            IapDestGroupProvider(),
          ),
          Layer.mergeAll(
            CesAppProvider(),
            AppsAgentProvider(),
            AppsDeploymentProvider(),
            AppsExampleProvider(),
            AppsGuardrailProvider(),
            AppsToolProvider(),
            AppsToolsetProvider(),
            AppsVersionProvider(),
          ),
          Layer.mergeAll(
            SasportalCustomersDeploymentProvider(),
            SasportalCustomersDeviceProvider(),
            SasportalCustomersNodeProvider(),
            SasportalNodesDeviceProvider(),
            SasportalNodesNodeProvider(),
          ),
          Layer.mergeAll(
            DatalabelingAnnotationSpecSetProvider(),
            DatalabelingDatasetProvider(),
            DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageProvider(),
            DatalabelingEvaluationJobProvider(),
            DatalabelingInstructionProvider(),
          ),
          Layer.mergeAll(
            ProcessProvider(),
            ProcessesRunProvider(),
            ProcessesRunsLineageEventProvider(),
          ),
          Layer.mergeAll(
            SaasservicemgmtSaaProvider(),
            SaasservicemgmtTenantProvider(),
            SaasservicemgmtUnitKindProvider(),
            SaasservicemgmtUnitProvider(),
            SaasservicemgmtReleaseProvider(),
            SaasservicemgmtRolloutKindProvider(),
            SaasservicemgmtRolloutProvider(),
            SaasservicemgmtUnitOperationProvider(),
          ),
          Layer.mergeAll(
            RegistryBookProvider(),
            RealmProvider(),
            CustomRangeProvider(),
            IpamAdminScopeProvider(),
          ),
          Layer.mergeAll(
            AdminReservationProvider(),
            AdminTopicProvider(),
            AdminSubscriptionProvider(),
          ),
          Layer.mergeAll(
            NetappActiveDirectoryProvider(),
            NetappBackupPolicyProvider(),
            NetappBackupVaultProvider(),
            NetappBackupVaultsBackupProvider(),
            NetappHostGroupProvider(),
            NetappKmsConfigProvider(),
            NetappStoragePoolProvider(),
            NetappVolumeProvider(),
            NetappVolumesQuotaRuleProvider(),
          ),
          Layer.mergeAll(
            VolumesSnapshotProvider(),
            VolumesReplicationProvider(),
          ),
          Layer.mergeAll(
            CatalogsBranchesProductProvider(),
            CatalogsControlProvider(),
            CatalogsModelProvider(),
            CatalogsServingConfigProvider(),
          ),
          Layer.mergeAll(CatalogsCatalogItemProvider()),
          Layer.mergeAll(
            Layer.mergeAll(
              Layer.mergeAll(
                ApihubDeploymentProvider(),
                ExternalApiProvider(),
                PluginProvider(),
                PluginsInstanceProvider(),
                RuntimeProjectAttachmentProvider(),
                ApiHubInstanceProvider(),
                ApihubApiProvider(),
                ApisVersionProvider(),
              ),
              Layer.mergeAll(
                ApisVersionsOperationProvider(),
                ApisVersionsSpecProvider(),
                ApihubAttributeProvider(),
                CurationProvider(),
                DependencyProvider(),
              ),
              Layer.mergeAll(
                ApplicationProvider(),
                ApplicationsServiceProvider(),
                ApplicationsWorkloadProvider(),
                ServiceProjectAttachmentProvider(),
                ObservationJobProvider(),
                ObservationSourceProvider(),
                ApisConfigProvider(),
              ),
              Layer.mergeAll(
                MerchantReviewProvider(),
                ProductReviewProvider(),
                ContentwarehouseDocumentSchemaProvider(),
                ContentwarehouseDocumentProvider(),
                ContentwarehouseRuleSetProvider(),
                ContentwarehouseSynonymSetProvider(),
              ),
              Layer.mergeAll(
                SfdcInstanceProvider(),
                SfdcInstancesSfdcChannelProvider(),
                IntegrationsTemplateProvider(),
                AuthConfigProvider(),
                IntegrationsVersionProvider(),
                IntegrationsVersionsTestCasesProvider(),
                ProductsAuthConfigProvider(),
                ProductsCertificateProvider(),
                ProductsIntegrationsVersionProvider(),
                ProductsSfdcInstanceProvider(),
                ProductsSfdcInstancesSfdcChannelProvider(),
              ),
              Layer.mergeAll(
                MigrationcenterSourceProvider(),
                MigrationcenterAssetsExportJobProvider(),
                MigrationcenterDiscoveryClientProvider(),
                MigrationcenterGroupProvider(),
                MigrationcenterImportJobProvider(),
                MigrationcenterImportJobsImportDataFileProvider(),
                MigrationcenterPreferenceSetProvider(),
                MigrationcenterReportConfigProvider(),
                MigrationcenterReportConfigsReportProvider(),
                RapidmigrationassessmentCollectorProvider(),
                MetastoreFederationProvider(),
                MetastoreServiceProvider(),
                MetastoreServicesBackupProvider(),
              ),
              Layer.mergeAll(
                DataformRepositoryProvider(),
                ProjectsLocationsFolderProvider(),
                RepositoriesReleaseConfigProvider(),
                RepositoriesWorkflowConfigProvider(),
                RepositoriesWorkflowInvocationProvider(),
                RepositoriesWorkspaceProvider(),
                TeamProvider(),
              ),
              Layer.mergeAll(
                VmwareEngineNetworkProvider(),
                PrivateConnectionProvider(),
                PrivateCloudsManagementDnsZoneBindingProvider(),
                VmwareengineDatastoreProvider(),
                NetworkPeeringProvider(),
                VmwareengineNetworkPolicyProvider(),
                NetworkPoliciesExternalAccessRuleProvider(),
                PrivateCloudProvider(),
                PrivateCloudsClusterProvider(),
                PrivateCloudsExternalAddressProvider(),
                PrivateCloudsLoggingServerProvider(),
              ),
              Layer.mergeAll(
                DataExchangeProvider(),
                DataExchangesListingProvider(),
                DataExchangesQueryTemplateProvider(),
              ),
              Layer.mergeAll(
                ContaineranalysisNoteProvider(),
                ContaineranalysisOccurrenceProvider(),
                LocationsNoteProvider(),
                LocationsOccurrenceProvider(),
                BinaryauthorizationAttestorProvider(),
                PlatformsPolicyProvider(),
                BlockchainNodeProvider(),
                BillingBudgetProvider(),
              ),
              Layer.mergeAll(
                AccessPolicyProvider(),
                AccessPoliciesAccessLevelProvider(),
                AccessPoliciesAuthorizedOrgsDescProvider(),
                AccessPoliciesServicePerimeterProvider(),
                GcpUserAccessBindingProvider(),
              ),
              Layer.mergeAll(
                VmmigrationGroupProvider(),
                VmmigrationImageImportProvider(),
                VmmigrationSourceProvider(),
                SourcesDatacenterConnectorProvider(),
                SourcesDiskMigrationJobProvider(),
                SourcesMigratingVmProvider(),
                SourcesUtilizationReportProvider(),
                VmmigrationTargetProvider(),
                DatamigrationConnectionProfileProvider(),
                DatamigrationConversionWorkspaceProvider(),
                ConversionWorkspacesMappingRuleProvider(),
                DatamigrationMigrationJobProvider(),
                DatamigrationPrivateConnectionProvider(),
              ),
              Layer.mergeAll(
                DatastreamConnectionProfileProvider(),
                DatastreamPrivateConnectionProvider(),
                PrivateConnectionsRouteProvider(),
                DatastreamStreamProvider(),
              ),
            ),
            Layer.mergeAll(
              Layer.mergeAll(
                AccountConnectorProvider(),
                DeveloperconnectConnectionProvider(),
                ConnectionsGitRepositoryLinkProvider(),
                InsightsConfigProvider(),
              ),
              Layer.mergeAll(
                BiglakeCatalogProvider(),
                CatalogsDatabaseProvider(),
                CatalogsDatabasesTableProvider(),
              ),
              Layer.mergeAll(
                ManagedKafkaClusterProvider(),
                ClustersAclProvider(),
                ClustersTopicProvider(),
                ManagedKafkaConnectClusterProvider(),
                ConnectClustersConnectorProvider(),
                ManagedKafkaSchemaRegistryProvider(),
                SchemaRegistriesSubjectsVersionProvider(),
                SchemaRegistriesContextsSubjectsVersionProvider(),
              ),
              Layer.mergeAll(
                AppConnectionProvider(),
                AppConnectorProvider(),
                AppGatewayProvider(),
                SecurityGatewayProvider(),
                SecurityGatewaysApplicationProvider(),
              ),
              Layer.mergeAll(
                RepositoriesBranchRuleProvider(),
                RepositoriesHookProvider(),
                RepositoriesIssueProvider(),
                RepositoriesIssuesIssueCommentProvider(),
                RepositoriesPullRequestsPullRequestCommentProvider(),
                DocumentaiProcessorProvider(),
                DocumentaiSchemaProvider(),
                SchemasSchemaVersionProvider(),
                FoldersLocationsGlobalPolicyOrchestratorProvider(),
                OrganizationsLocationsGlobalPolicyOrchestratorProvider(),
                ProjectsLocationsGlobalPolicyOrchestratorProvider(),
                AdaptiveMtDatasetProvider(),
                GlossariesGlossaryEntryProvider(),
                TranslateModelProvider(),
              ),
              Layer.mergeAll(
                BuyersClientsUserProvider(),
                AccountTypesUserListProvider(),
                DatapipelinesPipelineProvider(),
                BiddersPretargetingConfigProvider(),
              ),
              Layer.mergeAll(AssuredworkloadsWorkloadProvider()),
              Layer.mergeAll(
                WorkstationClusterProvider(),
                WorkstationClustersWorkstationConfigProvider(),
                WorkstationClustersWorkstationConfigsWorkstationProvider(),
                AgentregistryBindingProvider(),
                RecaptchaenterpriseKeyProvider(),
                RecaptchaenterpriseFirewallpolicyProvider(),
                AgentidentityAuthProviderProvider(),
                WorkloadmanagerEvaluationProvider(),
                DeploymentsActuationProvider(),
                ConnectionsEntityTypesEntityProvider(),
              ),
              Layer.mergeAll(
                AgentProvider(),
                BatchPredictionJobProvider(),
                CachedContentProvider(),
                CustomJobProvider(),
                DataLabelingJobProvider(),
                DeploymentResourcePoolProvider(),
                EvaluationItemProvider(),
                EvaluationRunProvider(),
                EvaluationSetProvider(),
                FeatureGroupProvider(),
                FeatureGroupsFeatureProvider(),
                FeatureOnlineStoreProvider(),
                FeaturestoreProvider(),
                FeaturestoresEntityTypeProvider(),
                HyperparameterTuningJobProvider(),
                TuningJobProvider(),
                AIPlatformIndexProvider(),
              ),
              Layer.mergeAll(
                IndexEndpointProvider(),
                AIPlatformEndpointProvider(),
                MetadataStoreProvider(),
                MetadataStoresArtifactProvider(),
                MetadataStoresContextProvider(),
                MetadataStoresExecutionProvider(),
                NasJobProvider(),
                NotebookExecutionJobProvider(),
                NotebookRuntimeTemplateProvider(),
                OnlineEvaluatorProvider(),
                PersistentResourceProvider(),
                PipelineJobProvider(),
                RagCorporaProvider(),
                ReasoningEnginesMemoryProvider(),
                AnalyticsDatastoreProvider(),
                ApimServiceExtensionProvider(),
                ApiproductProvider(),
              ),
              Layer.mergeAll(
                ApiproductsRateplanProvider(),
                ApisKeyvaluemapProvider(),
                ApisKeyvaluemapsEntryProvider(),
                AppgroupProvider(),
                AppgroupsAppProvider(),
                EnvironmentsKeystoreProvider(),
                EnvironmentsKeyvaluemapProvider(),
                EnvironmentsReferenceProvider(),
                EnvironmentsResourcefileProvider(),
                EnvironmentsSecurityActionProvider(),
                EnvironmentsTargetserverProvider(),
                InstancesAttachmentProvider(),
                InstancesNatAddressProvider(),
                KeyvaluemapProvider(),
                KeyvaluemapsEntryProvider(),
                OrganizationProvider(),
              ),
              Layer.mergeAll(
                SecurityFeedbackProvider(),
                SecurityProfilesV2Provider(),
                SharedflowProvider(),
                SitesApicategoryProvider(),
                SitesApidocProvider(),
                AssignmentProvider(),
                AndroidAppProvider(),
              ),
              Layer.mergeAll(
                SasportalCustomersDeploymentsDeviceProvider(),
                SasportalCustomersNodesDeploymentProvider(),
                SasportalCustomersNodesDeviceProvider(),
                SasportalCustomersNodesNodeProvider(),
                SasportalNodesDeploymentsDeviceProvider(),
                SasportalNodesNodesDeploymentProvider(),
                SasportalNodesNodesDeviceProvider(),
              ),
              Layer.mergeAll(
                SasportalNodesNodesNodeProvider(),
                SasportalSignedCustomersDeviceProvider(),
                SasportalSignedCustomersNodesDeviceProvider(),
                SasportalSignedNodesDeviceProvider(),
                SasportalSignedNodesNodesDeviceProvider(),
                ScanConfigProvider(),
              ),
              Layer.mergeAll(
                FeaturestoresEntityTypesFeatureProvider(),
                ModelDeploymentMonitoringJobProvider(),
                FeatureOnlineStoresFeatureViewProvider(),
                EnvironmentsKeystoresAliasProvider(),
                EnvironmentsKeyvaluemapsEntryProvider(),
                SecurityMonitoringConditionProvider(),
                EnvironmentsArchiveDeploymentProvider(),
                EnvironmentsTraceConfigOverrideProvider(),
                EnvironmentsApisRevisionsDebugsessionProvider(),
                IamPolicyProvider(),
                HostServiceAccountProvider(),
                IamMemberProvider(),
                SasportalSignedCustomersDeploymentsDeviceProvider(),
                SasportalSignedNodesDeploymentsDeviceProvider(),
              ),
            ),
          ),
        ).pipe(Layer.provide(gcpLive)),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          ListDockerImagesHttp,
          FetchCaCertsHttp,
          GetCertificateAuthorityHttp,
          InsertAllHttp,
          ListTabledataHttp,
          QueryHttp,
          StartManualRunsHttp,
          BigQueryGetConnectionHttp,
          CloudBuildAccessReadTokenHttp,
          CloudBuildAccessReadWriteTokenHttp,
          CloudBuildFetchGitRefsHttp,
          GenerateDownloadUrlHttp,
          GetFunctionHttp,
          PauseJobHttp,
          ResumeJobHttp,
          RunJobHttp,
        ),
        Layer.mergeAll(
          CreateTaskHttp,
          ExecuteAirflowCommandHttp,
          GetEnvironmentHttp,
          GetUserWorkloadsConfigMapHttp,
          GetUserWorkloadsSecretHttp,
          CloudRunRunJobHttp,
          GetServiceHttp,
          GetWorkerPoolHttp,
          GetClusterHttp,
          GetClustersNodePoolHttp,
          GetNodePoolHttp,
          GetNoteHttp,
          GetOccurrenceHttp,
          GetAttestorHttp,
          GetPlatformsPolicyHttp,
          ValidateAttestationHttp,
        ),
        Layer.mergeAll(
          EvaluateGkePolicyHttp,
          GetInstanceHttp,
          StartInstanceHttp,
          StopInstanceHttp,
          DeleteDocumentHttp,
          GetDocumentHttp,
          PatchDocumentHttp,
          ExchangeDebugTokenHttp,
          ExecuteGraphqlHttp,
          ExecuteGraphqlReadHttp,
          ExecuteMutationHttp,
          ExecuteQueryHttp,
          GetReleaseExecutableHttp,
          TestRulesetHttp,
          AcknowledgeHttp,
          GetSchemaHttp,
        ),
        Layer.mergeAll(
          PublishHttp,
          PullHttp,
          ValidateMessageHttp,
          CommitCursorHttp,
          ComputeHeadCursorHttp,
          GetPartitionsHttp,
          GetPubsubliteReservationHttp,
          GetPubsubliteSubscriptionHttp,
          GetPubsubliteTopicHttp,
          DecryptHttp,
          EncryptHttp,
          AccessSecretVersionHttp,
          AddSecretVersionHttp,
          GetParameterHttp,
          GetParameterVersionHttp,
          RenderParameterVersionHttp,
        ),
        Layer.mergeAll(
          DeleteObjectHttp,
          GetObjectHttp,
          PutObjectHttp,
          GetGoogleServiceAccountHttp,
          RunTransferJobHttp,
          GetAclPolicyHttp,
          GetAuthStringHttp,
          GetRedisInstanceHttp,
          ReadRedisHttp,
          ReadWriteRedisHttp,
          WriteRedisHttp,
          GetMemcacheInstanceHttp,
          GetMlModelHttp,
          GetMlVersionHttp,
          PredictMlHttp,
          GetFilestoreBackupHttp,
          GetFilestoreInstanceHttp,
          GetFilestoreInstancesSnapshotHttp,
        ),
        Layer.mergeAll(
          GetTpuNodeHttp,
          GetTpuQueuedResourceHttp,
          GetSpannerInstanceHttp,
          SpannerExecuteSqlHttp,
          SpannerGetDdlHttp,
          GetAlloyDbClusterHttp,
          GetAlloyDbConnectionInfoHttp,
          GetAlloyDbInstanceHttp,
          GetAlloyDbBackupHttp,
          GetAlloyDbUserHttp,
          GetAutonomousDatabaseHttp,
          GenerateWalletHttp,
          StartAutonomousDatabaseHttp,
          StopAutonomousDatabaseHttp,
          RestartAutonomousDatabaseHttp,
          GetCloudExadataInfrastructureHttp,
        ),
        Layer.mergeAll(
          GetCloudVmClusterHttp,
          GetDbSystemHttp,
          GetExadbVmClusterHttp,
          GetExascaleDbStorageVaultHttp,
          GetGoldengateConnectionHttp,
          GetGoldengateConnectionAssignmentHttp,
          GetGoldengateDeploymentHttp,
          GetOdbNetworkHttp,
          GetOdbNetworksOdbSubnetHttp,
          GetBigtableInstanceHttp,
          GetBigtableClusterHttp,
          GetBigtableTableHttp,
          GetDataprocClusterHttp,
          DataprocSubmitJobHttp,
          ExecuteSqlHttp,
          GetSqlInstanceHttp,
        ),
        Layer.mergeAll(
          GetSqlUserHttp,
          CreateExecutionHttp,
          CreateJobHttp,
          ServiceDirectoryGetEndpointHttp,
          ServiceDirectoryResolveHttp,
          GetKeyStringHttp,
          RecaptchaenterpriseCreateAssessmentHttp,
          CancelTrainingPipelineHttp,
          GenerateContentHttp,
          GetReasoningEngineHttp,
          GetSandboxEnvironmentHttp,
          GetSandboxEnvironmentTemplateHttp,
          GetTrainingPipelineHttp,
          PauseSandboxEnvironmentHttp,
          QueryReasoningEngineHttp,
          ResumeSandboxEnvironmentHttp,
        ),
        Layer.mergeAll(GetCustomClassHttp, GetPhraseSetHttp, RecognizeHttp),
        Layer.mergeAll(
          RunPipelineHttp,
          StopPipelineHttp,
          LookupHttp,
          CommitHttp,
          RunQueryHttp,
          GetDocumentSchemaHttp,
          GetContentwarehouseDocumentHttp,
          GetRuleSetHttp,
          GetSynonymSetHttp,
          PauseCollectorHttp,
        ),
        Layer.mergeAll(
          RegisterCollectorHttp,
          ResumeCollectorHttp,
          DeveloperconnectFetchGitRefsHttp,
          DeveloperconnectFetchReadTokenHttp,
          DeveloperconnectFetchReadWriteTokenHttp,
          GetManagedKafkaClusterHttp,
          GetManagedKafkaTopicHttp,
          GetManagedKafkaConnectClusterHttp,
          GetManagedKafkaSchemaRegistryHttp,
          RetailSearchHttp,
          RetailPredictHttp,
          GetCatalogItemHttp,
          DocumentaiProcessHttp,
          GetProcessorHttp,
          DocumentaiGetSchemaHttp,
          GetSchemaVersionHttp,
        ),
        Layer.mergeAll(
          AdaptiveMtTranslateHttp,
          GetAdaptiveMtDatasetHttp,
          GetGlossariesGlossaryEntryHttp,
          TranslateGetModelHttp,
          TranslateTextHttp,
          GetWorkstationClusterHttp,
          GetWorkstationConfigHttp,
          GetWorkstationHttp,
          GenerateAccessTokenHttp,
          StartWorkstationHttp,
          StopWorkstationHttp,
          GetEntityHttp,
        ),
      ).pipe(Layer.provide(gcpLive)),
    ),

    // The `gcp-gke` Kubernetes cluster adapter is provideMerged (not just
    // provided) so the cluster-agnostic `Kubernetes.*` workload providers
    // can resolve it from the ambient stack context.
    Layer.provideMerge(
      GkeKubernetesAdapter().pipe(
        Layer.provide(gcpLive),
        Layer.provide(DockerLive),
      ),
    ),
    Layer.provideMerge(gcpLive),
    Layer.provideMerge(DockerLive),
    Layer.provideMerge(Command.providers()),
    Layer.orDie,
    // Erased on purpose: checking every consumer against the inferred union
    // of ~1,000 provider layers exhausts the type-checker's memory.
  ) as Layer.Layer<any, never, never>;

let cachedProviders: ReturnType<typeof makeProviders> | undefined;

/**
 * The GCP provider layer. Memoized: constructing it instantiates ~1,000
 * provider layers (several MB), and a Layer is an immutable description,
 * so every caller — each test file, each stack — shares one instance.
 */
export const providers = () => (cachedProviders ??= makeProviders());
