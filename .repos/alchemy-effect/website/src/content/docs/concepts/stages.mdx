---
title: Stages
description: Stages are isolated instances of a Stack — dev_sam, staging, prod, pr-42 — each with their own state and physical names.
sidebar:
  hidden: true
---

A **stage** is an isolated instance of a [Stack](/concepts/stack).
Every deploy targets exactly one stage, and resources from different
stages never overlap. This is how Alchemy gives every developer their
own sandbox, every PR its own preview, and production its own
dedicated environment — all from one program.

## The default stage

If you don't pass `--stage`, alchemy uses **`dev_$USER`** (e.g.
`dev_sam`). Each developer on your team automatically gets a
personal stage without any config.

```sh
$ whoami
sam

$ alchemy deploy
# deploys to stage `dev_sam`
```

The resolution order is:

1. `--stage <name>` flag
2. `$STAGE` environment variable
3. `dev_${USER}` (or `dev_${USERNAME}` on Windows)
4. `dev_unknown` if no user is set

## Common stage patterns

| Stage             | Purpose                                  |
| ----------------- | ---------------------------------------- |
| `dev_<user>`      | Per-developer sandbox (default)          |
| `pr-<n>`          | Per-pull-request preview environment     |
| `staging`         | Shared pre-production                    |
| `prod`            | Production                               |
| `dev`             | Shared development                       |

Stage names must match `[a-z0-9][-_a-z0-9]*`.

```sh
alchemy deploy --stage prod
alchemy deploy --stage pr-42
alchemy destroy --stage pr-42
```

## Isolation

Each stage gets its own:

- **State file** — the persisted record of what's deployed
- **Physical names** — `myapp-prod-bucket-abc123` vs
  `myapp-dev_sam-bucket-9b2c`
- **Logs and metrics** — scoped per deployed function/worker

Because of this, deploying or destroying one stage **never touches**
another:

```sh
$ alchemy deploy --stage dev_sam     # -> myapp-dev_sam-photos-a3f1
$ alchemy deploy --stage pr-147      # -> myapp-pr_147-photos-9b2c
$ alchemy deploy --stage prod        # -> myapp-prod-photos-7d4e

$ alchemy destroy --stage pr-147     # only removes pr-147 resources
```

## Per-stage configuration

The current stage is exposed through the `Stack` service, so the
same program can branch on it:

```typescript
import { Stack } from "alchemy/Stack";

Effect.gen(function* () {
  const stack = yield* Stack;

  const queue = yield* SQS.Queue("Jobs").pipe(
    RemovalPolicy.retain(stack.stage === "prod"),
  );
});
```

For resources declared at module scope, use
[`Stack.useSync`](/concepts/stack#stackusesync-for-module-scope-resources):

```typescript
export class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    memory: stack.stage === "prod" ? 1024 : 512,
  })),
) {}
```

## Pull request previews

A common pattern in CI: spin up a fresh stage for every PR, comment
the URL on the PR, and tear it down on merge.

```yaml
# .github/workflows/preview.yml
- run: alchemy deploy --stage pr-${{ github.event.number }} --yes

# on PR close:
- run: alchemy destroy --stage pr-${{ github.event.number }} --yes
```

See the [CI guide](/guides/ci) for a complete example.

## Stage vs profile

Stages isolate **what** is deployed (state, physical names).
[Profiles](/concepts/profiles) isolate **how** alchemy authenticates
to your cloud providers. They're orthogonal — you can pair a `prod`
stage with a `prod` profile, or use the same credentials across many
stages:

```sh
alchemy deploy --stage prod --profile prod
alchemy deploy --stage pr-42 --profile default
```

For the full set of CLI flags, see the
[CLI reference](/guides/cli#common-options).
