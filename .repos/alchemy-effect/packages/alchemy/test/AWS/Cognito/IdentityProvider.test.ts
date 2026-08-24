import * as AWS from "@/AWS";
import { IdentityProvider, UserPool } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

// OIDC provider validation is lazy for issuer reachability of well-known
// issuers; a dummy client against accounts.google.com creates fine. The
// client_secret is Redacted to exercise the provider's unwrapping.
const providerDetails = {
  client_id: "alchemy-test-client",
  client_secret: Redacted.make("alchemy-test-secret"),
  authorize_scopes: "openid email",
  oidc_issuer: "https://accounts.google.com",
  attributes_request_method: "GET",
};

test.provider(
  "create, update mapping, delete OIDC identity provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("IdPTestPool", {});
          const idp = yield* IdentityProvider("Corporate", {
            userPoolId: pool.userPoolId,
            providerType: "OIDC",
            providerName: "corporate-oidc",
            providerDetails,
            attributeMapping: { email: "email" },
          });
          return { pool, idp };
        }),
      );

      expect(outputs.idp.providerName).toBe("corporate-oidc");
      expect(outputs.idp.providerType).toBe("OIDC");

      // out-of-band verification via distilled
      const created = yield* cip.describeIdentityProvider({
        UserPoolId: outputs.pool.userPoolId,
        ProviderName: "corporate-oidc",
      });
      expect(created.IdentityProvider?.ProviderType).toBe("OIDC");
      expect(created.IdentityProvider?.ProviderDetails?.oidc_issuer).toBe(
        "https://accounts.google.com",
      );

      // attribute mapping mutates in place
      yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("IdPTestPool", {});
          const idp = yield* IdentityProvider("Corporate", {
            userPoolId: pool.userPoolId,
            providerType: "OIDC",
            providerName: "corporate-oidc",
            providerDetails,
            attributeMapping: { email: "email", username: "sub" },
          });
          return { pool, idp };
        }),
      );
      const afterUpdate = yield* cip.describeIdentityProvider({
        UserPoolId: outputs.pool.userPoolId,
        ProviderName: "corporate-oidc",
      });
      expect(afterUpdate.IdentityProvider?.AttributeMapping?.username).toBe(
        "sub",
      );

      yield* stack.destroy();
      const gone = yield* cip
        .describeIdentityProvider({
          UserPoolId: outputs.pool.userPoolId,
          ProviderName: "corporate-oidc",
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 120_000 },
);
