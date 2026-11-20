import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const REPO = { owner: "alchemy-run", repository: "alchemy" } as const;

/**
 * Repository secrets consumed by `.github/workflows`. Inputs come from
 * Doppler: `pnpm deploy:github` runs under `doppler run -c prod`. Cloudflare
 * API tokens are minted here rather than copied.
 *
 * Secrets the workflows read that have no Doppler source stay hand-managed
 * in the repository settings:
 * - `ALCHEMY_VERSION_BOT_ID`, `ALCHEMY_VERSION_BOT_PRIVATE_KEY` (release.yml, website.yml)
 */
export default Alchemy.Stack(
  "AlchemyGitHubSecrets",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const CLOUDFLARE_API_TOKEN = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const TEST_CLOUDFLARE_ACCOUNT_ID = yield* Config.String("TEST_CLOUDFLARE_ACCOUNT_ID");
    const PROD_CLOUDFLARE_ACCOUNT_ID = yield* Config.String("PROD_CLOUDFLARE_ACCOUNT_ID");
    const DISCORD_WEBHOOK_URL = yield* Config.Redacted("DISCORD_WEBHOOK_URL");

    // The prod account token is minted with the admin token from Doppler; the
    // test account token with the profile's own credentials.
    const PROD_CLOUDFLARE_API_TOKEN = yield* AccountApiToken("ProdApiToken", {
      accountId: PROD_CLOUDFLARE_ACCOUNT_ID,
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Cloudflare.Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: CLOUDFLARE_API_TOKEN,
            apiBaseUrl: "https://api.cloudflare.com",
          }),
        ),
      ),
    );
    const TEST_CLOUDFLARE_API_TOKEN = yield* AccountApiToken("TestApiToken", {
      accountId: TEST_CLOUDFLARE_ACCOUNT_ID,
    });

    yield* GitHub.Secrets({
      ...REPO,
      secrets: {
        // website.yml previews
        TEST_CLOUDFLARE_ACCOUNT_ID,
        TEST_CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_API_TOKEN.value,
        // website.yml production deploy
        PROD_CLOUDFLARE_ACCOUNT_ID,
        PROD_CLOUDFLARE_API_TOKEN: PROD_CLOUDFLARE_API_TOKEN.value,
        // release.yml
        DISCORD_WEBHOOK_URL,
      },
    });

    return {
      TEST_CLOUDFLARE_ACCOUNT_ID,
      TEST_CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_API_TOKEN.value.pipe(Output.map(Redacted.value)),
      PROD_CLOUDFLARE_ACCOUNT_ID,
      PROD_CLOUDFLARE_API_TOKEN: PROD_CLOUDFLARE_API_TOKEN.value.pipe(Output.map(Redacted.value)),
    };
  }).pipe(Effect.orDie),
);

const AccountApiToken = (
  id: string,
  props: {
    accountId: string;
  },
) =>
  Cloudflare.ApiToken.AccountApiToken(id, {
    name: "alchemy-ci",
    accountId: props.accountId,
    policies: [
      {
        effect: "allow",
        permissionGroups: [
          // Worker / runtime data plane
          "Workers Scripts Write",
          "Workers KV Storage Write",
          "Workers R2 Storage Write",
          "Workers Routes Write",
          "Workers Tail Read",
          "Workers Observability Write",
          // Storage / data services
          "D1 Write",
          "Queues Write",
          "Hyperdrive Write",
          "Pipelines Write",
          "Vectorize Write",
          // Higher-level Worker features used by examples
          "AI Gateway Write",
          // Containers
          "Workers Containers Write",
          "Cloudchamber Write",
          "Browser Rendering Write",
          // Static assets / sites
          "Pages Write",
          // Misc
          "Account Settings Write",
          "Secrets Store Write",
          "Logs Write",
        ],
        resources: {
          [`com.cloudflare.api.account.${props.accountId}`]: "*",
        },
      },
    ],
  });
