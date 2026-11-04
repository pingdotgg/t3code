import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiToken, ApiTokenProvider } from "./ApiToken.ts";
import { TursoAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { DatabaseToken, DatabaseTokenProvider } from "./DatabaseToken.ts";
import { Group, GroupProvider } from "./Group.ts";
import { GroupToken, GroupTokenProvider } from "./GroupToken.ts";
import { OrganizationInvite, OrganizationInviteProvider } from "./OrganizationInvite.ts";
import { OrganizationMember, OrganizationMemberProvider } from "./OrganizationMember.ts";
import { OrganizationSettings, OrganizationSettingsProvider } from "./OrganizationSettings.ts";

/**
 * Service tag bundling all Turso providers + auth + credentials. Use
 * `Turso.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Turso") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Turso providers Layer: every Turso resource, the
 * Turso AuthProvider registration (so `alchemy profile edit` can configure
 * it), and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Turso.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApiToken,
      Database,
      DatabaseToken,
      Group,
      GroupToken,
      OrganizationInvite,
      OrganizationMember,
      OrganizationSettings,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiTokenProvider(),
        DatabaseProvider(),
        DatabaseTokenProvider(),
        GroupProvider(),
        GroupTokenProvider(),
        OrganizationInviteProvider(),
        OrganizationMemberProvider(),
        OrganizationSettingsProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(TursoAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
