# Remote Deployment Guide

This guide is for running T3 Code headlessly on a remote Linux machine so a desktop client can pair to it and use it as a remote coding environment.

It is intentionally focused on:

- AWS EC2
- DigitalOcean Droplets
- generic Ubuntu VPS hosts

It does **not** cover the desktop app packaging flow. This is the operator runbook for a server-style install.

## Recommended topology

The safest deployment model for T3 Code is:

1. run the server headlessly with `t3 serve`
2. bind it to a private address, not the public internet
3. connect to it over a trusted private network such as Tailscale
4. pair the desktop client using the printed pairing URL

This matches the repo's own remote-access guidance in [REMOTE.md](../REMOTE.md).

Why this is the default recommendation:

- pairing URLs are effectively temporary passwords
- T3 already has a clean remote bootstrap flow built around pairing + bearer sessions
- private-network exposure is much simpler and safer than designing a public edge around an early-stage internal tool

## Playbook map

Follow the guide in order. For the EC2 path, the current live step is Section 1.

1. Shared prerequisites
2. Section 1: Launch the EC2 instance
3. Section 2: SSH in and install host packages
4. Section 3: Install Bun, clone the repo, and build
5. Section 4: Install and authenticate a provider
6. Section 5: Install Tailscale and choose the bind host
7. Section 6: Start T3 headlessly and pair
8. Section 7: Move the server under systemd
9. Section 8: Day-2 operations

## Shared prerequisites

Before the cloud-specific steps, the T3-specific requirements are the same everywhere:

- Bun installed on the server
- the repo checked out on the server
- at least one provider installed and authenticated
- a persistent `T3CODE_HOME`
- a reachable host/IP for `t3 serve --host ...`

Relevant repo references:

- remote access model: [REMOTE.md](../REMOTE.md)
- headless `serve` command: [apps/server/src/cli.ts](../apps/server/src/cli.ts)
- default port and host config: [apps/server/src/config.ts](../apps/server/src/config.ts)
- pairing URL generation: [apps/server/src/startupAccess.ts](../apps/server/src/startupAccess.ts)
- remote client bootstrap flow: [apps/web/src/environments/remote/api.ts](../apps/web/src/environments/remote/api.ts)

## Generic VPS recipe

This is the baseline path that also applies to EC2 and DigitalOcean after instance creation.

### 1. Join the machine to a tailnet

T3's own docs recommend a trusted private network such as Tailscale.

Tailscale Linux install docs: [tailscale.com/download/linux](https://tailscale.com/download/linux)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
```

Use the printed Tailscale IPv4 as the host for T3.

### 2. Start T3 headlessly

If you want a manual first run:

```bash
cd /path/to/ai.code/apps/server
T3CODE_HOME=/var/lib/t3code \
node dist/bin.mjs serve \
  --host "$(tailscale ip -4)" \
  --port 3773 \
  /srv/t3-workspaces
```

That prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code

### 3. Pair the desktop client

On the client machine:

- paste the full pairing URL into T3 Code
- or enter the host and pairing code manually

After pairing, the client exchanges the pairing credential for a bearer session and then requests a websocket token. You do not keep using the original pairing token for normal traffic.

### 4. Move the server under systemd

Use a dedicated service so the process survives disconnects and reboots.

Example unit:

```ini
[Unit]
Description=T3 Code Headless Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ai.code/apps/server
Environment=T3CODE_HOME=/var/lib/t3code
ExecStart=/usr/bin/env bash -lc 'node dist/bin.mjs serve --host "$(tailscale ip -4)" --port 3773 /srv/t3-workspaces'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now t3code
sudo systemctl status t3code
journalctl -u t3code -f
```

### 5. Optional observability

Useful remote env vars:

- `T3CODE_TRACE_FILE`
- `T3CODE_OTLP_TRACES_URL`
- `T3CODE_OTLP_METRICS_URL`
- `T3CODE_LOG_WS_EVENTS`

See [docs/observability.md](./observability.md).

## AWS EC2 playbook

AWS docs for launching and connecting to a Linux instance:

- EC2 launch tutorial: [docs.aws.amazon.com/.../tutorial-launch-a-test-ec2-instance.html](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/tutorial-launch-a-test-ec2-instance.html)
- security group rules: [docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html)

Recommended EC2 shape for T3:

- Ubuntu LTS instance
- SSH key pair
- inbound SSH restricted to your IP
- no public `3773` unless you are intentionally exposing the server
- if you are not using Tailscale, add inbound TCP `3773` from your IP only
- Tailscale is optional, not required

Recommended EC2 size for a machine that may run many Codex/Claude sessions and many worktrees:

- default choice: `r7i.2xlarge` on `x86_64` / `amd64`
- spec: 8 vCPU, 64 GiB RAM, EBS-only storage
- why: the machine is more likely to be memory-bound than burst-CPU-bound once multiple sessions and worktrees pile up
- avoid as the default: `t3.*` and `t4g.*` burstable families
- budget fallback: `m7i.2xlarge` on `x86_64` / `amd64` if you want a cheaper 8 vCPU option with 32 GiB RAM
- scale-up option: `r7i.4xlarge` if you expect several active sessions at once and want a lot of headroom
- root volume guidance: use `gp3` and give the instance at least `200 GiB` of disk; use `300-500 GiB` if you expect lots of repos, worktrees, logs, and provider caches

### Section 1: Launch the EC2 instance

If you are starting from scratch on AWS, this is the first thing to do.

1. Go to the EC2 console and launch a new instance.
2. Choose `Ubuntu Server 24.04 LTS (HVM), SSD Volume Type`.
3. Pick the `64-bit (x86)` / `amd64` variant, not Arm, unless you have a specific reason to standardize on Arm.
4. Pick a small general-purpose instance to start only if this is a quick test. For a machine that may run many sessions and worktrees, use `r7i.2xlarge`.
5. Do not choose the Ubuntu Pro, SQL Server, or Deep Learning AMIs for this setup.
6. If 24.04 is not available in your region, use `Ubuntu Server 22.04 LTS (HVM), SSD Volume Type` with the `64-bit (x86)` / `amd64` variant instead.
7. Set the root volume to `gp3` and give it at least `200 GiB`; use `300-500 GiB` if you expect lots of repos, worktrees, logs, and provider caches.
8. Create or select an SSH key pair and keep the `.pem` file safe.
9. Configure the security group to allow inbound SSH (`22`) from your IP only.
10. Leave inbound `3773` closed if you plan to use Tailscale.
11. Launch the instance and note its public IPv4 address for SSH.

### Section 2: SSH in and install host packages

SSH into the instance as soon as it comes up, then install the basic toolchain you will need for Bun, git, and any native module builds.

```bash
ssh -i /path/to/key.pem ubuntu@<ec2-public-ip>
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential unzip
```

### Section 3: Install Bun, clone the repo, and build

Install Bun, clone the repo, install dependencies, and build both the web app and the server before you try to start it headlessly.

Why both builds matter:

- `apps/server` serves the browser UI from the built `apps/web/dist` output when no dev server is configured
- if you only build `apps/server`, the remote host can start but browser requests can fall back to `503 No static directory configured and no dev URL set`

```bash
curl -fsSL https://bun.com/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

git clone <your-fork-url> ai.code
cd ai.code
bun install

cd apps/web
bun run build

cd apps/server
bun run build
```

### Section 4: Install and authenticate a provider

At least one provider must be installed and authenticated on the EC2 machine before the server can do useful work.

For a host that runs T3 under `systemd`, install the provider CLIs onto the machine-wide PATH:

```bash
sudo npm install -g @openai/codex @anthropic-ai/claude-code
```

Verify the binaries are available:

```bash
which codex
codex --version

which claude
claude --version
```

Expected result:

- `codex` resolves on PATH and prints a version
- `claude` resolves on PATH and prints a version such as `2.x.x (Claude Code)`

Then authenticate whichever providers you plan to use on that worker:

```bash
codex login --device-auth
# or
claude auth login
```

You can check auth status later with:

```bash
codex login status
claude auth status
```

Operational notes:

- run the login commands as the same Unix user that runs `t3code.service`
- if you follow the example service in this guide, that user is `ubuntu`
- a machine-wide install is simplest because the default service PATH already includes `/usr/bin` and `/usr/local/bin`
- if you choose a user-local install instead, either add that bin directory to the service PATH or set an explicit provider binary path in T3 settings
- on a headless EC2 machine, prefer `codex login --device-auth` because it prints a verification URL and one-time code you can open from your own browser
- keep that SSH session open until the browser flow completes, then rerun `codex login status` to confirm the worker is authenticated

#### Claude on Amazon Bedrock

Current T3 behavior is important here:

- T3 does not have first-class Bedrock settings for Claude today
- the Claude provider surface in T3 is currently just the `claude` binary path plus optional `customModels`
- T3 delegates Claude execution to Claude Code / the Claude Agent SDK, so the supported Bedrock path is to configure Bedrock in Claude Code on the worker machine and let T3 reuse that setup

Recommended path:

1. SSH into the worker as the same Unix user that runs `t3code.service`
2. Run `claude`
3. In the Claude Code login flow, choose `3rd-party platform`
4. Choose `Amazon Bedrock`
5. Follow the wizard to select your AWS credential source, region, and model pins

Why this is the default recommendation:

- Claude Code officially supports Bedrock
- the wizard writes the resulting AWS and Bedrock settings into Claude Code's own settings file, which is easier than trying to keep extra shell exports in sync with `systemd`
- T3 already calls the `claude` binary and Claude Agent SDK, so it benefits from Claude Code's Bedrock support without needing separate AWS auth plumbing in T3 itself

If you prefer a non-interactive or scripted setup, Claude Code also supports manual Bedrock configuration with environment variables such as:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=<your-bedrock-region>
export AWS_PROFILE=<your-profile> # optional if you use profiles
```

Important notes:

- `AWS_REGION` is required for Claude Code on Bedrock
- AWS credentials still need to be available through the normal AWS SDK credential chain, for example `aws configure`, `aws sso login`, environment variables, or a Bedrock API key
- when Bedrock is enabled, Claude authentication is handled by AWS credentials, not Anthropic account login

Model guidance for T3:

- prefer keeping T3 on the built-in Claude model slugs such as `claude-sonnet-4-6` and `claude-opus-4-6`
- if you need Bedrock inference profile IDs or ARNs, prefer Claude Code's `modelOverrides` setting over stuffing those IDs directly into T3 `customModels`
- this keeps T3's built-in Claude model capabilities and picker behavior aligned with known Anthropic model slugs while Claude Code translates them to Bedrock-specific model IDs underneath

Use T3 `customModels` only when you intentionally want extra entries in the T3 model picker, for example:

- dated Claude versions that are not already built into T3
- custom Bedrock-routed variants you want operators to select explicitly

If you use provider-specific Bedrock IDs directly in T3 `customModels`, expect rough edges:

- T3's built-in Claude capability metadata is keyed off known Anthropic slugs
- T3's Claude model mapping may append `[1m]` when the 1M context option is selected
- using raw provider-specific IDs can make model capability detection and context-window behavior less predictable than the `modelOverrides` path

### Section 5: Install Tailscale and choose the bind host

Choose one of these network paths.

#### Option A: AWS-only, no extra service

This is the simplest path if you do not want Tailscale.

1. In the EC2 security group, add inbound TCP `3773` from your IP only.
2. Keep inbound SSH (`22`) restricted to your IP only.
3. Do not open `3773` to the whole internet.
4. Start T3 with `--host 0.0.0.0 --port 3773`.
5. In the desktop client, use the EC2 public IPv4 address if the printed pairing URL points at a private address.
6. If needed, enter the host and token separately instead of relying on the printed URL.

#### Option B: Tailscale private network

Use this only if you want a private mesh network and do not mind adding Tailscale.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
```

Use the printed Tailscale IPv4 as the value for `--host`. Keep port `3773` closed on the public security group when Tailscale is in use.

### Section 6: Start T3 headlessly and pair

Set a persistent `T3CODE_HOME` and start the server in headless mode from `apps/server`.

If you chose the AWS-only path:

```bash
export T3CODE_HOME=/var/lib/t3code
sudo mkdir -p "$T3CODE_HOME"
sudo chown -R "$USER":"$USER" "$T3CODE_HOME"

cd /path/to/ai.code/apps/server
node dist/bin.mjs serve \
  --host 0.0.0.0 \
  --port 3773 \
  /srv/t3-workspaces
```

If you chose Tailscale:

```bash
export T3CODE_HOME=/var/lib/t3code
sudo mkdir -p "$T3CODE_HOME"
sudo chown -R "$USER":"$USER" "$T3CODE_HOME"

cd /path/to/ai.code/apps/server
node dist/bin.mjs serve \
  --host "$(tailscale ip -4)" \
  --port 3773 \
  /srv/t3-workspaces
```

The server prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code

If the printed pairing URL uses a private EC2 address on the AWS-only path, use the desktop client’s manual host + token fields with the EC2 public IPv4 address. After pairing, the client uses a bearer session and websocket token. Do not reuse the pairing token as a long-lived credential.

### Section 7: Move the server under systemd

Once the manual start works, move the same command into a systemd unit so the machine survives disconnects and reboots.

If you chose Tailscale, replace `0.0.0.0` with `$(tailscale ip -4)` in `ExecStart` and keep `3773` closed publicly.

```ini
[Unit]
Description=T3 Code Headless Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ai.code/apps/server
Environment=T3CODE_HOME=/var/lib/t3code
ExecStart=/usr/bin/env bash -lc 'node dist/bin.mjs serve --host 0.0.0.0 --port 3773 /srv/t3-workspaces'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now t3code
sudo systemctl status t3code
journalctl -u t3code -f
```

### Section 8: Day-2 operations

- Use `t3 auth` to revoke pairing links or sessions you no longer trust.
- Keep `T3CODE_HOME` on persistent storage, not on a disposable home directory.
- If you chose Tailscale, re-check the tailnet IP if the instance reboots or Tailscale reconnects.
- If you chose the AWS-only path, keep `3773` restricted to your IP in the EC2 security group and do not widen it.
- Treat pairing URLs and pairing tokens like passwords.

### EC2 operator notes

- If the instance is restarted, re-check the public IP before reusing the launch command.
- If you want to expose T3 publicly, put HTTPS in front of it with a reverse proxy, restrict inbound IPs if possible, and treat pairing URLs as secrets.

If you must expose T3 publicly:

- put HTTPS in front of it with a reverse proxy
- restrict inbound IPs if possible
- treat pairing URLs as secrets
- prefer short-lived pairing and revoke old sessions with `t3 auth`

## DigitalOcean notes

DigitalOcean docs:

- production-ready Droplet setup: [docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/)
- connect with SSH: [docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/)

Recommended Droplet shape for T3:

- Ubuntu Droplet
- SSH keys, not password auth
- cloud firewall attached to the Droplet tag
- inbound SSH only by default
- Tailscale for the actual T3 connectivity path

Suggested DigitalOcean flow:

1. Create the Droplet with SSH keys enabled.
2. Apply a cloud firewall that allows SSH only.
3. SSH in and perform the generic VPS recipe above.
4. Install Tailscale and bind `t3 serve` to the tailnet IP.
5. Leave public port `3773` closed unless you intentionally want public exposure.

## Public internet exposure

Private-network access is preferred. If you need browser/client access over the public internet:

1. terminate TLS at a reverse proxy
2. forward HTTP and websocket traffic to the T3 server
3. use a stable hostname
4. lock the edge down as much as possible

Minimum concerns if you do this:

- HTTPS is mandatory
- the proxy must support websocket upgrade
- pairing URLs should only be shared over a trusted channel
- `t3 auth` should be part of the operator workflow for revoking leaked or stale sessions

### MVP shortcut: one public hostname

If the immediate goal is "I want to open the remote box in a browser at `https://<your-subdomain.example.com>`", the fastest MVP is:

1. point your chosen hostname at the EC2 instance
2. terminate TLS at Caddy
3. proxy all HTTP traffic and websocket upgrades to `127.0.0.1:3773`
4. run `t3 serve --host 127.0.0.1 --port 3773` behind that proxy

That gives you one hostname for:

- the browser UI
- remote pairing/bootstrap
- websocket RPC on `/ws`
- the worker bridge endpoint on `/api/execution/runs`

Tradeoff:

- this is simpler for an MVP, but less locked down than the split topology described in [docs/linear-agent-mvp-setup.md](./linear-agent-mvp-setup.md), where only the execution bridge is public and operator access stays private

Why Caddy is the default recommendation for this shortcut:

- automatic HTTPS with less operator setup than Nginx + Certbot
- websocket proxying works without extra upgrade boilerplate
- the config is tiny and easy to reproduce on a fresh VPS

Recommended EC2 DNS note:

- if this hostname matters beyond a quick experiment, attach an Elastic IP before creating the DNS record so the target IP does not drift

How to allocate and attach an Elastic IP in AWS:

1. open the EC2 console in the same region as the instance
2. go to `Network & Security` -> `Elastic IPs`
3. click `Allocate Elastic IP address`
4. keep the default Amazon pool unless you have a specific requirement
5. click `Allocate`
6. select the new Elastic IP
7. click `Actions` -> `Associate Elastic IP address`
8. choose the EC2 instance
9. choose the primary private IP
10. click `Associate`

After association:

- use the Elastic IP, not the old public IP, for DNS
- verify the instance now shows the Elastic IP in its networking details

How to update the EC2 security group in the AWS Console:

Fastest path from the instance page:

1. open the EC2 console in the correct region
2. click `Instances` in the left sidebar
3. click the target EC2 instance
4. in the lower details panel, open the `Security` tab
5. under `Security groups`, click the attached security group link
6. open the `Inbound rules` tab
7. click `Edit inbound rules`
8. add or confirm these rules:
   - `SSH` on port `22` from `My IP`
   - `HTTP` on port `80` from `Anywhere-IPv4` (`0.0.0.0/0`)
   - `HTTPS` on port `443` from `Anywhere-IPv4` (`0.0.0.0/0`)
9. save the rules

Alternative path if the instance page is awkward:

1. open the EC2 console in the correct region
2. go to `Network & Security` -> `Security Groups`
3. find the group attached to the instance
4. click the security group
5. open `Inbound rules`
6. click `Edit inbound rules`

Do not add:

- public inbound `3773`
- `SSH` from `Anywhere-IPv4`

Common AWS console gotcha:

- if you already have an `SSH` rule for your exact IP, adding another `SSH` rule with source `My IP` will fail because AWS treats it as a duplicate
- in that case, keep the existing `SSH` rule and do not add a second one
- only add the missing `HTTP` (`80`) and `HTTPS` (`443`) rules

Security-group cleanup for the Caddy path:

- if you see a public `Custom TCP` rule for port `3773`, delete it
- the single-hostname Caddy setup should expose only `80` and `443` publicly
- T3 itself should stay bound to `127.0.0.1:3773` behind the reverse proxy

Recommended cutover order for an existing subdomain such as `agent.example.com`:

1. allocate an Elastic IP in the same AWS region as the EC2 instance
2. associate that Elastic IP to the instance
3. confirm the instance security group allows inbound `80` and `443`
4. update the DNS `A` record for the subdomain to the Elastic IP
5. wait until `dig +short <hostname>` returns the Elastic IP
6. install Caddy and point it at `127.0.0.1:3773`
7. let Caddy obtain HTTPS certificates after DNS has propagated

If the DNS zone is hosted in Vercel DNS:

- open the Vercel project or team DNS settings for the domain
- edit the `A` record for the subdomain
- replace the old Vercel target with the new Elastic IP
- save, then verify with `dig +short <your-subdomain.example.com>`

Vercel DNS navigation:

1. open the Vercel dashboard
2. open the team or personal account that owns the domain
3. go to `Domains`
4. click the root domain
5. find the row for the chosen subdomain
6. edit the `A` record so it points to the Elastic IP
7. remove any conflicting old `A` or `CNAME` record for the same hostname
8. save, then verify with `dig`

For a subdomain migration onto EC2:

- remove any old `A` records that still point at the previous target
- create or keep exactly one `A` record for the chosen subdomain pointing to the Elastic IP
- do not use a CNAME at the same time for the same hostname

If the hostname still appears to serve the old app after the `A` record cutover:

- verify `dig +short <your-subdomain.example.com>` returns the Elastic IP
- compare the public response with a forced-IP request
- if `curl --resolve` reaches your EC2 reverse proxy but plain `curl` still serves the previous app, keep debugging the DNS zone before trusting the public hostname

Example forced-IP check:

```bash
curl -i --resolve <your-subdomain.example.com>:443:<your-elastic-ip> \
  https://<your-subdomain.example.com>
```

The expected result for the EC2 + Caddy path is a response that includes `via: 1.1 Caddy`.

For this EC2 + Caddy path, you typically want:

- inbound `22` from your IP only
- inbound `80` from `0.0.0.0/0`
- inbound `443` from `0.0.0.0/0`
- no public inbound `3773` because Caddy terminates public traffic and proxies locally

Minimal Caddyfile:

```caddy
<your-subdomain.example.com> {
  reverse_proxy 127.0.0.1:3773
}
```

If you use the single-hostname shortcut for the Linear MVP, set Convex to call the same host:

```bash
T3_EXECUTION_BRIDGE_BASE_URL="https://<your-subdomain.example.com>"
```

You can harden later by moving the public bridge onto a separate hostname and keeping the full T3 UI on Tailscale or another private path.

Example host-level steps:

```bash
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
<your-subdomain.example.com> {
  reverse_proxy 127.0.0.1:3773
}
EOF

sudo systemctl reload caddy
```

Keep this path for the single-hostname MVP. If you need more custom edge behavior later, moving to Nginx or a managed load balancer is still straightforward.

### Post-DNS bring-up on the host

Once `dig +short <your-subdomain.example.com>` returns the Elastic IP, finish the host setup in this order:

1. create persistent directories for T3 state and workspaces
2. install a `systemd` service that binds T3 to `127.0.0.1:3773`
3. verify the local HTTP listener on `127.0.0.1:3773`
4. install Caddy
5. point the Caddyfile at `127.0.0.1:3773`
6. verify that HTTPS works on the public hostname

Create the persistent directories:

```bash
sudo mkdir -p /var/lib/t3code /srv/t3-workspaces
sudo chown -R "$USER":"$USER" /var/lib/t3code /srv/t3-workspaces
```

Create a small environment file for the service:

```bash
sudo tee /etc/t3code.env >/dev/null <<'EOF'
T3CODE_HOME=/var/lib/t3code
EOF
```

Install the `systemd` service:

```bash
sudo tee /etc/systemd/system/t3code.service >/dev/null <<'EOF'
[Unit]
Description=T3 Code Headless Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/t3code/apps/server
EnvironmentFile=/etc/t3code.env
ExecStart=/usr/bin/env bash -lc 'node dist/bin.mjs serve --host 127.0.0.1 --port 3773 /srv/t3-workspaces'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now t3code
sudo systemctl status t3code --no-pager
```

Verify the local server before touching Caddy:

```bash
curl -I http://127.0.0.1:3773
```

The expected result is `HTTP/1.1 200 OK`.

Install Caddy:

```bash
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update
sudo apt-get install -y caddy
```

Write the Caddyfile:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
<your-subdomain.example.com> {
  reverse_proxy 127.0.0.1:3773
}
EOF

sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Verify public HTTPS:

```bash
curl -I https://<your-subdomain.example.com>
```

The expected result is `HTTP/2 200`.

Operational note:

- the first `t3 serve` startup prints pairing details and a QR code into the service logs
- if you need to inspect that initial output later, use `journalctl -u t3code -n 100 --no-pager`
- you can also create a fresh pairing credential with the auth commands listed below

### If the web UI asks for a one-time token or pairing secret

Generate a fresh pairing credential on the server:

```bash
cd /home/ubuntu/t3code/apps/server
node dist/bin.mjs auth pairing create \
  --base-dir /var/lib/t3code \
  --base-url https://<your-subdomain.example.com>
```

The command prints:

- a client pairing token id
- a short `Token:` value to paste into the UI
- a `Pair URL:` that opens `/pair#token=...` directly
- an expiration timestamp

Important:

- generate pairing credentials against the same `T3CODE_HOME` used by the running `t3code.service`
- if the service uses `EnvironmentFile=/etc/t3code.env` and that file contains `T3CODE_HOME=/var/lib/t3code`, then your auth CLI commands must use `--base-dir /var/lib/t3code` or export the same `T3CODE_HOME` first
- if you mint a token against the wrong base dir, the browser will reject it with `Invalid bootstrap credential.`

You can either:

- paste the short `Token:` value into the browser prompt
- or open the printed `Pair URL:` directly

The token is a one-time bootstrap credential, not a long-lived password.

## Operator commands you will actually use

Create a new pairing credential later:

```bash
cd /path/to/ai.code/apps/server
node dist/bin.mjs auth pairing create \
  --base-dir /var/lib/t3code \
  --base-url https://<your-subdomain.example.com>
```

List active pairing links:

```bash
node dist/bin.mjs auth pairing list --base-dir /var/lib/t3code
```

Revoke a pairing link:

```bash
node dist/bin.mjs auth pairing revoke --base-dir /var/lib/t3code --id <pairing-link-id>
```

Tail logs:

```bash
journalctl -u t3code -f
```

## Recommended default

If you want the simplest, safest MVP deployment:

1. launch Ubuntu on EC2 or DigitalOcean
2. install Bun
3. build `apps/server`
4. install/auth Codex or Claude
5. install Tailscale
6. run `node dist/bin.mjs serve --host "$(tailscale ip -4)" --port 3773 /srv/t3-workspaces`
7. move that command into systemd
8. pair from your desktop client using the printed pairing URL

That gives you a stable remote-hosted T3 Code server with the smallest security footprint and the least divergence from the repo's documented remote model.
