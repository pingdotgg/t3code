import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const REPO = { owner: "alchemy-run", repository: "alchemy" } as const;

/**
 * Repository secrets consumed by `.github/workflows`, plus the AWS OIDC trust
 * behind `AWS_ROLE_ARN`. Inputs come from Doppler: `pnpm deploy:github` runs
 * under `doppler run -c prod`. Cloudflare API tokens are minted here rather
 * than copied.
 *
 * Secrets the workflows read that have no Doppler source stay hand-managed
 * in the repository settings:
 * - `ALCHEMY_VERSION_BOT_ID`, `ALCHEMY_VERSION_BOT_PRIVATE_KEY` (release.yml, website.yml)
 * - `NPM_TOKEN` (release.yml)
 * - `TEST_D1_DATABASE_ID`, `TEST_KV_NAMESPACE_ID`, `TEST_R2_BUCKET_NAME`,
 *   `TEST_SERVICE_WORKER_NAME`, `TEST_MYSQL_URL`, `TEST_POSTGRES_URL` (cloudflare-tools.yml)
 */
export default Alchemy.Stack(
  "AlchemyGitHubSecrets",
  {
    providers: Layer.mergeAll(
      AWS.providers(),
      Cloudflare.providers(),
      GitHub.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const CLOUDFLARE_API_TOKEN = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const TEST_CLOUDFLARE_ACCOUNT_ID = yield* Config.String(
      "TEST_CLOUDFLARE_ACCOUNT_ID",
    );
    const PROD_CLOUDFLARE_ACCOUNT_ID = yield* Config.String(
      "PROD_CLOUDFLARE_ACCOUNT_ID",
    );
    const ANTHROPIC_API_KEY = yield* Config.Redacted("ANTHROPIC_API_KEY");
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

    // GitHub OIDC trust for AWS — lets workflows assume an IAM role via
    // `aws-actions/configure-aws-credentials` with no long-lived AWS keys.
    const oidc = yield* AWS.IAM.OpenIDConnectProvider("GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIDList: ["sts.amazonaws.com"],
      // GitHub's well-known OIDC thumbprint. AWS auto-discovers thumbprints
      // for github.com, but the thumbprint sync still requires a non-empty
      // list when comparing against the cloud-observed value.
      thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
    });

    const role = yield* AWS.IAM.Role("GitHubActionsRole", {
      roleName: "alchemy-github-actions",
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Federated: oidc.openIDConnectProviderArn,
            },
            Action: ["sts:AssumeRoleWithWebIdentity"],
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
              // Any branch / PR / tag inside this repo. Tighten to
              // `repo:.../environment:prod` once GitHub Environments are used.
              StringLike: {
                "token.actions.githubusercontent.com:sub": `repo:${REPO.owner}/${REPO.repository}:*`,
              },
            },
          },
        ],
      },
      // The smoke suite deploys real Lambdas, S3 buckets, DynamoDB tables,
      // etc., so it needs broad access.
      managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
    });

    yield* GitHub.Secrets({
      ...REPO,
      secrets: {
        // check.yml, claude.yml, website.yml previews
        TEST_CLOUDFLARE_ACCOUNT_ID,
        TEST_CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_API_TOKEN.value,
        // website.yml production deploy
        PROD_CLOUDFLARE_ACCOUNT_ID,
        PROD_CLOUDFLARE_API_TOKEN: PROD_CLOUDFLARE_API_TOKEN.value,
        // cloudflare-tools.yml runs the runtime packages' suites against the
        // test account under the unprefixed names.
        CLOUDFLARE_ACCOUNT_ID: TEST_CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_API_TOKEN.value,
        // claude.yml
        AWS_ROLE_ARN: role.roleArn,
        ANTHROPIC_API_KEY,
        // release.yml
        DISCORD_WEBHOOK_URL,
      },
    });

    return {
      TEST_CLOUDFLARE_ACCOUNT_ID,
      TEST_CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_API_TOKEN.value.pipe(
        Output.map(Redacted.value),
      ),
      PROD_CLOUDFLARE_ACCOUNT_ID,
      PROD_CLOUDFLARE_API_TOKEN: PROD_CLOUDFLARE_API_TOKEN.value.pipe(
        Output.map(Redacted.value),
      ),
      AWS_ROLE_ARN: role.roleArn,
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
