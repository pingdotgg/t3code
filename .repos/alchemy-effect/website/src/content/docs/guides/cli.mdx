---
title: CLI Reference
description: All Alchemy CLI commands — deploy, destroy, plan, dev, tail, logs, aws, cloudflare, login, profile, and state.
sidebar:
  order: 1
---

import Terminal from "../../../components/Terminal.astro";

The Alchemy CLI manages the lifecycle of your stacks. Every command
operates on an `alchemy.run.ts` file (or a custom entrypoint) and
targets a **stage** — an isolated environment like `dev_sam`, `prod`,
or `pr-42`.

```sh
alchemy <command> [file] [options]
```

If no file is specified, the CLI looks for `alchemy.run.ts` in the
current directory.

## Common options

These options are shared across most commands:

| Option              | Description                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `--stage <name>`    | Stage to target. Defaults to `dev_$USER` (e.g. `dev_sam`). Must match `[a-z0-9][-_a-z0-9]*`. |
| `--env-file <path>` | Load environment variables from a file before running.                                       |

## `deploy`

Compute a plan, ask for approval, and create/update/delete resources
to match the desired state.

```sh
alchemy deploy [file] [options]
```

<Terminal content={`[u]Plan[/u]: [g]2 to create[/g]

[g]+[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]
[g]+[/g] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [c](1 bindings)[/c]
[s2][g]+[/g] [c]Bucket[/c]

Proceed?
◉ Yes ○ No
[g]✓[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d] [g]created[/g]
[g]✓[/g] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [g]created[/g]
[s2][d]• Uploading worker (14.20 KB) ...[/d]
[s2][d]• Enabling workers.dev subdomain...[/d]
{
[s2]url: "https://myapp-worker-dev-you-abc123.workers.dev",
}`} />

On subsequent deploys, only changed resources are updated:

<Terminal content={`[u]Plan[/u]: [y]1 to update[/y]

[y]~[/y] [b]Worker[/b] [d](Cloudflare.Worker)[/d]

Proceed?
◉ Yes ○ No
[g]✓[/g] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [y]updated[/y]
[s2][d]• Uploading worker (15.10 KB) ...[/d]
{
[s2]url: "https://myapp-worker-dev-you-abc123.workers.dev",
}`} />

| Option              | Description                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--stage <name>`    | Stage to deploy to (defaults to `dev_$USER`)                                                                               |
| `--yes`             | Skip the approval prompt                                                                                                   |
| `--dry-run`         | Show the plan without applying (same as `alchemy plan`)                                                                    |
| `--force`           | Force updates for resources that would otherwise no-op                                                                     |
| `--adopt`           | Adopt pre-existing cloud resources that conflict with this stack instead of failing. Useful for re-importing into a fresh state store. |
| `--profile <name>`  | Auth profile to use (defaults to `default` or `$ALCHEMY_PROFILE`)                                                          |
| `--env-file <path>` | Load environment variables from a file                                                                                     |

```sh
# Deploy to production, skip the prompt
alchemy deploy --stage prod --yes

# Deploy a different stack file
alchemy deploy stacks/github.ts

# Preview what would change
alchemy deploy --dry-run

# Re-import existing cloud resources into a fresh state store
alchemy deploy --adopt
```

### Adoption

When a resource has no prior state, the engine calls the provider's
`read` to check whether the resource already exists in the cloud. The
return value drives one of three paths:

| `read` returns      | Without `--adopt`         | With `--adopt`        |
| ------------------- | ------------------------- | --------------------- |
| `undefined`         | create                    | create                |
| owned (plain attrs) | silent adopt              | silent adopt          |
| `Unowned(attrs)`    | fail `OwnedBySomeoneElse` | take over (silently)  |

"Owned" means the provider can prove the resource was created by
*this* stack/stage/logical-id — typically by inspecting tags or a
naming convention. Recovering a wiped state store for resources you
already own is the **default** behavior: no flag required.

`--adopt` only matters when the provider reports a resource exists
but isn't ours. That's the deliberately load-bearing case: by
default Alchemy refuses to silently overwrite tags/config of a
resource it can't prove ownership of. `--adopt` says "yes, take it
over."

```sh
# Re-import existing alchemy-tagged resources into a fresh state
# store — no flag needed for these. Ones with foreign ownership tags
# will surface as `OwnedBySomeoneElse` errors.
alchemy deploy

# Force takeover of any conflicting resource regardless of tags.
alchemy deploy --adopt
```

You can also enable adoption programmatically by piping the
`adopt` combinator onto a deploy effect from `alchemy/AdoptPolicy`:

```typescript
import { adopt } from "alchemy/AdoptPolicy";

yield* deploy(
  Effect.gen(function* () {
    yield* Cloudflare.Worker("API", { /* ... */ });
  }),
).pipe(adopt(true));
```

`AdoptPolicy` is consulted at plan time, so the combinator must
wrap the *deploy* (or test runner's `stack.deploy(...)`) — not the
inner resource-declaration effect.

Resources without ownership semantics (e.g. APIs that always
return a singleton by name, with no tag concept) silently adopt
unconditionally — `--adopt` is a no-op for them.

## `plan`

Preview what would change without applying anything. Equivalent to
`alchemy deploy --dry-run`.

```sh
alchemy plan [file] [options]
```

<Terminal content={`[u]Plan[/u]: [g]1 to create[/g], [y]1 to update[/y]

[g]+[/g] [b]Queue[/b] [d](AWS.SQS.Queue)[/d]
[y]~[/y] [b]Worker[/b] [d](Cloudflare.Worker)[/d]`} />

The plan uses `+` for creates, `~` for updates, `-` for deletes,
and `•` for no-ops. No approval prompt is shown and no changes are
made.

| Option              | Description                                     |
| ------------------- | ----------------------------------------------- |
| `--stage <name>`    | Stage to plan against (defaults to `dev_$USER`) |
| `--env-file <path>` | Load environment variables from a file          |

## `destroy`

Delete every resource in a stack. Computes a plan where all existing
resources are marked for deletion, asks for approval, and removes
them in dependency order.

```sh
alchemy destroy [file] [options]
```

<Terminal content={`[u]Plan[/u]: [r]2 to delete[/r]

[r]-[/r] [b]Worker[/b] [d](Cloudflare.Worker)[/d]
[r]-[/r] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]

Proceed?
◉ Yes ○ No
[r]✗[/r] [b]Worker[/b] [d](Cloudflare.Worker)[/d] [r]deleted[/r]
[r]✗[/r] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d] [r]deleted[/r]`} />

| Option              | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `--stage <name>`    | Stage to destroy (defaults to `dev_$USER`)           |
| `--yes`             | Skip the approval prompt                             |
| `--dry-run`         | Show what would be deleted without actually deleting |
| `--env-file <path>` | Load environment variables from a file               |

```sh
# Destroy a PR preview environment
alchemy destroy --stage pr-42 --yes
```

## `dev`

Run your stack in development mode with hot reloading.

```sh
alchemy dev [file] [options]
```

Resources are deployed to the cloud while Workers run locally in
workerd. File changes trigger automatic rebuilds and hot reloads.

| Option              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `--stage <name>`    | Stage to use for dev (defaults to `dev_$USER`) |
| `--env-file <path>` | Load environment variables from a file         |

```sh
# Start dev mode
alchemy dev

# Use a custom stage
alchemy dev --stage dev
```

## `tail`

Stream live logs from deployed resources in real time.

```sh
alchemy tail [file] [options]
```

<Terminal content={`Tailing: Worker, Api

[c]2026-04-15 14:32:01.123 PST [Worker][/c] GET /hello.txt 200
[c]2026-04-15 14:32:01.456 PST [Worker][/c] PUT /world.txt 201
[y]2026-04-15 14:32:02.789 PST [Api][/y] POST /api/data 200`} />

Logs from multiple resources are interleaved and color-coded by
resource. The command streams indefinitely until you interrupt it
with `Ctrl+C`.

| Option              | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `--stage <name>`    | Stage to tail (defaults to `dev_$USER`)                             |
| `--filter <ids>`    | Comma-separated logical resource IDs to include (e.g. `Worker,Api`) |
| `--env-file <path>` | Load environment variables from a file                              |

```sh
# Tail only the Worker resource
alchemy tail --filter Worker

# Tail a specific stage
alchemy tail --stage prod
```

## `logs`

Fetch historical logs from deployed resources.

```sh
alchemy logs [file] [options]
```

Unlike `tail`, `logs` fetches a batch of past log entries and exits.

| Option              | Description                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `--stage <name>`    | Stage to fetch logs from (defaults to `dev_$USER`)                      |
| `--filter <ids>`    | Comma-separated logical resource IDs to include                         |
| `--limit <n>`       | Number of log entries to fetch (default: 100)                           |
| `--since <time>`    | Fetch logs since this time — a duration (`1h`, `30m`, `2d`) or ISO date |
| `--env-file <path>` | Load environment variables from a file                                  |

```sh
# Last 50 log entries from all resources
alchemy logs --limit 50

# Logs from the last hour, Worker only
alchemy logs --filter Worker --since 1h

# Logs from a specific stage since a date
alchemy logs --stage prod --since 2026-04-01T00:00:00Z
```

## `aws`

Cloud-provider commands for AWS — managing the per-account
infrastructure that Alchemy itself relies on.

```sh
alchemy aws <subcommand> [options]
```

### `aws bootstrap`

Set up the AWS assets bucket required for deploying Lambda functions
and other AWS resources that need artifact storage.

```sh
alchemy aws bootstrap [options]
```

| Option              | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--profile <name>`  | AWS profile to use for credentials (default: `default`)    |
| `--region <region>` | AWS region to bootstrap (defaults to `AWS_REGION` env var) |
| `--destroy`         | Destroy all bootstrap buckets in the selected region       |
| `--env-file <path>` | Load environment variables from a file                     |

```sh
# Bootstrap with the default profile
alchemy aws bootstrap

# Bootstrap a specific region and profile
alchemy aws bootstrap --profile prod --region us-west-2

# Remove bootstrap resources
alchemy aws bootstrap --destroy
```

## `cloudflare`

Cloud-provider commands for Cloudflare — managing the state-store
worker that backs `Cloudflare.state(...)`, and inspecting its logs.

```sh
alchemy cloudflare <subcommand> [options]
```

### `cloudflare bootstrap`

Manually deploy (or repair) the Cloudflare-hosted HTTP State Store —
the worker + Secrets Store + auth-token secret that back the
remote-state layer used by `Cloudflare.state(...)`.

You normally don't need to run this: the very first stack deploy
that uses `Cloudflare.state(...)` will prompt you to bootstrap
automatically. Use this command to re-run that flow on demand —
typically to recover from a previous deploy that was interrupted
mid-bootstrap.

```sh
alchemy cloudflare bootstrap [options]
```

| Option                  | Description                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>`      | Alchemy auth profile (defaults to `default` or `$ALCHEMY_PROFILE`). Determines which `~/.alchemy/profiles.json` entry is used.    |
| `--force`               | Force a full redeploy even if the worker already exists. Without this flag, an existing worker is **adopted** and only its credentials are refreshed. |
| `--worker-name <name>`  | Override the default state-store worker name. Advanced; only needed if you run multiple state stores per Cloudflare account.      |
| `--env-file <path>`     | Load environment variables from a file                                                                                            |

The bootstrap is idempotent and self-healing:

- If the worker already exists in your Cloudflare account, it is
  **adopted**: the auth token is re-fetched live via a short-lived
  edge-preview probe (the only way to read a Secrets Store value),
  and `~/.alchemy/credentials/<profile>/cloudflare-state-store.json`
  is rewritten with the current token.
- If a previous run failed mid-flight (e.g. the worker got created
  but credentials never landed on disk), the leftover local state
  stack is detected and the deploy resumes where it left off. The
  bootstrap is only considered complete once the local stack has
  been hoisted into the remote store and removed.
- With `--force`, the deploy runs again unconditionally. Existing
  Cloudflare resources (worker, Secrets Store, secret) are still
  reconciled in place rather than replaced — adoption is enabled
  automatically for the bootstrap stack.

```sh
# First-time bootstrap (or repair after a failed deploy)
alchemy cloudflare bootstrap

# Bootstrap a separate profile
alchemy cloudflare bootstrap --profile staging

# Force a full redeploy (e.g. to roll out an updated state-store worker)
alchemy cloudflare bootstrap --force
```

### `cloudflare create-token`

Mint a Cloudflare API token (`POST /user/tokens`) from the CLI. Useful
for creating the `CLOUDFLARE_API_TOKEN` you hand to CI, or a broad local
token for `alchemy deploy`. You'll be pointed to
[your Cloudflare profile](https://dash.cloudflare.com/profile/api-tokens)
once to grab your Global API Key (unless it's already in the environment);
everything else happens in the terminal.

```sh
alchemy cloudflare create-token [options]
```

This command is **standalone** — it does not use an Alchemy auth
profile. Cloudflare only mints a token whose permissions the
authenticating credential is allowed to grant, and OAuth/scoped tokens
silently produce a token with **zero** permissions. So this command
always authenticates with your account's **Global API Key**, read from
`CLOUDFLARE_API_KEY` / `CLOUDFLARE_EMAIL` (or prompted). The key is used
only to create the token and is never stored.

By default it grants a curated set of permissions covering the services
Alchemy commonly deploys (Workers, KV, R2, D1, Queues, DNS, etc.). Pass
`--all-permissions` for a "superuser" token spanning **every** permission
group your account exposes (after a confirmation prompt).

<Terminal content={`◇  Select a Cloudflare account
│  My Account
│
◇  Token name
│  alchemy-superuser
│
◇  Create a superuser token with all permissions?
│  Yes

Created Cloudflare API token "alchemy-superuser" (7cb070fe...).
Granted 360 permission group(s) across 3 policy(ies); token status: active.

cfut_pMtBzTOGHWyFC2RSNvfw8f7p2cc...

Store this value now — Cloudflare only shows it once. Use it as CLOUDFLARE_API_TOKEN.`} />

| Option               | Description                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `--all-permissions`  | Grant every Cloudflare permission group (a "superuser" token). Prompts for confirmation.          |
| `--name <name>`      | Token name. Prompted (required) if omitted.                                                       |
| `--account-id <id>`  | Account to scope the token to. If omitted, you'll be prompted to select one.                      |
| `--env-file <path>`  | Load environment variables (e.g. `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`) from a file            |

The permission groups are resolved **live** from your account (so the
token always uses IDs valid for that account), and the freshly minted
token is verified against `/user/tokens/verify` before the value is
printed.

:::note
The Cloudflare dashboard has a long-standing rendering bug where
API-created tokens show a **blank** permission summary (and a greyed-out
"View") on first load. The permissions are applied regardless — the
`Granted N permission group(s)` line and `token status: active` confirm
it. To see them in the UI, open the token and click "← Edit token".
:::

```sh
# Curated set of permissions for typical Alchemy deploys
alchemy cloudflare create-token --name ci-token

# Full-access "superuser" token
alchemy cloudflare create-token --all-permissions --name admin

# Non-interactive: key/email from the environment, explicit account
CLOUDFLARE_API_KEY=... CLOUDFLARE_EMAIL=you@example.com \
  alchemy cloudflare create-token --name ci --account-id <account-id>
```

### `cloudflare state logs`

Get or tail logs from the `alchemy-state-store` Worker on your
Cloudflare account. Talks directly to the Workers Observability
Telemetry API — no stack file required — so you can debug the
state-store itself.

```sh
alchemy cloudflare state logs [options]
```

Requires `workers_observability:read` and
`workers_observability_telemetry:write` OAuth scopes (included in the
default scope set; existing profiles need to re-run `alchemy login`
to pick them up).

| Option                 | Description                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--tail`               | Stream logs in real time via the Cloudflare tail websocket instead of fetching past entries                  |
| `--limit <n>`          | Number of log entries to fetch when not tailing (default: 100)                                               |
| `--since <time>`       | Fetch logs since this time — a duration (`1h`, `30m`, `2d`) or ISO date                                       |
| `--worker-name <name>` | Override the default state-store worker name. Only needed if you run multiple state stores per account.       |
| `--profile <name>`     | Alchemy auth profile (defaults to `default` or `$ALCHEMY_PROFILE`)                                           |
| `--env-file <path>`    | Load environment variables from a file                                                                        |

```sh
# Last hour of state-store logs
alchemy cloudflare state logs

# Stream live in a separate terminal while you reproduce a bug
alchemy cloudflare state logs --tail

# Just the last 30 minutes
alchemy cloudflare state logs --since 30m --limit 200
```

## `login`

Configure and log in to each cloud provider used by your stack. The
command imports your stack file to discover which `AuthProvider`s are
registered, then walks through each one — prompting for the auth method
the first time, and refreshing tokens (e.g. Cloudflare OAuth) on
subsequent runs.

Credentials are written to `~/.alchemy/profiles.json`, keyed by
**profile name** (defaults to `default`, overridable with
`$ALCHEMY_PROFILE` or `--profile`).

```sh
alchemy login [file] [options]
```

| Option              | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `--profile <name>`  | Profile to write to (defaults to `default` or `$ALCHEMY_PROFILE`)          |
| `--configure`       | Re-run the provider's interactive configure step before logging in         |
| `--stage <name>`    | Stage used while loading the stack (defaults to `dev_$USER`)               |
| `--env-file <path>` | Load environment variables from a file                                     |

```sh
# Log in with the default profile
alchemy login

# Log in to a separate profile
alchemy login --profile prod

# Re-configure (e.g. switch from OAuth to API token) and log in
alchemy login --configure
```

## `profile`

Inspect credentials stored in `~/.alchemy/profiles.json`.

### `profile show`

Print every auth method configured under a profile, along with its
resolved credentials (redacted). Unlike `login`, this does **not**
import your stack file — it reads the profile store directly and uses
the bundled providers (Cloudflare, AWS) to pretty-print each entry.

```sh
alchemy profile show [options]
```

<Terminal content={`Profile: default

── AWS ──
  accessKeyId:     ASIA****
  secretAccessKey: Pj5T****
  sessionToken:    IQoJ****
  region:          us-west-2
  source: sso - default

── Cloudflare ──
  accessToken: Xl06****
  expires: in 59m 58s 999ms (2026-04-27T20:45:47.937Z)
  accountId: 123456789...
  source: oauth`} />

| Option              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `--profile <name>`  | Profile to show (defaults to `default` or `$ALCHEMY_PROFILE`)     |
| `--env-file <path>` | Load environment variables from a file                            |

```sh
# Show the default profile
alchemy profile show

# Show a named profile
alchemy profile show --profile prod
```

## `state`

Inspect and manage the state store — the record of which resources
Alchemy thinks exist for each stack/stage. Reads from whatever state
layer the stack file configures (e.g. `Cloudflare.state(...)`), or
from the on-disk `.alchemy/state` directory with `--local`.

```sh
alchemy state <subcommand> [options]
```

The stack file is imported to resolve its configured state layer, so
all subcommands accept the same `--stage`, `--profile`, and
`--env-file` options as `deploy`. Pass `[file]` via the standard
positional `script` argument inherited from the root command.

| Option              | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `--local`           | Read from local `.alchemy/state` instead of the stack's configured state store    |
| `--stage <name>`    | Stage used while loading the stack (defaults to `dev_$USER`)                      |
| `--profile <name>`  | Auth profile to use (defaults to `default` or `$ALCHEMY_PROFILE`)                 |
| `--env-file <path>` | Load environment variables from a file                                            |

### `state stacks`

List every stack name present in the state store.

```sh
alchemy state stacks [file] [options]
```

### `state stages <stack>`

List every stage that has state recorded under `<stack>`.

```sh
alchemy state stages <stack> [file] [options]
```

### `state resources <stack> <stage>`

List the fully-qualified resource names (FQNs) tracked under a given
stack/stage.

```sh
alchemy state resources <stack> <stage> [file] [options]
```

### `state get <stack> <stage> <fqn>`

Print a single resource's persisted state as JSON. Output uses the
same encoding the store persists: redacted secrets are unwrapped into
`{ __redacted__: ... }` and Resources are flattened.

```sh
alchemy state get <stack> <stage> <fqn> [file] [options]
```

### `state tree`

Render the entire state store as a tree of stacks → stages →
resources.

```sh
alchemy state tree [file] [options]
```

<Terminal content={`AlchemyEffectWebsite
├─ dev_sam
│  ├─ Bucket
│  └─ Worker
└─ prod
   ├─ Bucket
   └─ Worker`} />

### `state clear [stack] [stage]`

Delete state entries from the store. **Destructive but local-only** —
the actual cloud resources are not touched, only Alchemy's record of
them. A subsequent `deploy` will see an empty state and try to
re-create everything (use `--adopt` to reconcile against existing
infrastructure).

```sh
alchemy state clear [stack] [stage] [file] [options]
```

- Omit both arguments to clear **all stacks** in the store.
- Pass `<stack>` to clear every stage under that stack.
- Pass `<stack> <stage>` to clear a single stage.

| Option  | Description              |
| ------- | ------------------------ |
| `--yes` | Skip the confirmation prompt |

```sh
# Inspect what's in the store
alchemy state tree

# Drop a single PR-preview stage
alchemy state clear myapp pr-42 --yes

# Wipe local state after a botched bootstrap
alchemy state clear --local
```

## Stages

Every command targets a **stage** — an isolated instance of your
stack. The stage defaults to `dev_$USER` (e.g. `dev_sam`), so each
developer gets their own environment automatically.

```sh
alchemy deploy --stage prod
alchemy deploy --stage pr-42
alchemy destroy --stage dev_sam
```

Resources are namespaced by stage. Physical names include the stage
(e.g. `myapp-prod-bucket-abc123`), so environments never interfere
with each other.
