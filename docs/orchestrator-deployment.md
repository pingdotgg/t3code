# Orchestrator Deployment

This playbook covers the part that comes **after** the remote machine is already deployed and T3 is already reachable.

Use this guide when:

- the machine setup from [remote-deployment.md](./remote-deployment.md) is already done
- T3 already runs on the remote host
- you now need to deploy `apps/orchestrator` into Convex
- you need to connect Convex to the existing T3 worker bridge on the machine

This guide is intentionally narrower than the full Linear MVP setup doc. It focuses only on:

1. deploying Convex for `apps/orchestrator`
2. configuring the existing worker host so Convex can call it
3. confirming the two-way bridge is live

For the broader Linear setup and MVP caveats, see [linear-agent-mvp-setup.md](./linear-agent-mvp-setup.md).

## Assumption

This guide assumes the remote machine is already working.

In practical terms, that means:

- T3 already loads at a public or private hostname
- the machine already has Bun, the repo, built assets, and provider auth
- the `t3code` service is already running
- Caddy or another reverse proxy is already in place if the host is public

## Important clarification

If T3 is already publicly reachable on a host like `https://your-t3-host.example.com`, then you very likely already have the **bridge route deployed** too.

Why:

- the bridge route is part of the same `apps/server` process
- the worker bridge endpoint is `POST /api/execution/runs`
- if the public host reverse-proxies all traffic to T3, that route is already exposed on the same host

The question is usually not "is the route deployed?"

The real questions are:

- is the route reachable through the public host?
- is `T3_EXECUTION_BRIDGE_SHARED_SECRET` configured on the worker?
- is `ORCHESTRATOR_BASE_URL` configured on the worker?
- is Convex configured with the matching base URL and shared secret?

If the bridge route is already present but not configured, an unauthenticated request often looks like one of these:

```http
HTTP/2 401
{"error":"Unauthorized execution bridge request."}
```

or:

```http
HTTP/2 503
{"error":"Execution bridge secret is not configured."}
```

Interpretation:

- `401` usually means the route is live and the shared secret is configured
- `503` usually means the route is live but the worker is missing `T3_EXECUTION_BRIDGE_SHARED_SECRET`

## Target topology

For the fastest MVP, use the same public hostname for both:

- the T3 UI
- the worker bridge endpoint

That means Convex calls:

```bash
T3_EXECUTION_BRIDGE_BASE_URL="https://your-t3-host.example.com"
```

and T3 calls Convex back at:

```bash
ORCHESTRATOR_BASE_URL="https://<your-deployment>.convex.site"
```

This is the same single-hostname shortcut described in [remote-deployment.md](./remote-deployment.md) and [linear-agent-mvp-setup.md](./linear-agent-mvp-setup.md).

## Step 1: Deploy Convex for `apps/orchestrator`

From the repo root:

```bash
cd /path/to/t3code/apps/orchestrator
```

If this repo defines wrapper scripts for Convex, prefer those over raw CLI calls so local project conventions stay in one place.

In this repo, the orchestrator app exposes:

```bash
bun run dev
bun run deploy
```

Those scripts already:

- use `bunx` instead of `npx`
- disable Convex AI files before running
- keep local operator commands consistent with the repo

If this is the first time attaching the app to a Convex project:

```bash
bunx convex dev
```

Use that once to:

- authenticate with Convex
- select or create the project
- generate/update Convex codegen if needed

Then deploy the orchestrator:

```bash
bunx convex deploy
```

or, if the app defines a wrapper script:

```bash
bun run deploy
```

Important note:

- if your local `.env.local` points at a dev deployment, Convex may prompt for an explicit confirmation before pushing to prod
- for that case, run the deploy command interactively and confirm the production push

After deployment, note the public Convex site URL for HTTP actions. It will look like:

```text
https://<deployment-name>.convex.site
```

That is the value the worker must use for:

```bash
ORCHESTRATOR_BASE_URL
```

## Step 2: Set Convex bridge environment variables

From `apps/orchestrator`:

```bash
bunx convex env set --prod T3_EXECUTION_BRIDGE_BASE_URL 'https://your-t3-host.example.com'
bunx convex env set --prod T3_EXECUTION_BRIDGE_SHARED_SECRET '<strong-random-secret>'
```

At minimum for the bridge itself, Convex must have:

- `T3_EXECUTION_BRIDGE_BASE_URL`
- `T3_EXECUTION_BRIDGE_SHARED_SECRET`

These are the only Convex env vars you need to bring up the worker bridge itself.

Important note:

- if your local `.env.local` is attached to a dev deployment, omiting `--prod` will write these values to dev instead of production
- for production setup, prefer `bunx convex env set --prod ...`

## Step 2a: Set Up Linear And Collect Linear Env Vars

Do this step once you are ready to prepare the Linear side of the MVP.

Official references:

- [Linear agents getting started](https://linear.app/developers/agents)
- [Linear webhooks](https://linear.app/developers/webhooks)

### 1. Create a new Linear OAuth application

In Linear, create a new application and configure it as an agent-style app.

Important naming note:

- the application name and icon become the identity your agent uses inside Linear
- this is what users will see in mention surfaces and issue activity
- choose the final bot name now instead of using a generic placeholder

Avoid using a hardcoded repo-default name like `t3-orchestrator` unless that is truly the identity you want users to see in Linear.

Callback URL guidance:

- Linear requires at least one OAuth callback URL when creating the app
- the orchestrator now owns the callback path for the install flow
- use the Convex site you control so the same deployment can start the install and complete the callback

Recommended callback URL:

```text
https://<your-deployment>.convex.site/linear/oauth/callback
```

Current implementation:

- `GET /linear/oauth/install` redirects to the Linear `actor=app` authorization URL
- `GET /linear/oauth/callback` exchanges the returned code and renders an operator-facing completion page
- runtime auth still uses client credentials for posting replies and fetching app-scoped access

### 2. Enable the right Linear application settings

In the app configuration:

- enable webhooks
- enable client credentials tokens
- optionally enable `Agent session events` if you want future agent-session surfaces visible in the same app
- optionally enable `Inbox notifications`
- optionally enable `Permission changes`

For the current branch, the runtime trigger still comes from signed `Comment create` webhooks rather than agent-session webhooks.

### 3. Collect the Linear credentials and secrets

You will need these values from the Linear app settings:

- `LINEAR_CLIENT_ID`
- `LINEAR_CLIENT_SECRET`

You will also need a webhook signing secret:

- `LINEAR_WEBHOOK_SECRET`

Linear's webhook docs say the signing secret is shown on the webhook detail page and is used to verify the `Linear-Signature` header against the raw request body.

### 4. Choose the bot username value

Set:

- `LINEAR_BOT_USERNAME`

This should be the custom agent name you want to use in the workspace, typically matching the app display name or a stable short variant of it.

Do not treat this as a fixed framework value. It is part of your product identity in Linear.

### 5. Install the app into the workspace as an app actor

Linear's current agent docs say to install the app using:

- `actor=app`

Recommended scopes for the MVP:

- `read`
- `write`
- `comments:create`
- `app:mentionable`
- optionally `app:assignable`

Use `app:assignable` only if you want issue delegation to trigger runs in addition to mentions.

This matches the Chat SDK Linear adapter guidance for `actor=app` installs, which uses:

```text
scope=read,write,comments:create,app:mentionable
```

### 6. Register the webhook URL

Use the Convex HTTP action endpoint:

```text
https://<your-deployment>.convex.site/linear/webhook
```

Current implementation:

- `Callback URL` in Linear should be `https://<your-deployment>.convex.site/linear/oauth/callback`
- `Webhook URL` in Linear should be `https://<your-deployment>.convex.site/linear/webhook`
- the webhook route now verifies the raw `Linear-Signature` header and handles raw `Comment create` events directly
- unsupported webhook resources are accepted and ignored instead of being reshaped through a temporary relay

When creating the separate webhook in Linear, the Chat SDK adapter docs say to select:

- `Comments` data change events: required
- `Issues`: recommended
- `Emoji reactions`: optional

Attachment note:

- the Chat SDK Linear adapter currently lists `File uploads` as unsupported
- do not plan the MVP around issue attachments or bot-uploaded files in Linear
- attachments may still appear to users as normal Linear links or markdown references in comment bodies, but they are not part of the adapter's supported upload or first-class file ingestion surface

### 7. Persist the Linear env vars in Convex

Once you have the real values, set them in `apps/orchestrator`:

```bash
bunx convex env set --prod LINEAR_CLIENT_ID '<linear-client-id>'
bunx convex env set --prod LINEAR_CLIENT_SECRET '<linear-client-secret>'
bunx convex env set --prod LINEAR_WEBHOOK_SECRET '<linear-webhook-secret>'
bunx convex env set --prod LINEAR_BOT_USERNAME '<your-custom-bot-name>'
bunx convex env set --prod LINEAR_DEFAULT_WORKSPACE_ROOT '/absolute/path/to/the-repo-on-the-worker'
```

`LINEAR_DEFAULT_WORKSPACE_ROOT` is the single-repo MVP mapping. When a matching Linear mention arrives, Convex uses that path as the worker `workspaceRoot` until a richer team/project-to-repo resolver exists.

## Step 3: Configure the existing worker host

Because the route is already live on your existing T3 host, this step is about **wiring env vars into the existing T3 service**, not redeploying the route.

The worker needs:

```bash
ORCHESTRATOR_BASE_URL="https://<your-deployment>.convex.site"
T3_EXECUTION_BRIDGE_SHARED_SECRET="<same-strong-random-secret>"
```

If the service already uses an env file, update it there.

That env file is the right persistence point when the systemd unit includes something like:

```ini
EnvironmentFile=/etc/t3code.env
```

In that setup, `ORCHESTRATOR_BASE_URL` belongs in `/etc/t3code.env`, not in an ad hoc shell profile.

Typical example:

```bash
sudo tee /etc/t3code.env >/dev/null <<'EOF'
T3CODE_HOME=/var/lib/t3code
ORCHESTRATOR_BASE_URL=https://<your-deployment>.convex.site
T3_EXECUTION_BRIDGE_SHARED_SECRET=<same-strong-random-secret>
EOF
```

If the service uses inline `Environment=` entries in systemd instead, update the service definition instead of adding a new env file.

After changing the worker config:

```bash
sudo systemctl daemon-reload
sudo systemctl restart t3code
sudo systemctl status t3code
```

## Step 4: Confirm the bridge is configured

Without auth, a healthy bridge route should now return `401 Unauthorized`, not `503`.

Check:

```bash
curl -i -X POST https://your-t3-host.example.com/api/execution/runs
```

Interpretation:

- `401 Unauthorized`: good, route is live and secret is configured
- `503 Execution bridge secret is not configured`: route is live but worker secret is still missing
- `404`: proxy or server route is not exposed correctly

## Step 5: Optional authenticated smoke test

Once the worker and Convex are both configured, you can test the worker bridge directly.

Use a safe repo path that already exists on the worker:

```bash
curl -i -X POST https://your-t3-host.example.com/api/execution/runs \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <same-strong-random-secret>' \
  --data '{
    "controlThreadId":"manual-test-thread",
    "executionRunId":"manual-test-run-1",
    "initialPrompt":"Write a short status note and stop.",
    "workspaceRoot":"/srv/t3-workspaces/<repo>",
    "runtimeMode":"full-access",
    "interactionMode":"default"
  }'
```

Expected result:

- the request returns `202`
- T3 creates a run/thread
- T3 later POSTs lifecycle events back to Convex at:

```text
https://<your-deployment>.convex.site/t3/execution-events
```

## Step 6: Verify the two-way bridge

At this point, the critical checks are:

- Convex can call `https://your-t3-host.example.com/api/execution/runs`
- the worker accepts authenticated bridge traffic
- the worker can call `https://<your-deployment>.convex.site/t3/execution-events`
- both sides use the exact same `T3_EXECUTION_BRIDGE_SHARED_SECRET`

It is also useful to verify that the Convex site URL itself is live:

```bash
curl -i https://<your-deployment>.convex.site/health
```

Expected result:

- `200 OK`
- response body `ok`

This is the minimum infrastructure needed before trying to bring Linear into the loop.

## What this does not complete yet

This guide gets the infrastructure in place, but it does **not** make the full Linear MVP production-ready by itself.

Current code caveats still apply:

- the current branch handles raw signed `Comment create` webhooks, but it still ignores other webhook resource types
- install/auth is now enough for `actor=app` setup, but the runtime still assumes one default worker repo path through `LINEAR_DEFAULT_WORKSPACE_ROOT`
- reply posting is intentionally lifecycle-based and minimal; richer result summaries still need later plan phases
- worker restart recovery is still limited by the in-memory T3 run registry

Those gaps are described in [linear-agent-mvp-setup.md](./linear-agent-mvp-setup.md).

## Fast operator checklist

Use this when you just want the shortest sequence.

1. Confirm `https://your-t3-host.example.com/api/execution/runs` exists.
2. Deploy `apps/orchestrator` with `bunx convex deploy`.
3. Set Convex env:
   - `T3_EXECUTION_BRIDGE_BASE_URL=https://your-t3-host.example.com`
   - `T3_EXECUTION_BRIDGE_SHARED_SECRET=<secret>`
   - `LINEAR_DEFAULT_WORKSPACE_ROOT=/absolute/path/to/the-repo-on-the-worker`
4. Set worker env:
   - `ORCHESTRATOR_BASE_URL=https://<deployment>.convex.site`
   - `T3_EXECUTION_BRIDGE_SHARED_SECRET=<secret>`
5. Configure the Linear app:
   - `Callback URL=https://<deployment>.convex.site/linear/oauth/callback`
   - `Webhook URL=https://<deployment>.convex.site/linear/webhook`
6. Visit `https://<deployment>.convex.site/linear/oauth/install` to complete the `actor=app` install.
7. Restart `t3code`.
8. Re-run:

```bash
curl -i -X POST https://your-t3-host.example.com/api/execution/runs
```

7. Expect `401`, not `503`.
