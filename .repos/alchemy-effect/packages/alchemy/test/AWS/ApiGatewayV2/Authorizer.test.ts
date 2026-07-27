import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// CreateAuthorizer validates that the issuer serves a live
// `/.well-known/openid-configuration` discovery document (probed:
// BadRequestException "Issuer must have a valid discovery endpoint" for
// placeholder domains). Tokens are only validated at request time, so any
// stable public OIDC issuer exercises the CRUD lifecycle.
const ISSUER = "https://accounts.google.com";

test.provider(
  "create, update, delete JWT authorizer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployAuthorizer = (audience: string[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.ApiGatewayV2.Api("AuthApi", {});
            const authorizer = yield* AWS.ApiGatewayV2.Authorizer(
              "JwtAuthorizer",
              {
                api,
                authorizerType: "JWT",
                identitySource: ["$request.header.Authorization"],
                jwtConfiguration: {
                  Issuer: ISSUER,
                  Audience: audience,
                },
              },
            );
            return {
              apiId: api.apiId,
              authorizerId: authorizer.authorizerId,
              name: authorizer.name,
            };
          }),
        );

      const out = yield* deployAuthorizer(["aud-1"]);
      expect(out.authorizerId).toBeTruthy();

      // Out-of-band verification via distilled.
      const remote = yield* agw2.getAuthorizer({
        ApiId: out.apiId,
        AuthorizerId: out.authorizerId,
      });
      expect(remote.AuthorizerType).toBe("JWT");
      expect(remote.JwtConfiguration?.Issuer).toBe(ISSUER);
      expect(remote.JwtConfiguration?.Audience).toEqual(["aud-1"]);

      // Update the audience in place (same authorizerId).
      const updated = yield* deployAuthorizer(["aud-1", "aud-2"]);
      expect(updated.authorizerId).toBe(out.authorizerId);

      const afterUpdate = yield* agw2.getAuthorizer({
        ApiId: out.apiId,
        AuthorizerId: out.authorizerId,
      });
      expect(afterUpdate.JwtConfiguration?.Audience).toEqual([
        "aud-1",
        "aud-2",
      ]);

      yield* stack.destroy();

      const gone = yield* agw2
        .getAuthorizer({
          ApiId: out.apiId,
          AuthorizerId: out.authorizerId,
        })
        .pipe(
          Effect.map(() => "still-exists" as const),
          Effect.catchTag("NotFoundException", () =>
            Effect.succeed("deleted" as const),
          ),
        );
      expect(gone).toBe("deleted");
    }),
  { timeout: 240_000 },
);
