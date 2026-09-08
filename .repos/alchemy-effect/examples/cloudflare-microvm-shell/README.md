# cloudflare-microvm-shell

A browser terminal that executes shell commands on an **AWS Lambda MicroVM**,
wired **Cloudflare Worker → Durable Object → MicroVM**, with command output
streamed back to the browser as it is produced.

```
browser terminal ──ws──▶ Worker ──▶ Durable Object ──https /exec──▶ MicroVM
     (SPA)                (routes)     (session state)   (streams)   (runs sh)
```

- **Worker** (`src/worker.ts`) serves the terminal SPA, binds the MicroVM
  control plane (`RunMicrovm` / `GetMicrovm` / `CreateAuthToken`), and on each
  WebSocket upgrade provisions the session's VM and hands its endpoint + auth
  token to the Durable Object.
- **Durable Object** (`src/shell-session.ts`) owns one terminal session: it
  keeps the VM coordinates in storage (so the VM is reused across commands, not
  re-booted), POSTs each command to the VM's streaming `/exec` route, and
  forwards stdout/stderr to the browser chunk-by-chunk.
- **MicroVM** (`src/shell-image.ts`) is an **effectful image**: the module is
  both the image declaration and the in-VM server. The bundled Effect program
  spawns `sh -c <command>` (scoped `ChildProcessSpawner`) and streams its
  interleaved stdout/stderr, ending with an `__EXIT__:<code>` trailer.

## Run it in dev

```sh
bun alchemy dev
```

Open the printed `http://localhost:…` URL, type a command (`echo hello`,
`uname -a`, `ls -la /`) and press enter. Under `alchemy dev` the Worker and
Durable Object run in local workerd while the MicroVM runs on the Floci
emulator — the cross-cloud STS assume-role and the VM's TLS data plane are
wired automatically (the emulator CA is trusted via `NODE_EXTRA_CA_CERTS`).

To exit the first-apply smoke check without keeping the session alive:

```sh
ALCHEMY_DEV_ONCE=1 bun alchemy dev
```

## Deploy it live

```sh
bun alchemy deploy
```

A live deploy requires the **AWS Lambda MicroVM preview entitlement** on the
account (the control-plane APIs are gated). Everything else — the Worker, the
Durable Object, the cross-cloud IAM User + assume-role Role — is standard.
