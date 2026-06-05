# Orchestrator

T3 Code can accept work from external systems such as Slack, Resend inbound
email, and GitHub webhooks. This document explains the server-native
orchestrator path: what runs, what gets stored, how projects are selected, and
which environment variables configure it.

The implementation lives in `apps/server/src/externalIntake`. There is no
separate orchestrator service; the same `apps/server` process owns the intake
routes, local repos, worktrees, and provider sessions.

## Mental Model

```text
Slack, Resend, GitHub
        |
        v
https://<your-public-t3-url>
        |
public tunnel or reverse proxy
        |
apps/server
        |
SQLite state + local projects + worktrees + provider sessions
```

External platforms call the same T3 server that owns the local repos,
worktrees, provider sessions, and web UI. There is no separate Convex service
required.

The public routes are:

```text
GET  /api/external-intake/health
POST /slack/webhook
POST /support-email/resend
POST /github/webhook
```

The health route returns the concrete webhook URLs derived from
`T3_WEB_APP_BASE_URL` or `T3CODE_PUBLIC_BASE_URL`.

## What Gets Stored

The server stores orchestration state in its local SQLite database alongside the
rest of T3 state:

- external thread links, for example Slack thread to T3 thread
- event receipts, so duplicate Slack/email/webhook deliveries are ignored
- delivery receipts, so assistant replies are not posted twice
- Chat SDK state for Slack subscriptions and dedupe
- pull request links discovered from agent messages

This state is local to the T3 server. Repos stay wherever `workspaceRoot` points,
usually under `~/code/<repo>` in WSL/Linux.

## Project Profiles

External intake uses project profiles to map an outside request to a local repo.
Profiles are configured with `T3_INTAKE_PROFILES_JSON`.

Example:

```bash
T3_INTAKE_DEFAULT_PROFILE_ID=nextcard
T3_INTAKE_PROFILES_JSON='[
  {
    "id": "nextcard",
    "title": "Nextcard",
    "workspaceRoot": "~/code/nextcard",
    "aliases": ["nextcard", "next card", "nc"],
    "primary": true,
    "defaultBaseRef": "dev",
    "setupScript": {
      "id": "nextcard-worktree-setup",
      "name": "Nextcard worktree setup",
      "command": "scripts/worktree-setup.sh",
      "icon": "configure"
    },
    "supportEmail": {
      "to": ["support@nextcard.com"],
      "productName": "nextcard",
      "slackChannelId": "C0123456789"
    }
  }
]'
```

Profile fields:

- `id`: stable machine-readable profile id
- `title`: human-readable project name
- `workspaceRoot`: path to the local repo; `~` is expanded on the server
- `aliases`: words users can mention in Slack to select this project
- `primary`: optional boolean fallback when no explicit default id is set
- `defaultBaseRef`: branch/ref used when creating worktrees, for example `dev`
- `setupScript`: optional script to add to the T3 project and run on worktree create
- `supportEmail`: optional support-email routing and prompt context

Only one profile can set `primary: true`.

## Project Resolution

When a request arrives, T3 chooses a project in this order:

1. A profile already selected by the source-specific route wins. Support email
   does this after matching the email recipients.
2. A profile alias mentioned in the Slack/email text wins.
3. An existing T3 project name, repo name, or remote name mentioned in the text
   wins.
4. `T3_INTAKE_DEFAULT_PROFILE_ID` wins when it matches a configured profile.
5. A single profile with `primary: true` wins.
6. If exactly one T3 project exists, that project is used.
7. Otherwise the server replies with a project resolution error.

Use `T3_INTAKE_DEFAULT_PROFILE_ID` for predictable production behavior. Use
`primary: true` when you want the default to live beside the profile itself.

## Slack Intake

Slack uses the Chat SDK Slack adapter. Configure Slack Event Subscriptions and
Interactivity to point at:

```text
https://<your-public-t3-url>/slack/webhook
```

Required env vars:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Useful optional env vars:

```bash
SLACK_BOT_USER_ID=U...
SLACK_BOT_USERNAME=vevin
SLACK_WORKSPACE_URL=https://your-workspace.slack.com
```

Behavior:

- New Slack tasks start when the bot is mentioned.
- Replies in linked Slack threads continue the existing T3 thread.
- `mute`, `aside`, and related mute commands stop assistant relays for that
  Slack thread until unmuted.
- The original request receives an eyes reaction when a task starts.
- The task-started reply is posted as a Slack card with an Open T3 button.
- Assistant messages are relayed back into the Slack thread unless the link is
  muted.
- If project routing fails, the server replies in the Slack thread with the
  reason instead of silently logging the failure.

Slack image attachments are downloaded through the Chat SDK attachment handle
when available, then through Slack file APIs with `SLACK_BOT_TOKEN` as a
fallback.

## Support Email Intake

Resend inbound email should call:

```text
https://<your-public-t3-url>/support-email/resend
```

The support-email route matches a profile when the email recipient intersects
with `supportEmail.to`. If no profile has a matching `supportEmail.to`, the
legacy env var `SUPPORT_EMAIL_TO` can be used.

Support email profile fields:

- `to`: recipient addresses this profile handles
- `productName`: product name used in prompt context
- `groupAddress`: public support address, used for conversation identity
- `slackChannelId`: channel where new support emails are posted
- `triagePrompt`: optional custom bug-vs-non-bug triage prompt
- `agentPrompt`: optional custom instructions added to the agent prompt

Legacy support-email env vars are still supported for compatibility:

```bash
SUPPORT_EMAIL_PROJECT_WORKSPACE_ROOT=~/code/nextcard
SUPPORT_EMAIL_REPO_NAME=nextcard
SUPPORT_EMAIL_PROFILE_ID=nextcard
SUPPORT_EMAIL_PROJECT_ALIASES=nextcard,next card,nc
SUPPORT_EMAIL_DEFAULT_BASE_REF=dev
SUPPORT_EMAIL_SETUP_COMMAND=scripts/worktree-setup.sh
SUPPORT_EMAIL_TO=support@nextcard.com
SUPPORT_EMAIL_PRODUCT_NAME=nextcard
SUPPORT_EMAIL_GROUP_ADDRESS=support@nextcard.com
SUPPORT_EMAIL_SLACK_CHANNEL_ID=C0123456789
SUPPORT_EMAIL_TRIAGE_PROMPT='...'
SUPPORT_EMAIL_AGENT_PROMPT='...'
```

New setups should prefer `T3_INTAKE_PROFILES_JSON` so one config block describes
the project, Slack behavior, and support-email behavior together.

Support email behavior:

- The email is normalized into a support-email external thread.
- Matching prior message ids and conversation ids reuse the same T3 thread.
- Attachments are downloaded into T3 state storage and image attachments are
  forwarded to the agent when small enough.
- If `slackChannelId` is configured, the email is posted to Slack as a card with
  an Open T3 button.
- Slack previews truncate quoted email chains so long back-and-forth threads do
  not flood the channel.
- The agent prompt contains the full relevant email body, headers, local
  attachment paths, and support context.

## GitHub Webhook

GitHub repository webhooks should call:

```text
https://<your-public-t3-url>/github/webhook
```

The server watches merged pull request events. When it can match the PR URL to a
T3 thread that was created from Slack, it reacts to the original Slack request
and posts a merged-PR card in the Slack thread.

Required for verification:

```bash
GITHUB_WEBHOOK_SECRET=...
```

## Core Env Vars

```bash
T3_WEB_APP_BASE_URL=https://t3.example.com
T3CODE_PUBLIC_BASE_URL=https://t3.example.com
T3_INTAKE_PROFILES_JSON='[...]'
T3_INTAKE_DEFAULT_PROFILE_ID=nextcard
T3_INTAKE_DEFAULT_BASE_REF=main
T3_DEFAULT_PROVIDER_INSTANCE_ID=codex-default
T3_DEFAULT_MODEL=gpt-5-codex
```

Notes:

- `T3_WEB_APP_BASE_URL` is preferred for public links. `T3CODE_PUBLIC_BASE_URL`
  is a compatibility fallback.
- `T3_INTAKE_DEFAULT_BASE_REF` applies when the matched profile does not set
  `defaultBaseRef`.
- `T3_DEFAULT_PROVIDER_INSTANCE_ID` and `T3_DEFAULT_MODEL` apply when the
  profile and existing project do not specify a model.

## Local Operation

For a production-like local server, run `apps/server` behind a public tunnel or
reverse proxy and keep it alive with your operating system's service manager.

Common checks:

```bash
curl -sS http://127.0.0.1:3773/api/external-intake/health
curl -sS https://<your-public-t3-url>/api/external-intake/health
```

For WSL/systemd setups:

```bash
systemctl --user status t3code-server.service --no-pager
journalctl --user -u t3code-server.service -n 150 --no-pager
```

If the health route says Slack is not configured, fix the missing Slack env vars
before testing Slack messages. If Slack receives a message but no T3 task starts,
check the thread reply and then the server logs for the project resolution or
provider startup error.
