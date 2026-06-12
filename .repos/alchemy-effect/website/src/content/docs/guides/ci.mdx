---
title: Continuous Integration
description: Set up CI/CD pipelines for alchemy projects with GitHub Actions, automated deployments, and PR previews — with provider credentials managed as code.
sidebar:
  order: 2
---

import { Code, Steps, TabItem, Tabs } from "@astrojs/starlight/components";
import yaml from "yaml";

export function DeployWorkflow({ manager = "bun" }) {
  const managers = {
    bun: {
      setup: [
        {
          name: "Setup Bun",
          uses: "oven-sh/setup-bun@v2",
        },
      ],
      install: "bun install",
      run: "bun alchemy",
      destroy: "bun alchemy",
    },
    npm: {
      setup: [
        {
          name: "Setup Node.js",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": "24",
          },
        },
      ],
      install: "npm ci",
      run: "npx alchemy",
      destroy: "npx alchemy",
    },
    pnpm: {
      setup: [
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
          with: {
            version: "10",
            run_install: false,
          },
        },
        {
          name: "Setup Node.js",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": "24",
            cache: "pnpm",
          },
        },
      ],
      install: "pnpm install",
      run: "pnpm dlx alchemy",
      destroy: "pnpm dlx alchemy",
    },
    yarn: {
      setup: [
        {
          name: "Setup Node.js",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": "24",
            cache: "yarn",
          },
        },
        {
          name: "Install yarn",
          run: "npm install -g yarn",
        },
      ],
      install: "yarn install",
      run: "yarn dlx alchemy",
      destroy: "yarn dlx alchemy",
    },
  };

const cfg = managers[manager] || managers.bun;

const content = yaml.stringify({
name: "Deploy Application",
on: {
push: {
branches: ["main"],
},
pull_request: {
types: ["opened", "reopened", "synchronize", "closed"],
},
},
concurrency: {
group: "deploy-${{ github.ref }}",
      "cancel-in-progress": false,
    },
    env: {
      STAGE:
        "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.number) || (github.ref == 'refs/heads/main' && 'prod' || github.ref_name) }}",
},
jobs: {
deploy: {
if: "${{ github.event.action != 'closed' }}",
        "runs-on": "ubuntu-latest",
        permissions: {
          contents: "read",
          "pull-requests": "write",
        },
        steps: [
          {
            uses: "actions/checkout@v4",
          },
          ...cfg.setup,
          {
            name: "Install dependencies",
            run: cfg.install,
          },
          {
            name: "Deploy",
            run: `${cfg.run} deploy --stage \${{ env.STAGE }}`,
            env: {
              PULL_REQUEST: "${{ github.event.number }}",
              GITHUB_SHA: "${{ github.sha }}",
              GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
            },
          },
        ],
      },
      cleanup: {
        "runs-on": "ubuntu-latest",
        if: "${{ github.event_name == 'pull_request' && github.event.action == 'closed' }}",
        permissions: {
          contents: "read",
          "pull-requests": "write",
        },
        steps: [
          {
            uses: "actions/checkout@v4",
          },
          ...cfg.setup,
          {
            name: "Install dependencies",
            run: cfg.install,
          },
          {
            name: "Safety Check",
            run: `if [ "\${{ env.STAGE }}" = "prod" ]; then
echo "ERROR: Cannot destroy prod environment in cleanup job"
exit 1
fi`,
          },
          {
            name: "Destroy Preview Environment",
            run: `${cfg.destroy} destroy --stage \${{ env.STAGE }}`,
            env: {
              PULL_REQUEST: "${{ github.event.number }}",
},
},
],
},
},
}, { aliasDuplicateObjects: false });

return <Code lang="yaml" code={content} />;
}

This guide walks you through wiring up GitHub Actions for an Alchemy
project: a deploy workflow with PR previews, a `stacks/github.ts`
that mints scoped CI credentials and pushes them into your repo, and
provider-specific recipes for Cloudflare and AWS.

The unifying idea is **credentials as code**. Rather than copy-paste
API keys into the GitHub UI, you let Alchemy provision exactly the
credentials your CI needs — a scoped Cloudflare API token, an AWS
IAM role for OIDC, etc. — and write them straight into the repo as
encrypted secrets.

## How PR previews work

Open a PR. Alchemy does the rest.

1. **A pull request is opened.** GitHub fires `pull_request`. The
   workflow computes `STAGE = pr-{number}` and runs the deploy job.
2. **Alchemy deploys the stack to that stage.** An isolated copy of
   every resource — Workers, Lambdas, queues, tables. Stage state
   lives separately, so PRs can't touch each other or prod.
3. **A bot comment is posted (or updated) on the PR.** The
   `GitHub.Comment` resource keeps its logical id stable, so the
   comment updates in place on each push.
4. **PR is merged or closed → cleanup runs.** A second job runs
   `alchemy destroy --stage pr-{n}`. Resources gone. Costs gone.

## What we'll build

By the end you'll have:

1. A GitHub Actions workflow (`.github/workflows/deploy.yml`) with
   PR previews, prod deploys, and automatic cleanup.
2. A `stacks/github.ts` that creates provider credentials and writes
   them to your repo as `GitHub.Secret` / `GitHub.Variable`.
3. A PR-comment resource in your `alchemy.run.ts` that posts the
   preview URL on each push.

## GitHub Actions Workflow

<Steps>

1. **Add preview comments to your stack**

   Update your `alchemy.run.ts` to post a preview URL on each pull
   request. The comment auto-updates on every push because the
   logical ID stays the same.

   ```typescript twoslash
   // @noErrors
   import * as Alchemy from "alchemy";
   + import * as GitHub from "alchemy/GitHub";
   + import * as Output from "alchemy/Output";
   import * as Effect from "effect/Effect";

   export default Alchemy.Stack(
     "my-app",
     { providers: /* ... */ },
     Effect.gen(function* () {
       const app = yield* App;

   +   if (process.env.PULL_REQUEST) {
   +     yield* GitHub.Comment("preview-comment", {
   +       owner: "your-org",
   +       repository: "your-repo",
   +       issueNumber: Number(process.env.PULL_REQUEST),
   +       body: Output.interpolate`
   +         ## Preview Deployed
   +
   +         **URL:** ${app.url}
   +
   +         Built from commit ${process.env.GITHUB_SHA?.slice(0, 7)}
   +
   +         ---
   +         _This comment updates automatically with each push._
   +       `,
   +     });
   +   }

       return { url: app.url };
     }),
   );
   ```

2. **Create the base deployment workflow**

   Create `.github/workflows/deploy.yml`. This workflow deploys `prod` on
   pushes to `main` and a `pr-<number>` stage for each pull request. When a
   PR is closed the preview environment is destroyed automatically.

   <Tabs syncKey="pkgManager">
     <TabItem label="bun">
       <DeployWorkflow manager="bun" />
     </TabItem>
     <TabItem label="npm">
       <DeployWorkflow manager="npm" />
     </TabItem>
     <TabItem label="pnpm">
       <DeployWorkflow manager="pnpm" />
     </TabItem>
     <TabItem label="yarn">
       <DeployWorkflow manager="yarn" />
     </TabItem>
   </Tabs>

   :::note[STAGE Variable Logic]
   The `STAGE` environment variable is computed from the GitHub event:

   ```yaml
   env:
     STAGE: ${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.number) || (github.ref == 'refs/heads/main' && 'prod' || github.ref_name) }}
   ```

   - Pull request events → `pr-{number}`
   - Pushes to `main` → `prod`
   - Other branches → the branch name

   The cleanup job includes a safety check to prevent accidental destruction
   of the production environment.
   :::

3. **Add provider credentials**

   The base workflow above doesn't include any provider credentials yet.
   Pick the section below that matches your provider and apply the changes
   to your workflow.

   `GITHUB_TOKEN` is provided automatically by GitHub Actions and is used
   by the `GitHub.Comment` resource to post PR comments.

</Steps>

## The GitHub Stack

Before CI can deploy, your repo needs provider credentials configured
as Actions secrets and variables. We recommend managing this with a
dedicated `stacks/github.ts` that you deploy once locally — that way
the credential set is reviewable, diffable, and reproducible.

The stack uses `GitHub.Secret` and `GitHub.Variable` to write into
your repository, and provider resources like
`Cloudflare.AccountApiToken` or `AWS.IAM.Role` to mint the
credentials themselves.

### Set up an `admin` profile

The `stacks/github.ts` you're about to write needs more privilege
than your day-to-day app stack. Creating a Cloudflare API token
requires `API Tokens > Write`; creating an IAM role and OIDC
provider requires IAM admin rights.

Rather than hand those rights to your default profile, create a
separate `admin` profile:

```sh
alchemy login --profile admin
```

:::danger[Heads up]
The credentials stored under `--profile admin` can mint new tokens
and roles with arbitrary scope. Treat it like root. Use it only
when deploying `stacks/github.ts`, and keep your default profile
on a narrowly scoped credential (OAuth, a scoped API token, or
OIDC) for everyday `alchemy deploy` runs.
:::

After creating the file, deploy it once locally under the admin
profile:

```sh
alchemy deploy stacks/github.ts --profile admin
```

You only need to re-run this stack when you want to rotate
credentials or change permissions.

## Cloudflare

The simplest case: a single Cloudflare account, used for both prod
and PR previews. Your `admin` profile mints a scoped API token, and
the stack pushes it into your repo as a GitHub Actions secret.

:::caution[Required Cloudflare permissions]
The credential behind `--profile admin` must be allowed to create
API tokens. The two practical options are:

- The **Global API Key** (API Key + Email) — has full account
  access, including token management.
- An **API Token** with at least `User > API Tokens > Write` (for
  user-owned tokens) **and** `Account > API Tokens > Write` for the
  target account.

A standard "Edit Cloudflare Workers" token is **not** enough — it
can deploy Workers but cannot mint other tokens. Use the Global API
Key for `--profile admin` unless you've explicitly configured a
token-management token.
:::

```typescript
// stacks/github.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      GitHub.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");

    const apiToken = yield* Cloudflare.AccountApiToken("CIToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "D1 Write",
            "Queues Write",
            "Pages Write",
            "Account Settings Write",
            "Secrets Store Write",
            "Workers Tail Read",
          ],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    });

    yield* GitHub.Secret("cf-api-token", {
      owner: "your-org",
      repository: "your-repo",
      name: "CLOUDFLARE_API_TOKEN",
      value: apiToken.value,
    });

    yield* GitHub.Secret("cf-account-id", {
      owner: "your-org",
      repository: "your-repo",
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });
  }),
);
```

A few details worth knowing:

- `Cloudflare.AccountApiToken` calls
  `POST /accounts/{account_id}/tokens` and Cloudflare returns the
  freshly minted token value exactly once. Alchemy captures it,
  stores it in state, and pipes it straight into `GitHub.Secret` —
  the raw token never appears in your terminal or in CI logs.
- Trim the `permissionGroups` list to just what your app needs.
  Listed above is a sensible default for a Workers + KV + R2 + D1
  app.
- The resource diff is stable across redeploys. Editing a policy
  produces a clean update against the same token ID.

:::note[Why `Secrets Store Write`?]
`Cloudflare.state()` keeps the state-store worker's bearer token in
the account-wide [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/).
On every CI run Alchemy reads that secret back by uploading a
short-lived edge-preview worker that *binds* the secret — and
binding a Secrets Store secret to a worker (even an ephemeral
preview) requires the **`Secrets Store Write`** permission, not
just `Read`. `Read` is only enough to enumerate the store via
`GET /accounts/{id}/secrets_store/stores`; the
`POST .../scripts/{name}/edge-preview` call that mounts the
binding is rejected without `Write`.
:::

Then add the secrets to your workflow's deploy and cleanup steps:

```diff lang="yaml"
      - name: Deploy
        run: bun alchemy deploy --stage ${{ env.STAGE }}
        env:
+         CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
+         CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PULL_REQUEST: ${{ github.event.number }}
          GITHUB_SHA: ${{ github.sha }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

```diff lang="yaml"
      - name: Destroy Preview Environment
        run: bun alchemy destroy --stage ${{ env.STAGE }}
        env:
+         CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
+         CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PULL_REQUEST: ${{ github.event.number }}
```

### Optional: separate test and prod accounts

For stricter isolation you can run preview environments on one
Cloudflare account and production on another. Mint two tokens from
the same `stacks/github.ts` and prefix the secrets so the workflow
can pick the right pair based on `STAGE`.

```typescript
// stacks/github.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      GitHub.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const testAccountId = yield* Config.string("TEST_CLOUDFLARE_ACCOUNT_ID");
    const prodAccountId = yield* Config.string("PROD_CLOUDFLARE_ACCOUNT_ID");

    const policies = (accountId: string) => [
      {
        effect: "allow" as const,
        permissionGroups: [
          "Workers Scripts Write",
          "Workers KV Storage Write",
          "Workers R2 Storage Write",
          "D1 Write",
          "Queues Write",
          "Pages Write",
          "Account Settings Write",
          "Secrets Store Write",
          "Workers Tail Read",
        ],
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      },
    ];

    const testToken = yield* Cloudflare.AccountApiToken("TestApiToken", {
      accountId: testAccountId,
      policies: policies(testAccountId),
    });

    const prodToken = yield* Cloudflare.AccountApiToken("ProdApiToken", {
      accountId: prodAccountId,
      policies: policies(prodAccountId),
    });

    const secrets: Record<string, Redacted.Redacted<string>> = {
      TEST_CLOUDFLARE_API_TOKEN: testToken.value,
      TEST_CLOUDFLARE_ACCOUNT_ID: Redacted.make(testAccountId),
      PROD_CLOUDFLARE_API_TOKEN: prodToken.value,
      PROD_CLOUDFLARE_ACCOUNT_ID: Redacted.make(prodAccountId),
    };

    yield* Effect.all(
      Object.entries(secrets).map(([name, value]) =>
        GitHub.Secret(name, {
          owner: "your-org",
          repository: "your-repo",
          name,
          value,
        }),
      ),
    );
  }),
);
```

Your `admin` profile needs API-token-write permission on **both**
accounts. The simplest setup is to log in with the Global API Key of
a user that's a member of both.

In your workflow, switch on `STAGE` to choose the right credential
pair:

```diff lang="yaml"
      - name: Deploy
        run: bun alchemy deploy --stage ${{ env.STAGE }}
        env:
+         CLOUDFLARE_API_TOKEN: ${{ env.STAGE == 'prod' && secrets.PROD_CLOUDFLARE_API_TOKEN || secrets.TEST_CLOUDFLARE_API_TOKEN }}
+         CLOUDFLARE_ACCOUNT_ID: ${{ env.STAGE == 'prod' && secrets.PROD_CLOUDFLARE_ACCOUNT_ID || secrets.TEST_CLOUDFLARE_ACCOUNT_ID }}
          PULL_REQUEST: ${{ github.event.number }}
          GITHUB_SHA: ${{ github.sha }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## AWS with GitHub OIDC (recommended)

GitHub OIDC lets your workflow assume an IAM role without storing
long-lived access keys. The GitHub stack creates the OIDC provider
and an IAM role scoped to your repo, then writes the role ARN and
region to the repo as Actions **variables** (not secrets — they're
not sensitive).

Your `--profile admin` AWS credentials need IAM admin rights for
this stack: it creates an `OpenIDConnectProvider` and an IAM `Role`.
Run `alchemy login --profile admin` and choose a credential
(SSO/OIDC, access keys, etc.) that's authorized for IAM
administration.

```typescript
// stacks/github.ts
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(
      AWS.providers(),
      GitHub.providers(),
    ),
  },
  Effect.gen(function* () {
    const oidc = yield* AWS.IAM.OpenIDConnectProvider("GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIDList: ["sts.amazonaws.com"],
      // GitHub's well-known OIDC thumbprint. AWS auto-discovers
      // thumbprints for github.com these days, but the provider's
      // thumbprint sync still requires a non-empty list.
      // https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/
      thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
    });

    const role = yield* AWS.IAM.Role("GitHubActionsRole", {
      roleName: "github-actions",
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
                "token.actions.githubusercontent.com:aud":
                  "sts.amazonaws.com",
              },
              StringLike: {
                "token.actions.githubusercontent.com:sub":
                  "repo:your-org/your-repo:*",
              },
            },
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/AdministratorAccess",
      ],
    });

    const region = yield* AWS.Region;

    yield* GitHub.Variable("aws-role-arn", {
      owner: "your-org",
      repository: "your-repo",
      name: "AWS_ROLE_ARN",
      value: role.roleArn,
    });

    yield* GitHub.Variable("aws-region", {
      owner: "your-org",
      repository: "your-repo",
      name: "AWS_REGION",
      value: region,
    });
  }),
);
```

:::tip[Tighten the role]
`AdministratorAccess` is the path of least resistance for getting
CI working, but for production you should swap it for a
custom-managed policy that grants only the actions your app needs
(for example, `lambda:*`, `dynamodb:*`, and the bucket actions
you use). The `assumeRolePolicyDocument` already restricts who can
assume the role to your specific repo via the `sub` condition.
:::

After deploying, update the workflow to add `id-token: write` and
the `configure-aws-credentials` step. No secrets needed:

```diff lang="yaml"
    deploy:
      permissions:
+       id-token: write
        contents: read
        pull-requests: write
      steps:
        - uses: actions/checkout@v4
        # ...setup and install...
+       - name: Configure AWS credentials
+         uses: aws-actions/configure-aws-credentials@v4
+         with:
+           role-to-assume: ${{ vars.AWS_ROLE_ARN }}
+           aws-region: ${{ vars.AWS_REGION }}
        - name: Deploy
          run: bun alchemy deploy --stage ${{ env.STAGE }}
```

```diff lang="yaml"
    cleanup:
      permissions:
+       id-token: write
        contents: read
        pull-requests: write
      steps:
        - uses: actions/checkout@v4
        # ...setup, install, and safety check...
+       - name: Configure AWS credentials
+         uses: aws-actions/configure-aws-credentials@v4
+         with:
+           role-to-assume: ${{ vars.AWS_ROLE_ARN }}
+           aws-region: ${{ vars.AWS_REGION }}
        - name: Destroy Preview Environment
          run: bun alchemy destroy --stage ${{ env.STAGE }}
```

## AWS with access keys

If OIDC isn't an option (some sandbox accounts disallow it, or
you're targeting an account you don't fully control), fall back to
static IAM access keys stored as repo secrets. The stack pushes
existing keys from your environment into the repo — it does **not**
mint a new IAM user, since most teams prefer to do that step in the
AWS console.

```typescript
// stacks/github.ts
import * as Alchemy from "alchemy";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export default Alchemy.Stack(
  "github",
  {
    providers: GitHub.providers(),
  },
  Effect.gen(function* () {
    const accessKeyId = yield* Config.string("AWS_ACCESS_KEY_ID");
    const secretAccessKey = yield* Config.redacted("AWS_SECRET_ACCESS_KEY");

    yield* GitHub.Secret("aws-access-key-id", {
      owner: "your-org",
      repository: "your-repo",
      name: "AWS_ACCESS_KEY_ID",
      value: Redacted.make(accessKeyId),
    });

    yield* GitHub.Secret("aws-secret-access-key", {
      owner: "your-org",
      repository: "your-repo",
      name: "AWS_SECRET_ACCESS_KEY",
      value: secretAccessKey,
    });

    yield* GitHub.Variable("aws-region", {
      owner: "your-org",
      repository: "your-repo",
      name: "AWS_REGION",
      value: "us-east-1",
    });
  }),
);
```

Then add the secrets to your workflow's deploy and cleanup steps:

```diff lang="yaml"
      - name: Deploy
        run: bun alchemy deploy --stage ${{ env.STAGE }}
        env:
+         AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
+         AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
+         AWS_REGION: ${{ vars.AWS_REGION || 'us-east-1' }}
          PULL_REQUEST: ${{ github.event.number }}
          GITHUB_SHA: ${{ github.sha }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

```diff lang="yaml"
      - name: Destroy Preview Environment
        run: bun alchemy destroy --stage ${{ env.STAGE }}
        env:
+         AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
+         AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
+         AWS_REGION: ${{ vars.AWS_REGION || 'us-east-1' }}
          PULL_REQUEST: ${{ github.event.number }}
```
