import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Server, ServerProvider } from "alchemy/Website/Server";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Auth, AuthProvider } from "./Auth.ts";
import { AuthOAuthProvider, AuthOAuthProviderProvider } from "./AuthOAuthProvider.ts";
import { NeonAuth } from "./AuthProvider.ts";
import { AuthTrustedDomain, AuthTrustedDomainProvider } from "./AuthTrustedDomain.ts";
import { Branch, BranchProvider } from "./Branch.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { Credential, CredentialProvider } from "./Credential.ts";
import * as Credentials from "./Credentials.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { DataApi, DataApiProvider } from "./DataApi.ts";
import { Function } from "./Function.ts";
import { FunctionProvider } from "./FunctionProvider.ts";
import { FunctionTrigger, FunctionTriggerProvider } from "./FunctionTrigger.ts";
import { Object, ObjectProvider } from "./Object.ts";
import { OrganizationApiKey, OrganizationApiKeyProvider } from "./OrganizationApiKey.ts";
import {
  OrganizationMemberRole,
  OrganizationMemberRoleProvider,
} from "./OrganizationMemberRole.ts";
import {
  OrganizationSpendingLimit,
  OrganizationSpendingLimitProvider,
} from "./OrganizationSpendingLimit.ts";
import {
  OrganizationVPCEndpoint,
  OrganizationVPCEndpointProvider,
} from "./OrganizationVPCEndpoint.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ProjectMemberRole, ProjectMemberRoleProvider } from "./ProjectMemberRole.ts";
import { ProjectVPCEndpoint, ProjectVPCEndpointProvider } from "./ProjectVPCEndpoint.ts";
import { Role, RoleProvider } from "./Role.ts";
import { WebsiteArtifact, WebsiteArtifactProvider } from "./Website/Artifact.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Neon") {}

/**
 * Build a layer that registers all Neon resource providers, the Neon
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Neon from "@alchemy.run/neon";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const project = yield* Neon.Project("app-db");
 *     const branch = yield* Neon.Branch("app-branch", { project });
 *     return { branchId: branch.branchId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      OrganizationApiKey,
      OrganizationMemberRole,
      ProjectMemberRole,
      OrganizationSpendingLimit,
      OrganizationVPCEndpoint,
      ProjectVPCEndpoint,
      Branch,
      Credential,
      Role,
      Bucket,
      Object,
      Auth,
      AuthOAuthProvider,
      AuthTrustedDomain,
      DataApi,
      Function,
      FunctionTrigger,
      CustomDomain,
      WebsiteArtifact,
      Server,
    ]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectProvider(),
        OrganizationApiKeyProvider(),
        OrganizationMemberRoleProvider(),
        ProjectMemberRoleProvider(),
        OrganizationSpendingLimitProvider(),
        OrganizationVPCEndpointProvider(),
        ProjectVPCEndpointProvider(),
        BranchProvider(),
        CredentialProvider(),
        RoleProvider(),
        BucketProvider(),
        ObjectProvider(),
        AuthProvider(),
        AuthOAuthProviderProvider(),
        AuthTrustedDomainProvider(),
        DataApiProvider(),
        FunctionProvider(),
        FunctionTriggerProvider(),
        CustomDomainProvider(),
        WebsiteArtifactProvider(),
        ServerProvider(),
      ),
    ),
    Layer.provideMerge(Command.providers()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(NeonAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
