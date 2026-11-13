# @alchemy.run/github

GitHub for [Alchemy](https://alchemy.run). Declare repositories, Actions secrets and variables, environments, webhooks, and branch protection in the same TypeScript program as the infrastructure your CI deploys.

```sh
npm install alchemy @alchemy.run/github effect
```

A repository, with the variables its deploy workflow needs:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyRepos",
  {
    providers: GitHub.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* GitHub.Repository("api", {
      owner: "my-org",
      name: "api",
      description: "API service",
      autoInit: true,
      deleteBranchOnMerge: true,
    });

    yield* GitHub.Variables({
      owner: "my-org",
      repository: "api",
      variables: { AWS_REGION: "us-east-1" },
    });

    yield* GitHub.Environment("production", {
      owner: "my-org",
      repository: "api",
      name: "production",
      reviewers: { teams: ["platform"] },
    });

    return { url: repo.htmlUrl };
  }),
);
```

Outputs from other providers flow straight in: pass a role ARN from `@alchemy.run/aws` as a variable, or an Axiom ingest token as a secret, and they stay in sync on every deploy.

## Learn more

- [GitHub on alchemy.run](https://alchemy.run/github)
- [Setup](https://alchemy.run/github/setup)
- [Actions secrets and variables](https://alchemy.run/github/actions-config)
- [Repository events](https://alchemy.run/github/events)
