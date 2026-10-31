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
- **Cleanup.** `SandboxProvisioner` destroys the machine when any step after `create` fails, so a
  provisioned machine never bills without an environment pointing at it. Drivers must make
  `destroy` safe on a machine that never started.

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
