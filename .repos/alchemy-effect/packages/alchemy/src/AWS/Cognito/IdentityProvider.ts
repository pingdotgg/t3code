import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/** The kind of third-party identity provider. */
export type IdentityProviderType =
  | "SAML"
  | "OIDC"
  | "Facebook"
  | "Google"
  | "LoginWithAmazon"
  | "SignInWithApple";

export interface IdentityProviderProps {
  /**
   * The ID of the user pool the IdP is attached to. Changing this triggers
   * a replacement.
   */
  userPoolId: string;
  /**
   * The kind of identity provider. Changing this triggers a replacement.
   */
  providerType: IdentityProviderType;
  /**
   * Name of the identity provider (1-32 chars, no spaces). For social
   * providers the name must match the provider type (e.g. `Google`). If
   * omitted, a deterministic name is generated from the app, stage, and
   * logical ID. Changing this triggers a replacement.
   */
  providerName?: string;
  /**
   * Provider configuration. For OIDC: `client_id`, `client_secret`,
   * `authorize_scopes`, `oidc_issuer`, `attributes_request_method`. For
   * SAML: `MetadataURL` or `MetadataFile`. For social providers:
   * `client_id`, `client_secret`, `authorize_scopes`. Wrap secret values
   * (e.g. `client_secret`) with `Redacted.make(...)` so they never leak
   * into logs or state output.
   */
  providerDetails: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Maps IdP claims to user pool attributes, e.g. `{ email: "email" }`.
   */
  attributeMapping?: Record<string, string>;
  /**
   * Identifiers (up to 50) that direct sign-in requests to this IdP.
   */
  idpIdentifiers?: string[];
}

export interface IdentityProvider extends Resource<
  "AWS.Cognito.IdentityProvider",
  IdentityProviderProps,
  {
    /** The name of the identity provider. */
    providerName: string;
    /** The ID of the user pool the IdP is attached to. */
    userPoolId: string;
    /** The kind of identity provider. */
    providerType: IdentityProviderType;
  },
  never,
  Providers
> {}

/**
 * A third-party identity provider (SAML, OIDC, or social) attached to an
 * Amazon Cognito user pool, enabling federated sign-in through managed
 * login.
 * @resource
 * @section Creating Identity Providers
 * @example OIDC Provider
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * const oidc = yield* Cognito.IdentityProvider("Corporate", {
 *   userPoolId: pool.userPoolId,
 *   providerType: "OIDC",
 *   providerDetails: {
 *     client_id: "my-client-id",
 *     client_secret: Redacted.make("my-client-secret"),
 *     authorize_scopes: "openid email",
 *     oidc_issuer: "https://accounts.google.com",
 *     attributes_request_method: "GET",
 *   },
 *   attributeMapping: { email: "email", username: "sub" },
 * });
 * ```
 *
 * @example Wire the IdP to an App Client
 * ```typescript
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 *   supportedIdentityProviders: ["COGNITO", oidc.providerName],
 * });
 * ```
 */
export const IdentityProvider = Resource<IdentityProvider>(
  "AWS.Cognito.IdentityProvider",
);

/** Unwrap any `Redacted` values (e.g. `client_secret`) into the plain
 * string record the Cognito wire API expects. */
const plainDetails = (
  details: Record<string, string | Redacted.Redacted<string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "string" ? value : Redacted.value(value),
    ]),
  );

const definedRecord = (
  record: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const canonicalRecord = (record: Record<string, string>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

export const IdentityProviderProvider = () =>
  Provider.effect(
    IdentityProvider,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<IdentityProviderProps, "providerName" | "providerType">,
      ) {
        if (props.providerName) return props.providerName;
        // social providers require the name to equal the type
        if (
          props.providerType !== undefined &&
          props.providerType !== "SAML" &&
          props.providerType !== "OIDC"
        ) {
          return props.providerType;
        }
        return yield* createPhysicalName({ id, maxLength: 32 });
      });

      const describeProvider = Effect.fn(function* (
        userPoolId: string,
        providerName: string,
      ) {
        return yield* cip
          .describeIdentityProvider({
            UserPoolId: userPoolId,
            ProviderName: providerName,
          })
          .pipe(
            Effect.map((r) => r.IdentityProvider),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const attributesOf = (
        provider: cip.IdentityProviderType,
        providerName: string,
        userPoolId: string,
      ) => ({
        providerName,
        userPoolId,
        providerType: (provider.ProviderType ?? "OIDC") as IdentityProviderType,
      });

      return IdentityProvider.Provider.of({
        stables: ["providerName", "userPoolId", "providerType"],

        // Sub-resource keyed entirely by its user pool (userPoolId) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const userPoolId = output?.userPoolId ?? olds?.userPoolId;
          if (userPoolId === undefined) return undefined;
          const providerName =
            output?.providerName ??
            (yield* createName(
              id,
              olds ?? { providerType: "OIDC" as const, providerDetails: {} },
            ));
          const observed = yield* describeProvider(userPoolId, providerName);
          return observed === undefined
            ? undefined
            : attributesOf(observed, providerName, userPoolId);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName =
            olds === undefined ? undefined : yield* createName(id, olds);
          const newName =
            news === undefined ? undefined : yield* createName(id, news);
          if (
            oldName !== newName ||
            olds?.providerType !== news?.providerType ||
            olds?.userPoolId !== news?.userPoolId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const providerName =
            output?.providerName ?? (yield* createName(id, news));
          const userPoolId = news.userPoolId;
          const desiredDetails = plainDetails(news.providerDetails);

          // 1. OBSERVE
          let observed = yield* describeProvider(userPoolId, providerName);

          // 2. ENSURE — tolerate the create race.
          if (observed === undefined) {
            observed = yield* cip
              .createIdentityProvider({
                UserPoolId: userPoolId,
                ProviderName: providerName,
                ProviderType: news.providerType,
                ProviderDetails: desiredDetails,
                AttributeMapping: news.attributeMapping,
                IdpIdentifiers: news.idpIdentifiers,
              })
              .pipe(
                Effect.map((r) => r.IdentityProvider),
                Effect.catchTag("DuplicateProviderException", () =>
                  describeProvider(userPoolId, providerName).pipe(
                    Effect.map((provider) => provider!),
                  ),
                ),
              );
          } else {
            // 3. SYNC — details, mapping, and identifiers are mutable.
            // Cognito augments ProviderDetails with derived keys (e.g.
            // attributes_url), so compare desired keys only.
            const observedDetails = definedRecord(observed.ProviderDetails);
            const detailsDrift = Object.entries(desiredDetails).some(
              ([key, value]) => observedDetails[key] !== value,
            );
            const mappingDrift =
              news.attributeMapping !== undefined &&
              canonicalRecord(definedRecord(observed.AttributeMapping)) !==
                canonicalRecord(news.attributeMapping);
            const identifiersDrift =
              news.idpIdentifiers !== undefined &&
              [...news.idpIdentifiers].sort().join(",") !==
                [...(observed.IdpIdentifiers ?? [])].sort().join(",");
            if (detailsDrift || mappingDrift || identifiersDrift) {
              observed = yield* cip
                .updateIdentityProvider({
                  UserPoolId: userPoolId,
                  ProviderName: providerName,
                  ProviderDetails: desiredDetails,
                  AttributeMapping: news.attributeMapping,
                  IdpIdentifiers: news.idpIdentifiers,
                })
                .pipe(Effect.map((r) => r.IdentityProvider));
            }
          }

          yield* session.note(providerName);
          return attributesOf(observed!, providerName, userPoolId);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cip
            .deleteIdentityProvider({
              UserPoolId: output.userPoolId,
              ProviderName: output.providerName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
