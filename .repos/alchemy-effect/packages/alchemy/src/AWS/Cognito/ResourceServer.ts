import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/** An OAuth scope defined by a resource server. */
export interface ResourceServerScope {
  /** Scope name; clients request it as `<identifier>/<scopeName>`. */
  scopeName: string;
  /** Human-readable description of the scope. */
  scopeDescription: string;
}

export interface ResourceServerProps {
  /**
   * The ID of the user pool the resource server belongs to. Changing this
   * triggers a replacement.
   */
  userPoolId: string;
  /**
   * Unique identifier of the resource server — conventionally an API URL
   * like `https://api.example.com`. If omitted, a deterministic identifier
   * is generated from the app, stage, and logical ID. Changing this
   * triggers a replacement.
   */
  identifier?: string;
  /**
   * Friendly name of the resource server. Defaults to the identifier.
   */
  name?: string;
  /**
   * OAuth scopes (up to 100) exposed by this resource server. Clients
   * reference them as `<identifier>/<scopeName>` in `allowedOAuthScopes`.
   */
  scopes?: ResourceServerScope[];
}

export interface ResourceServer extends Resource<
  "AWS.Cognito.ResourceServer",
  ResourceServerProps,
  {
    /** The unique identifier of the resource server. */
    identifier: string;
    /** The ID of the user pool the resource server belongs to. */
    userPoolId: string;
    /** The friendly name of the resource server. */
    name: string;
  },
  never,
  Providers
> {}

/**
 * An OAuth 2.0 resource server for an Amazon Cognito user pool. Resource
 * servers declare custom scopes that app clients can request in
 * `client_credentials` and authorization-code flows.
 * @resource
 * @section Creating a Resource Server
 * @example API with Custom Scopes
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * const api = yield* Cognito.ResourceServer("Api", {
 *   userPoolId: pool.userPoolId,
 *   identifier: "https://api.example.com",
 *   scopes: [
 *     { scopeName: "read", scopeDescription: "Read access" },
 *     { scopeName: "write", scopeDescription: "Write access" },
 *   ],
 * });
 * ```
 *
 * @example Client Requesting Resource-Server Scopes
 * ```typescript
 * const client = yield* Cognito.UserPoolClient("Machine", {
 *   userPoolId: pool.userPoolId,
 *   generateSecret: true,
 *   allowedOAuthFlowsUserPoolClient: true,
 *   allowedOAuthFlows: ["client_credentials"],
 *   allowedOAuthScopes: ["https://api.example.com/read"],
 * });
 * ```
 */
export const ResourceServer = Resource<ResourceServer>(
  "AWS.Cognito.ResourceServer",
);

const toWireScopes = (scopes: ResourceServerScope[] | undefined) =>
  scopes?.map((scope) => ({
    ScopeName: scope.scopeName,
    ScopeDescription: scope.scopeDescription,
  }));

const canonicalScopes = (
  scopes: { ScopeName?: string; ScopeDescription?: string }[] | undefined,
) =>
  (scopes ?? [])
    .map((scope) => `${scope.ScopeName}:${scope.ScopeDescription}`)
    .sort()
    .join(",");

export const ResourceServerProvider = () =>
  Provider.effect(
    ResourceServer,
    Effect.gen(function* () {
      const createIdentifier = Effect.fn(function* (
        id: string,
        props: Pick<ResourceServerProps, "identifier">,
      ) {
        return (
          props.identifier ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const describeServer = Effect.fn(function* (
        userPoolId: string,
        identifier: string,
      ) {
        return yield* cip
          .describeResourceServer({
            UserPoolId: userPoolId,
            Identifier: identifier,
          })
          .pipe(
            Effect.map((r) => r.ResourceServer),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return ResourceServer.Provider.of({
        stables: ["identifier", "userPoolId"],

        // Sub-resource keyed entirely by its user pool (userPoolId) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const userPoolId = output?.userPoolId ?? olds?.userPoolId;
          if (userPoolId === undefined) return undefined;
          const identifier =
            output?.identifier ?? (yield* createIdentifier(id, olds ?? {}));
          const observed = yield* describeServer(userPoolId, identifier);
          return observed === undefined
            ? undefined
            : {
                identifier,
                userPoolId,
                name: observed.Name ?? identifier,
              };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldIdentifier = yield* createIdentifier(id, olds ?? {});
          const newIdentifier = yield* createIdentifier(id, news ?? {});
          if (
            oldIdentifier !== newIdentifier ||
            olds?.userPoolId !== news?.userPoolId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.identifier ?? (yield* createIdentifier(id, news));
          const userPoolId = news.userPoolId;
          const name = news.name ?? identifier;

          // 1. OBSERVE
          let observed = yield* describeServer(userPoolId, identifier);

          // 2. ENSURE
          if (observed === undefined) {
            observed = yield* cip
              .createResourceServer({
                UserPoolId: userPoolId,
                Identifier: identifier,
                Name: name,
                Scopes: toWireScopes(news.scopes),
              })
              .pipe(Effect.map((r) => r.ResourceServer));
          } else {
            // 3. SYNC — name and scopes are mutable in place.
            const drift =
              observed.Name !== name ||
              canonicalScopes(observed.Scopes) !==
                canonicalScopes(toWireScopes(news.scopes));
            if (drift) {
              observed = yield* cip
                .updateResourceServer({
                  UserPoolId: userPoolId,
                  Identifier: identifier,
                  Name: name,
                  Scopes: toWireScopes(news.scopes),
                })
                .pipe(Effect.map((r) => r.ResourceServer));
            }
          }

          yield* session.note(identifier);
          return { identifier, userPoolId, name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cip
            .deleteResourceServer({
              UserPoolId: output.userPoolId,
              Identifier: output.identifier,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
