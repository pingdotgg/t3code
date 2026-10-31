# Sandbox environments

A sandbox provider turns an API key into a T3 environment the same way a user would add one by
hand: it creates a machine, starts `t3 serve` on port `3773`, exposes that port on a public HTTPS
origin, and mints a pairing token. The client registers the returned origin and token as an
ordinary bearer environment, so projects, providers, terminals, and reconnects use the existing
remote path. Nothing downstream knows the machine is a sandbox.

## The driver contract

[`SandboxProviderDriver`](../../apps/server/src/sandbox/SandboxProvider.ts) is the whole extension
point: `create`, `execute`, `exposePort`, and `destroy`, plus the presentation metadata in `info`.
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

## Verification

Driver tests use `HttpClient.make` to assert the provider requests and error mapping; the
provisioner test asserts the install/pair sequence, the returned pairing code, and cleanup. A new
driver needs the same coverage for its create, execute, expose, and destroy paths.
