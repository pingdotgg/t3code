import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const REPO = { owner: "alchemy-run", repository: "alchemy-effect" } as const;

export default Alchemy.Stack(
  "AlchemyGitHubSecrets",
  {
    providers: Layer.mergeAll(
      AWS.providers(),
      Cloudflare.providers(),
      GitHub.providers(),
      Neon.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const testAccountId = yield* Config.string("TEST_CLOUDFLARE_ACCOUNT_ID");
    const prodAccountId = yield* Config.string("PROD_CLOUDFLARE_ACCOUNT_ID");
    const discordWebhookUrl = yield* Config.string("DISCORD_WEBHOOK_URL");
    const prPackageAuthToken = yield* Config.string("PR_PACKAGE_TOKEN");

    const testApiToken = yield* token("TestApiToken", {
      accountId: testAccountId,
    });

    const prodApiToken = yield* token("ProdApiToken", {
      accountId: prodAccountId,
    });

    // GitHub OIDC trust for AWS — lets `.github/workflows/test.yml` (and any
    // future workflow) assume an IAM role via `aws-actions/configure-aws-credentials`
    // with no long-lived AWS_ACCESS_KEY_ID secrets in the repo.
    const oidc = yield* AWS.IAM.OpenIDConnectProvider("GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIDList: ["sts.amazonaws.com"],
      // GitHub's well-known OIDC thumbprint. AWS auto-discovers thumbprints
      // for github.com these days, but our `iam.updateOpenIDConnectProviderThumbprint`
      // sync still requires a non-empty list when comparing against the
      // cloud-observed value.
      // https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/
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
              // Restrict to any branch / PR / tag inside this repo. Tighten
              // further (e.g. `repo:.../environment:prod`) once we wire up
              // GitHub Environments.
              StringLike: {
                "token.actions.githubusercontent.com:sub": `repo:${REPO.owner}/${REPO.repository}:*`,
              },
            },
          },
        ],
      },
      // The smoke suite deploys real Cloudflare workers, AWS Lambdas, S3
      // buckets, DynamoDB tables, etc., so it needs broad access. Swap for
      // a custom-managed policy enumerating `lambda:*`, `dynamodb:*`, … if
      // you want least-privilege CI.
      managedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"],
    });

    const region = yield* AWS.Region;

    yield* GitHub.Secrets({
      ...REPO,
      secrets: {
        TEST_CLOUDFLARE_API_TOKEN: testApiToken.value,
        TEST_CLOUDFLARE_ACCOUNT_ID: testAccountId,
        PROD_CLOUDFLARE_API_TOKEN: prodApiToken.value,
        PROD_CLOUDFLARE_ACCOUNT_ID: prodAccountId,
        DISCORD_WEBHOOK_URL: discordWebhookUrl,
        PR_PACKAGE_TOKEN: prPackageAuthToken,
        NEON_API_KEY: (yield* Neon.NeonEnvironment).apiKey,
      },
    });

    // Role ARN + region are not secret — publish as repo-level Variables
    // so workflows can reference `vars.AWS_ROLE_ARN` / `vars.AWS_REGION`.
    yield* GitHub.Variables({
      ...REPO,
      variables: {
        AWS_ROLE_ARN: role.roleArn,
        AWS_REGION: region,
      },
    });

    return {
      TEST_CLOUDFLARE_API_TOKEN: testApiToken.value.pipe(
        Output.map(Redacted.value),
      ),
      TEST_CLOUDFLARE_ACCOUNT_ID: testAccountId,
      PROD_CLOUDFLARE_API_TOKEN: prodApiToken.value.pipe(
        Output.map(Redacted.value),
      ),
      PROD_CLOUDFLARE_ACCOUNT_ID: prodAccountId,
      DISCORD_WEBHOOK_URL: discordWebhookUrl,
      AWS_ROLE_ARN: role.roleArn,
      AWS_REGION: region,
    };
  }).pipe(Effect.orDie),
);

const token = (
  id: string,
  props: {
    accountId: string;
  },
) =>
  Cloudflare.AccountApiToken(id, {
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
