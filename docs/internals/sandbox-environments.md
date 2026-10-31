# Sandbox environments

A sandbox provider turns an API key into a T3 environment the same way a user would add one by
hand: it creates a machine, starts `t3 serve` on port `3773`, exposes that port on a public HTTPS
origin, and mints a pairing token. The client registers the returned origin and token as an
ordinary bearer environment, so projects, providers, terminals, and reconnects use the existing
remote path. Nothing downstream knows the machine is a sandbox.

## The driver contract

[`SandboxProviderDriver`](../../apps/server/src/sandbox/SandboxProvider.ts) is the whole extension
point: `create`, `execute`, `exposePort`, `destroy`, the optional `stop`/`resume` pair, `limits`,
`listEnvironments`, `status`, `usage`, and templates, and the presentation metadata in `info`. Clients learn which optional
methods exist from the `capabilities` the provisioner derives; they never branch on provider kind.
[`providers/index.ts`](../../apps/server/src/sandbox/providers/index.ts) is the registry; settings,
RPC, provisioning, and the Add environment UI read the driver's `info`.

Drivers must keep two invariants:

- **Reachability.** The exposed origin must serve the T3 server without a provider-specific header
  or cookie, because the browser client only knows how to send T3's bearer credential. Providers
  that gate URLs with their own token use the provider's public or ungated mode.
- **Cleanup.** `SandboxProvisioner` destroys the machine when any step after `create` fails or is
  interrupted (including exposing the port), so a provisioned machine never bills without an
  environment pointing at it. Drivers must make `destroy` safe on a machine that never started,
  and a driver that creates a machine before its own start polling must clean up that path itself,
  because the provisioner never receives the id.

## Adding a provider

Boat, Daytona, and Vercel implement the same contract. A new provider is a driver file, a registry
entry, its kind in contracts, and its logo; nothing else branches on the provider.

1. **Write the driver.** Add `apps/server/src/sandbox/providers/<provider>.ts` exporting a
   `SandboxProviderDriver`. Start from
   [`boat.ts`](../../apps/server/src/sandbox/providers/boat.ts) when the provider returns the public
   URL at create time, or from
   [`daytona.ts`](../../apps/server/src/sandbox/providers/daytona.ts) when it needs a separate
   preview-URL call, or from [`vercel.ts`](../../apps/server/src/sandbox/providers/vercel.ts) when
   it names sandboxes and runs them in sessions. Reuse `requestJson` (or `requestText` for bodies
   that are not one JSON document, such as an ND-JSON command stream), `jsonBody`, and `authorize`
   from `SandboxProvider.ts` so status handling and error mapping stay consistent. `requestJson` turns
   provider error bodies into a stable `code` (rate limited, concurrency full, billing required,
   size unavailable, …) with a bounded message; add the provider's own error codes to its table
   instead of writing messages in the driver, because clients react to `code`.
2. **Fill in `info`.** `kind`, `label`, `detail`, `apiKeyLabel`, `apiKeyPlaceholder`, `docsUrl`,
   and `sizes`. The settings UI, the API-key field, and the machine picker are generated from it.
   An account setting the provider needs besides the key (Vercel's team and project) is a
   `settingsFields` entry: the form shows it under the key, the server saves it next to the key,
   and the driver reads it from `config.settings`. These values are not secret and are sent to
   clients, so a credential never goes in one. When an optional one is empty, the driver picks a
   default or fails at the `config` stage with a short message naming the values that would work.
   Each record keeps the settings its sandbox was created with, plus any `settings` that `create`
   returns for defaults it resolved, and every later call for that sandbox uses them, so a
   setting that decides where a sandbox lives must be returned once resolved.
3. **Declare the provider kind and its mark.** Add it to `SandboxProviderKind` in
   `packages/contracts/src/sandbox.ts`. This is what persists on records and settings, so changing
   it later needs a migration. Add the brand mark to `SandboxProviderLogo.tsx`.
4. **Register the driver.** Add the import and the array entry in
   `providers/index.ts`. Scopes, RPCs, settings, and the rest of the UI need no changes.
5. **Decide the optional capabilities.**
   - `stop`/`resume` only if the provider can stop and start the same machine. The record's hard
     deadline still rules: a provider TTL that stops ends at the deadline, and one that deletes ends
     after it (see [Lifecycle and hard limits](#lifecycle-and-hard-limits)).
   - `listEnvironments` only if the provider has named credential environments. Return **flags
     only** (`passGithub`, `passSecrets`, …). Never map `envContents`, `secretFiles`, or any other
     value that carries a real secret into `SandboxCredentialEnvironment`.
   - `limits` only if the provider reports quotas; with no quota API, omit it rather than guess.
     Return `null` when the account's limits can't be read (a key without that scope, for
     example), never an error. The provisioner runs `assessSandboxStart` before every create and
     resume, and it blocks only on what the provider says it would refuse; unknown or failed
     limits let the start through so the provider decides. A plan maximum for auto-stop
     (`maxTtlMinutes`) clamps the lifetime T3 records, so it is never a per-session cap: a
     provider that caps sessions clamps its own timeout in the driver and lets the session stop.
   - `status` lets the sweep notice a machine stopped, expired, or deleted outside T3. A machine
     the provider no longer has is `deleted`, not an error, and a provider state T3 does not track
     returns `null` so the record is left alone.
   - `usage` only if one request can return every T3 sandbox's cost; the sweep calls it once per
     provider, never once per machine. Tag sandboxes at create so the provider can filter them.
   - `saveTemplate`/`listTemplates`/`deleteTemplate` (with `stop`, and `create`'s `template`) only
     if the provider can snapshot a stopped machine and start new ones from it. A snapshot copies
     `~/.t3/userdata`: the environment id, auth sessions, and secrets. The provisioner's scrub
     removes them before the driver saves, and create refuses any machine that answers with an id
     a record already has, so a copy never inherits its source's identity or valid bearer tokens.
     Because the source loses its identity too, a successful save deletes it, so the template
     must not depend on the source's disk. List only templates T3 saved, never the provider's base
     images. A provider whose snapshots carry no name can keep a template as a stopped, tagged
     machine and start new ones as forks of it, as Vercel does.
6. **Add a size default and the server port.** `defaultSize` must be one of the `info.sizes` ids,
   and `serverPort` is `3773` unless the provider reserves it.
7. **Test it without the network.** Follow `SandboxProvisioner.test.ts`: `HttpClient.make`
   records the request method, URL, and body, and returns canned provider responses. Cover create
   (including the published port and the TTL), execute failure, expose, destroy, and any cleanup
   path the driver owns. `check:changed` runs them.

Three details apply to every provider:

- **The first successful create must be usable.** Publish port `3773` with a public, ungated
  origin, and make sure the provider's own auto-stop or auto-delete is not shorter than T3's
  eight-hour lifetime. Where the plan caps it lower, `info.detail` says so.
- **The sandbox id survives a resume.** Record the id that stays the same across stop and resume.
  Vercel starts a new session on every resume, so its driver records the sandbox name and reads
  the current session before each command, stop, or extend, caching nothing between calls.
- **The sandbox labels itself.** Provisioning writes `<baseDir>/environment-label` (default
  `~/.t3/environment-label`) before starting the server, so the environment picks up the requested
  name without sudo or a writable `/etc`.

## Lifecycle and hard limits

Every provisioned machine gets a row in `sandbox_records` (see
[`SandboxRecords.ts`](../../apps/server/src/persistence/SandboxRecords.ts)) keyed by the environment
id returned by `/.well-known/t3/environment`. Environments stay the source of truth for connection
details; the record only adds what the provider needs to act on the machine: provider, sandbox id,
size, credential environment, and the deadline.

`ttlMinutes` defaults to 480 and is the sandbox's lifetime, counted from creation, not a window
that each resume refreshes: stopping and resuming never hand time back, or the limit would never
bind. `hardDeadlineAt` is createdAt plus `ttlMinutes`. The only way to move it is Extend, which adds
to both and is capped by the server's lifetime limit (`sandboxLifetimeCapMinutes`, 24 hours by
default), so a sandbox still cannot run forever. Extend and resume refuse a sandbox already past its
deadline, and the server sweeps records once a minute and calls the driver's `stop` when a deadline
passes. A failed stop is logged and retried on the next sweep.

The provider's own TTL is only a backstop for when T3 is offline at the deadline, and it must never
destroy what T3's stop would keep; a driver with `extend` moves it whenever the deadline moves.
Boat's backstop is an auto-stop counted from create or resume, so extending a running Boat sandbox
resets it to the time left, a stopped one gets it on resume, and a plan with a lower auto-stop
maximum (trial: two hours) stops the machine early without moving T3's deadline. Daytona's TTL
deletes the sandbox, disk included, even when stopped, so it is always set 24 hours past the
deadline: a stopped Daytona sandbox keeps its disk for a day and is then gone. Vercel's is the
session timeout, set on create and resume and moved with `extend-timeout`, but the plan caps one
session (45 minutes on Hobby, a day on Pro), so a Hobby sandbox stops early and the sweep records
it as stopped until the user resumes it. Its stopped disk is kept for 30 days.

The same sweep makes the record match the provider, because T3 usually runs where webhooks can't
reach it. Each record gets at most one provider call per sweep, with a few in flight at a time. An
unreachable provider changes nothing: the record keeps its state rather than turning into an error,
and an `error` record stays one while the provider reports the machine running, since that state
means T3 is not answering on it. The sweep writes only when the record has not changed since it was
read, so a user's stop or resume during a slow provider call wins. `expired` and `deleted` records
stay listed until the user deletes them; deleting a `deleted` record skips the provider.

`stop` and `resume` are optional on the driver. A provider without them still provisions and
connects; the settings UI hides the controls and the RPC returns a configuration error instead of
inventing a lifecycle the provider does not have.

## Verification

Driver tests use `HttpClient.make` to assert the provider requests and error mapping; the
provisioner test asserts the install/pair sequence, the returned pairing code, and cleanup. A new
driver needs the same coverage for its create, execute, expose, and destroy paths.
