# Voice Testing Runbook

> For the operator running voice acceptance (the integrated browser pass and the second
> installation). This page contains development commands and fixture recipes that normal voice
> users never need; day-to-day setup is in [Voice](voice.md). Execution is performed by the
> operator, not automated.

Two passes are described here:

1. **Primary-install browser pass** — the single integrated verification of the fixed request set
   on the primary installation.
2. **Second installation (`oracle-live-secondary`)** — an isolated T3 installation that makes
   pairing, remote-mode, and portability evidence real.

Rules that apply to both: never run a server against the real `~/.t3/userdata`; state for a
worktree dev server defaults to that worktree's `.t3` directory, and an explicit `--home-dir` wins
over everything; stop any server you started by the PID you captured at spawn; never set
`VITE_HTTP_URL` or `VITE_WS_URL`.

## Part 1: Primary-install browser pass

### 1. Seed isolated state

From the integration worktree (state lives in `<worktree>/.t3/userdata`):

```bash
mkdir -p .t3/userdata
rm -f .t3/userdata/state.sqlite*
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
```

This snapshots the developer's real database read-only into the worktree. Copy in `secrets/` and
`settings.json` only if the flow under test needs them. Copy in, never symlink.

### 2. Seed the fixture data

In the worktree copy (via the running server's normal project-creation flow, or direct database
insert before server start), create:

- A project with a thread titled approximately **"Macroscope and CodeRabbit trials planning"**
  whose message content contains the distinctive terms "Macroscope", "CodeRabbit", and "trials"
  (for requests 1 and 3).
- Two threads with **near-identical onboarding titles** in that project (for request 2).
- One **archived** thread with a known title fragment (for request 9).
- A second project as a local stand-in remote-ish target (for request 5; real remote evidence
  additionally needs Part 2).

### 3. Start the dev server

```bash
vp run dev
```

No `VITE_HTTP_URL`/`VITE_WS_URL` overrides. Read the real ports from the `[dev-runner]` output
line; capture the PID and stop by that PID only.

### 4. Pair the browser

Open the printed `pairingUrl:` (full URL, token included). If the token was consumed, mint a fresh
one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup
URL carries admin scopes (needed for Settings → Connections management).

### 5. Provision voice

- Place an OpenAI API key with Live session, Responses, and model-catalog permissions as
  `<worktree>/.t3/userdata/secrets/openai-api-key.bin` (plain text, mode 600). The voice entry
  point appears without a restart once the file exists.
- Optionally place `voice-broker-config.bin` next to it with JSON overrides
  (`liveModel`, `backendModel`, `instructions`, `delegationInstructions`). Without a Live-capable
  key, the panel renders nothing and the spoken legs of requests 1–8 are recorded as
  `live_access_unavailable`, never simulated.

### 6. Run the fixed request set

Run requests 1–13 from `campaign/ACCEPTANCE-SET.md` in order, in one browser pass, observing what
the evidence table requires. Points easy to miss:

- Request 8: interrupt the speech mid-research; the research must not be cancelled and the
  corrected navigation must happen exactly once.
- Request 10: with a read-only session, the voice panel must be **absent**, not merely disabled.
- Request 11: revoke the session (`t3 auth session revoke <id>`), then make any request; expect an
  authentication error and no retry loop.
- Request 13: replay request 6 with identical wording; exactly one thread may exist.

### 7. Capture evidence

Per request: the outcome, the read-back facts (environment, project, model, session status), and
the timing-mark records from the mark bus. Timing medians/p95 are computed **only** from these
recorded inputs per the measurement plan in `campaign/EVIDENCE.md` Part B; `utterance_end` is
authoritative only from the annotated recorded-input endpoint, and no timing or usage numbers exist
until this pass produces them.

## Part 2: Second installation (`oracle-live-secondary`)

### 1. Create the isolated installation

In a scratch worktree (never the primary, never live userdata):

```bash
mkdir -p .t3/userdata
rm -f .t3/userdata/state.sqlite*
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
```

(Equivalently, start the server with an explicit `--home-dir` pointing at a fresh directory. A
worktree's `.t3` deliberately outranks an ambient `T3CODE_HOME`.)

### 2. Seed the fixture projects and threads

Under a scratch workspace root, create concretely:

- Project A with one thread titled approximately "Macroscope and CodeRabbit trials planning", its
  messages containing the terms "Macroscope", "CodeRabbit", "trials".
- Project A with two threads sharing near-identical onboarding titles.
- Project A with at least one archived thread (title fragment known).
- Project B ("Oracle") with a recent thread for catch-up requests.

### 3. Start the isolated server

```bash
vp run dev
```

Read the real ports from the `[dev-runner]` line; PID captured at spawn, stopped by that PID only.

### 4. Create the two credentials

- **Operate session:** a standard pairing credential from the secondary's startup output, or mint
  one (`node apps/server/src/bin.ts pair`).
- **Read-only session:** exchange the pairing credential at the secondary's token endpoint with
  only the read scope:

  ```bash
  curl -X POST http://127.0.0.1:<port>/oauth/token \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
    --data-urlencode 'subject_token=<pairing credential>' \
    --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
    --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
    --data-urlencode 'scope=orchestration:read'
  ```

  The response's `access_token` is the read-only session token (the grant-scope subset rule is
  enforced server-side; requesting more than the grant holds is refused).

### 5. Pair the secondary into the primary client (required for remote-mode evidence)

Open the secondary's full pairing URL (token included) in the primary client. This registers the
secondary as a remote environment in the primary client's connection catalog as a
`BearerConnectionTarget`, so it appears in the environment list with its own prepared connection.
Without this step, request 5's remote evidence is not real.

### 6. Run the remote rows

On the primary installation with the secondary paired: request 5 (remote find/open — the thread
must open in the current UI with the secondary's environment selected), request 6 against the
secondary (cross-environment creation with an explicit model from the secondary's own catalog),
and request 10 using the read-only session (panel absent, start refused with insufficient scope).

### 7. Capture evidence

Record: pairing succeeded and the secondary appears connected; the remote route
`/_chat/<environmentId>/<threadId>` was observed for request 5; created-thread read-back shows the
secondary's environment and the requested model; the read-only observations for request 10. All of
it is second-installation (portability) evidence for the acceptance ledger.

## After both passes

Update `campaign/EVIDENCE.md` and `campaign/ACCEPTANCE-LEDGER.md` with what was observed, keeping
the three evidence classes (boundary-verified, real-system, unverified) intact: a row becomes
class 2 only when it was actually observed on a real running system.
