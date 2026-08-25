# Oh My Pi

Oh My Pi (OMP) is an agent runtime that supports multiple model providers through one CLI. T3
Code includes OMP as a built-in provider, but it is off by default.

## Install OMP

T3 Code requires OMP 18.0.5 or newer on the machine that runs the T3 Code server. Install the
published package and verify the binary before enabling the provider:

```bash
npm install --global @oh-my-pi/pi-coding-agent@18.0.5
omp --version
omp setup
```

Homebrew users can install `can1357/tap/omp`; upgrade it until `omp --version` reports 18.0.5 or
newer.

## Enable OMP in T3 Code

Open **Settings**, add or enable an **Oh My Pi** provider, then choose a discovered model. The
default binary path is `omp`. Add separate provider instances when different projects need isolated
OMP profiles, credentials, or model catalogs.

**Launch arguments** are appended after `omp acp`. Profiles and config overlays are supported, for
example `--profile work` or `--config ~/.omp/work.yml`. T3 Code removes approval flags from this
field because the selected T3 permission mode is authoritative.

Health checks run `omp models --json --no-extensions`. They preserve profile/config overlays but do
not load extensions, skills, or rules. Add an extension-only model's complete `provider/id` selector
under **Custom models**. Model rows identify their upstream provider and expose the thinking options
reported by OMP.

OMP sessions support new and resumed threads, streaming assistant text, tool events, token usage,
images, permission requests, required form input, interruption, and model/thinking changes. T3 Code
uses an isolated, tool-free OMP session for commit messages, branch names, pull request copy, and
thread titles.

## Permission behavior

T3 Code maps its permission modes to OMP approval modes:

- **Supervised** and **Auto** use OMP's `always-ask` mode.
- **Auto-accept edits** uses OMP's `write` mode.
- **Full access** uses OMP's `yolo` mode.

OMP 18.0.5 can show a second approval form for a supervised shell command or destructive edit. T3
Code presents OMP's advertised choices and required form fields; optional unanswered fields are
omitted.

## Current limitations

OMP does not expose the provider-history controls T3 Code needs for checkpoint rollback. T3 Code
also hides its Plan toggle and built-in `/plan` command for OMP; every client and the server normalize
stale Plan state to the implementation/default OMP mode. Follow-up messages wait for the active OMP
turn to finish, then start a new turn.
