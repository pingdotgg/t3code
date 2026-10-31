# Sandbox environments

A sandbox provider turns an API key into a T3 environment the same way a user would add one by
hand: it creates a machine, starts `t3 serve` on port `3773`, exposes that port on a public HTTPS
origin, and mints a pairing token. The client registers the returned origin and token as an
ordinary bearer environment, so projects, providers, terminals, and reconnects use the existing
remote path. Nothing downstream knows the machine is a sandbox.

## The driver contract

[`SandboxProviderDriver`](../../apps/server/src/sandbox/SandboxProvider.ts) is the whole extension
point: `create`, `execute`, `exposePort`, `destroy`, the optional `stop`/`resume` pair, and the
presentation metadata in `info`.
[`providers/index.ts`](../../apps/server/src/sandbox/providers/index.ts) is the registry. Add one
file and one array entry; settings, RPC, provisioning, and the Add environment UI read the driver's
`info`.

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

Boat and Daytona are two implementations of the same contract; a third provider is one file plus
one registry entry.

1. **Write the driver.** Add `apps/server/src/sandbox/providers/<provider>.ts` exporting a
   `SandboxProviderDriver`. Start from
   [`boat.ts`](../../apps/server/src/sandbox/providers/boat.ts) when the provider returns the public
   URL at create time, or from
   [`daytona.ts`](../../apps/server/src/sandbox/providers/daytona.ts) when it needs a separate
   preview-URL call. Reuse `requestJson`, `jsonBody`, and `authorize` from
   `SandboxProvider.ts` so status handling and error mapping stay consistent.
2. **Fill in `info`.** `kind`, `label`, `detail`, `apiKeyLabel`, `apiKeyPlaceholder`, `docsUrl`,
   and `sizes`. The settings UI, the API-key field, and the machine picker are generated from it;
   nothing else needs to know the provider exists.
3. **Declare the provider kind.** Add it to `SandboxProviderKind` in
   `packages/contracts/src/sandbox.ts`. This is what persists on records and settings, so changing
   it later needs a migration.
4. **Register the driver.** Add the import and the array entry in
   `providers/index.ts`. Scopes, RPCs, and UI need no changes.
5. **Decide the optional capabilities.**
   - `stop`/`resume` only if the provider can stop and start the same machine. The record's hard
     deadline still rules; do not extend the provider's own TTL beyond it.
   - `listEnvironments` only if the provider has named credential environments. Return **flags
     only** (`passGithub`, `passSecrets`, …). Never map `envContents`, `secretFiles`, or any other
     value that carries a real secret into `SandboxCredentialEnvironment`.
6. **Add a size default and the server port.** `defaultSize` must be one of the `info.sizes` ids,
   and `serverPort` is `3773` unless the provider reserves it.
7. **Test it without the network.** Follow `SandboxProvisioner.test.ts`: `HttpClient.make`
   records the request method, URL, and body, and returns canned provider responses. Cover create
   (including the published port and the TTL), execute failure, expose, destroy, and any cleanup
   path the driver owns. `check:changed` runs them.

Two details apply to every provider:

- **The first successful create must be usable.** Publish port `3773` with a public, ungated
  origin, and make sure the provider's own auto-stop or auto-delete is not shorter than T3's
  eight-hour lifetime.
- **The sandbox labels itself.** Provisioning writes `<baseDir>/environment-label` (default
  `~/.t3/environment-label`) before starting the server, so the environment picks up the requested
  name without sudo or a writable `/etc`.

## Lifecycle and hard limits

Every provisioned machine gets a row in `sandbox_records` (see
[`SandboxRecords.ts`](../../apps/server/src/persistence/SandboxRecords.ts)) keyed by the environment
id returned by `/.well-known/t3/environment`. Environments stay the source of truth for connection
details; the record only adds what the provider needs to act on the machine: provider, sandbox id,
size, credential environment, and the deadline.

`ttlMinutes` defaults to 480 and is the sandbox's lifetime, not a window that each resume refreshes:
stopping and resuming can never hand back another eight hours, or the limit would never bind.
`hardDeadlineAt` is fixed at create time, resume refuses a sandbox that is already past it, and the
server sweeps deadlines once a minute and calls the driver's `stop` when one passes. A failed stop
is logged and retried on the next sweep; the record stays so the machine is never forgotten.

`stop` and `resume` are optional on the driver. A provider without them still provisions and
connects; the settings UI hides the controls and the RPC returns a configuration error instead of
inventing a lifecycle the provider does not have.

## Verification

Driver tests use `HttpClient.make` to assert the provider requests and error mapping; the
provisioner test asserts the install/pair sequence, the returned pairing code, and cleanup. A new
driver needs the same coverage for its create, execute, expose, and destroy paths.
