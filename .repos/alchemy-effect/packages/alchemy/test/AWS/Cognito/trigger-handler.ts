import * as Cognito from "@/AWS/Cognito";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "trigger-handler.ts");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const PASSWORD = "Alchemy-Trigger-Passw0rd!";

export class CognitoTriggerFunction extends Lambda.Function<Lambda.Function>()(
  "CognitoTriggerFunction",
) {}

/**
 * Fixture for the user pool trigger e2e test: ONE Lambda that both hosts
 * the pool's PreSignUp / PreTokenGeneration triggers (the circular case the
 * binding-contract pattern exists for — the pool's LambdaConfig points back
 * at this function) and drives the auth flows over its function URL.
 */
export default CognitoTriggerFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const pool = yield* Cognito.UserPool("TriggerUserPool", {
      passwordPolicy: {
        minimumLength: 12,
        requireSymbols: false,
      },
      accountRecovery: [{ name: "admin_only", priority: 1 }],
      tags: { Purpose: "cognito-trigger-fixture" },
    });
    const client = yield* Cognito.UserPoolClient("TriggerUserPoolClient", {
      userPoolId: pool.userPoolId,
      explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
    });

    // PreSignUp: auto-confirm every sign-up (and mark the email verified)
    // so users arrive CONFIRMED without ever receiving a confirmation code.
    yield* Cognito.onPreSignUp(pool, (event) =>
      Effect.sync(() => Cognito.autoConfirmUser(event, { verifyEmail: true })),
    );

    // PreTokenGeneration: stamp a custom claim into every issued ID token.
    yield* Cognito.onPreTokenGeneration(pool, (event) =>
      Effect.sync(() => {
        event.response.claimsOverrideDetails = {
          claimsToAddOrOverride: { alchemyTrigger: "pre-token-generation" },
        };
        return event;
      }),
    );

    const auth = yield* Cognito.UserPoolAuth(client);
    const admin = yield* Cognito.UserPoolAdmin(pool);
    const UserPoolId = yield* pool.userPoolId;
    const ClientId = yield* client.clientId;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const username = url.searchParams.get("username") ?? "missing-user";

        // Sign up (PreSignUp auto-confirms) → adminGetUser (assert state)
        // → password auth (PreTokenGeneration stamps a claim) → delete.
        if (request.method === "POST" && pathname === "/sign-up-flow") {
          // rerun tolerance: an earlier partial run may have left the user
          yield* admin
            .adminDeleteUser({ Username: username })
            .pipe(Effect.catchTag("UserNotFoundException", () => Effect.void));

          const signedUp = yield* auth.signUp({
            Username: username,
            Password: PASSWORD,
            UserAttributes: [
              { Name: "email", Value: `${username}@example.com` },
            ],
          });

          const user = yield* admin.adminGetUser({ Username: username });
          const emailVerified = plain(
            (user.UserAttributes ?? []).find(
              (attribute) => attribute.Name === "email_verified",
            )?.Value,
          );

          const signIn = yield* auth.initiateAuth({
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: username, PASSWORD },
          });

          yield* admin.adminDeleteUser({ Username: username });

          return yield* HttpServerResponse.json({
            userConfirmed: signedUp.UserConfirmed,
            userStatus: user.UserStatus,
            emailVerified,
            idToken: plain(signIn.AuthenticationResult?.IdToken),
          });
        }

        if (request.method === "GET" && pathname === "/config") {
          return yield* HttpServerResponse.json({
            ok: true,
            userPoolId: yield* UserPoolId,
            clientId: yield* ClientId,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.UserPoolTriggerEventSource,
        Cognito.UserPoolAuthHttp,
        Cognito.UserPoolAdminHttp,
      ),
    ),
  ),
);
