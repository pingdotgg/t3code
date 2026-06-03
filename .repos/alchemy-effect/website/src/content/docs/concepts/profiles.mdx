---
title: Profiles
description: Profiles store cloud credentials per environment in ~/.alchemy/profiles.json — switch between work and personal accounts, or between staging and prod credentials.
sidebar:
  hidden: true
---

A **profile** is a named bundle of cloud credentials stored locally
in `~/.alchemy/profiles.json`. Profiles let you:

- Keep work and personal accounts separate
- Use a different IAM role for `prod` vs `dev`
- Rotate or refresh tokens without losing other configurations

Profiles are independent from [Stages](/concepts/stages). A stage
controls **what** is deployed; a profile controls **how alchemy
authenticates** to deploy it.

## The default profile

Every command uses the profile named **`default`** unless you pass
`--profile <name>` or set `$ALCHEMY_PROFILE`. New users never need
to think about profiles — the first deploy creates `default`
automatically.

```sh
alchemy deploy
# uses profile `default`
```

## How credentials get there

The first time you `alchemy deploy` (or `destroy`, `dev`, `plan`),
alchemy walks each cloud provider registered in your stack and
prompts you to authenticate. Pick OAuth, paste an API token, point
at an SSO profile — whatever the provider offers. The result is
saved under your current profile.

To re-run that flow at any time:

```sh
# Refresh credentials for the current profile
alchemy login

# Re-run the interactive setup (e.g. switch from OAuth → API token)
alchemy login --configure

# Log into a separate profile
alchemy login --profile prod --configure
```

`login` imports your stack file to discover which providers are
needed, so the prompts match the providers you actually use.

## Inspecting a profile

Use `alchemy profile show` to see what's stored (credentials are
redacted):

```sh
alchemy profile show
alchemy profile show --profile prod
```

Sample output:

```text
Profile: default

── AWS ──
  accessKeyId:     ASIA****
  secretAccessKey: Pj5T****
  region:          us-west-2
  source: sso - default

── Cloudflare ──
  accessToken: Xl06****
  expires: in 59m 58s 999ms
  accountId: 123456789...
  source: oauth
```

## Switching profiles

Pass `--profile` to any command, or export `ALCHEMY_PROFILE` in your
shell:

```sh
alchemy deploy --stage prod --profile prod
alchemy destroy --stage pr-42 --profile work

export ALCHEMY_PROFILE=work
alchemy deploy
```

A typical pairing in CI is one profile per environment:

```sh
alchemy deploy --stage staging --profile staging
alchemy deploy --stage prod --profile prod
```

## Where profiles live

Profiles are stored at `~/.alchemy/profiles.json`. The file is plain
JSON keyed by profile name; you can edit it manually, but
`alchemy login --configure` is usually safer because it knows the
shape each provider expects.

For the full set of CLI flags involving profiles see
[`alchemy login`](/guides/cli#login) and
[`alchemy profile show`](/guides/cli#profile) in the CLI reference.
For environment isolation, see [Stages](/concepts/stages).
