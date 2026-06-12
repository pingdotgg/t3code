import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import type { StackServices } from "../Stack.ts";
import { PlanetscaleAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { MySQLBranch, MySQLBranchProvider } from "./MySQL/MySQLBranch.ts";
import { MySQLDatabase, MySQLDatabaseProvider } from "./MySQL/MySQLDatabase.ts";
import { MySQLPassword, MySQLPasswordProvider } from "./MySQL/MySQLPassword.ts";
import {
  PostgresBranch,
  PostgresBranchProvider,
} from "./Postgres/PostgresBranch.ts";
import {
  PostgresDatabase,
  PostgresDatabaseProvider,
} from "./Postgres/PostgresDatabase.ts";
import {
  PostgresDefaultRole,
  PostgresDefaultRoleProvider,
} from "./Postgres/PostgresDefaultRole.ts";
import { PostgresRole, PostgresRoleProvider } from "./Postgres/PostgresRole.ts";

/**
 * Service tag bundling all PlanetScale providers + auth + credentials. Use
 * `Planetscale.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()(
  "Planetscale",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete PlanetScale providers Layer. Provide this on a Stack
 * (or via `Effect.provide` at test time) to enable all PlanetScale
 * resources, the AuthProvider registration, and credential resolution.
 *
 * @example
 * ```ts
 * Effect.provide(Planetscale.providers())
 * ```
 */
export const providers = (): Layer.Layer<
  Providers | Credentials.Credentials,
  never,
  StackServices
> =>
  Layer.effect(
    Providers,
    Provider.collection([
      MySQLDatabase,
      PostgresDatabase,
      MySQLBranch,
      PostgresBranch,
      MySQLPassword,
      PostgresRole,
      PostgresDefaultRole,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        MySQLDatabaseProvider(),
        PostgresDatabaseProvider(),
        MySQLBranchProvider(),
        PostgresBranchProvider(),
        MySQLPasswordProvider(),
        PostgresRoleProvider(),
        PostgresDefaultRoleProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(PlanetscaleAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  ) as Layer.Layer<Providers | Credentials.Credentials, never, StackServices>;
