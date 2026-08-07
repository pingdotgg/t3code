# Deploy a Cloud Environment on Render

This experimental setup runs one T3 Code environment as a Render web service. The environment owns
the provider processes, repositories, worktrees, terminals, and T3 Code state. The web, desktop, and
mobile clients connect to it over Render's public HTTPS and WebSocket endpoint.

This is an ephemeral, one-session demo environment, not a multi-tenant hosted service. The Free
instance can run multiple agent threads, but loses its files and authentication when it restarts or
spins down.

## What the Blueprint Creates

The root [`render.yaml`](../../render.yaml) creates:

- a Docker web service containing T3 Code, Codex, Claude Code, Git, and the GitHub CLI;
- an ephemeral `/data` workspace for T3 Code state, provider credentials, and repositories;
- an optional `OPENAI_API_KEY` secret prompt for automatic Codex authentication;
- in-app pairing directly from the service URL;
- a health check against T3 Code's public environment descriptor.

## Deploy

1. Open **Settings → Cloud environments** in T3 Code.
2. Choose an authentication method, then select **Deploy on Render**:
   - **OpenAI API key:** enter `OPENAI_API_KEY` in Render's secret prompt. Startup authenticates
     Codex automatically.
   - **ChatGPT subscription:** skip the optional API key, then use device login after cloning.
3. Deploy the Blueprint and wait for the service health check to pass.
4. Copy the service's `.onrender.com` URL, return to T3 Code, paste it under **Connect in T3
   Code**, and select **Connect environment**. T3 Code wakes the service and requests a one-time
   pairing credential; there is no log-copying step.
5. Select **Add project** and choose **Cloud environments → Render cloud
   environment**. Paste a public GitHub URL. T3 Code clones it directly into the Render workspace;
   there is no local destination picker.
6. API-key deployments are ready immediately. For subscription authentication, open the project
   terminal, run `codex login --device-auth`, complete the device login, and start an agent.

Repositories are selected after pairing rather than baked into the Blueprint. Each clone is stored
under `/data/workspace` for the current Free-instance session.

The Render service advertises cloud metadata in its normal T3 environment descriptor. That is what
lets clients present it as a cloud device and automatically route project cloning to its cloud
workspace while leaving the existing local-device folder flow unchanged.

The demo Blueprint is pinned to `feat/render-cloud-environment` so it can deploy before the draft
pull request is merged. Update the `branch` field in `render.yaml` if you rename or reuse the branch.

## Provider Authentication

For API-key authentication, the Blueprint declares `OPENAI_API_KEY` with `sync: false`. Render asks
for it during the initial deployment and stores it as a secret; the value is never committed to the
repository. The startup script pipes it to `codex login --with-api-key` and removes it from the
server process environment afterward.

For ChatGPT subscription authentication, clone a public project, open its T3 Code terminal, and run:

```sh
codex login --device-auth
```

Follow the printed link and enter the device code. The login lasts for the current Free-instance
session and is lost if Render restarts or spins down the service.

## T3 Connect

T3 Connect is not required for this deployment. Render already gives the environment a public HTTPS
and WebSocket endpoint, so the in-app setup registers it as a direct remote environment. Use its
existing Connect and Disconnect controls under **Settings → Cloud environments**. T3 Connect remains
useful for machines that need its managed tunnel or account-level environment discovery.

## Operations

- Anyone with the service URL can request a standard T3 Code pairing credential. Use this setup only
  for a private demo and remove the Render service afterward. Existing paired browser sessions remain
  authenticated until the ephemeral service restarts.
- Render spins a Free web service down after 15 minutes without inbound HTTP or WebSocket traffic.
  A later request starts a fresh instance, so pair, clone, and authenticate again.
- Do not use this Blueprint for untrusted users or repositories. Coding agents can execute commands
  and access every secret available to the service.
