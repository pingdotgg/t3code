# dev-stress

A cross-cloud `alchemy dev` stack that exists to be **rewritten while it is
running**.

Every other dev example asserts that a stack converges.
[`test/dev-stress.test.ts`](./test/dev-stress.test.ts) asserts that the dev
server *survives*: it launches the real `alchemy dev` CLI as a child process
against a throwaway copy of this project, then edits, breaks, moves and
churns the project's files and checks — over HTTP, against pinned ports —
that the server never dies and never serves stale code.

## Topology

```
AWS (floci emulator)              Cloudflare (workerd + docker)
────────────────────              ─────────────────────────────
Lambda ApiFunction    ◀────────── Worker ApiWorker    (path `main`)
  ├ S3 StressBucket    cross-     Worker EchoWorker   (Effect-native `main`)
  ├ DynamoDB Table     cloud        ├ KV + R2 + Durable Object
  └ SQS + consumer      hop         └ Container SandboxContainer
Lambda MicroVM        ◀────────── Worker MicrovmWorker
  StressMicrovm        mounts       (IAM User + AccessKey + assume-role,
  (image + instances)                minted by Alchemy for the Worker)
ECS Cluster + 2 Services
  EcsService (context build)
  EcsInlineService (inline Dockerfile)
EC2 Instance (hosted program)
  StressEc2Box + VPC network
  (i-….localhost.floci.io:8798)
Website.StaticSite                Website.StaticSite (build mode)
  (dev-command child)
```

`MicrovmWorker` is the headline: a Cloudflare Worker that **mounts an AWS
Lambda MicroVM**. A Worker has no AWS execution role, so binding the MicroVM
instance operations makes Alchemy mint an IAM User + AccessKey + assume-role
Role for it and assume that role at runtime. `GET /roundtrip` boots a VM,
waits for it to run, mints a data-plane auth token, drives both protocols the
VM speaks (typed RPC and a raw HTTPS route), and terminates it again.

The cross-cloud hop is real: local `workerd` fetches the Lambda's function
URL, which under `alchemy dev` is served by the floci emulator behind a
self-signed certificate. It only resolves because `alchemy dev` puts the
emulator's CA on `NODE_EXTRA_CA_CERTS` for every process it spawns.

## The two reload paths

The suite tells them apart by counting `Plan:` renders in the CLI's output
(`DevServer.planCount`), which is exactly the number of exec-child restarts:

| Edit                                              | Path                                            | `planCount` |
| ------------------------------------------------- | ----------------------------------------------- | ----------- |
| a file the **stack** imports (`src/echo/marker.ts`) | `bun --watch` re-runs the stack → replan → apply | goes up     |
| a file only the **bundler** sees (`src/api/marker.ts`) | the Worker provider's watch loop hot-swaps the script | stays flat  |

`src/api-worker.ts` is referenced by path and never imported by
`alchemy.run.ts`, which is what puts it on the bundler-only path.

## What the suite covers

**Convergence and reload**

1. **Boot** — every local resource serves; the cross-cloud hop works; AWS
   identities are the emulator's, not real AWS.
2. **The MicroVM** — a Worker boots a VM, drives typed RPC *and* a raw HTTPS
   route against it, and terminates it.
3. **Hot reload, both paths** — plus proof that a user-code restart does
   *not* bounce sidecar-hosted children (`Command.Dev`'s pid is unchanged).
4. **Moved modules** — the importer points at a path that does not exist
   yet; the file arrives; the new path is watched too.

**Broken states — the dev server logs and waits, never exits**

5. A syntax error in a stack-imported module, a module-scope `throw`, and a
   resource that cannot reconcile (a `strictPort` collision). In all three
   the CLI survives, unrelated resources keep serving, and the next save
   recovers.

**Resource-graph churn — the substance of the suite**

6. **A Cloudflare Worker** added, renamed onto a new port (a create + a
   delete), and removed.
7. **A whole AWS Lambda** — new module, new import, new `Function`, new S3
   `Bucket`, two new bindings — added, hot-swapped, and removed.
8. **A Queue + its consumer event source + a new Durable Object class**
   grafted onto a Worker that is already serving (a class migration on a
   live script), driven produce→consume, then removed again.
9. **A second S3 bucket and its bindings** added to the running Lambda and
   removed, observed through the cross-cloud hop.
10. **ECS hot reload, four ways a docker build changes** — a context file,
    the Dockerfile itself, an env *prop* (no file event — the engine path),
    and an inline-Dockerfile *prop*. All four must roll the running
    containers.
11. **EC2 hot reload** — the hosted instance runs as a real container in
    the emulator, serves its bundled program through floci's host-routing
    mux, and a content edit updates it IN PLACE through the engine
    (re-plan → bundle re-upload → reboot): same instance id, same address,
    new code.
12. **Cloudflare Container hot reload** — editing the container's program
    rebuilds the image and restarts the running container; and the
    container reaches a service on the HOST through an env var written as
    `http://localhost:…` (the dev runtime rewrites loopback hosts to
    `host.docker.localhost` — the #1334 database shape).
13. **A replacement** — DynamoDB's partition key is immutable, so changing
    it swaps the table under the running Lambda; then swaps it back.
14. **A second MicroVM image** built, bound to the running Worker, booted,
    and removed — while the first image keeps working.
15. **The entire AWS Lambda subsystem** deleted in one edit (Function,
    bucket, table, queue, event source, and the cross-cloud binding that
    named it) while Cloudflare keeps serving — then restored.
16. **Binding churn** — a changed binding value, a binding that appears and
    disappears, and a `Command.Dev` config change that must restart the
    child (new pid).

**Load and final state**

17. **Rapid fire** — 25 bundler-path saves and 15 stack-path saves in
    bursts, asserting convergence on the last write and that the watchers
    coalesce (measured: 15 saves in ~1s produce a single re-apply).
18. **Simultaneous cross-cloud edits**, then a full health re-probe and a
    clean Ctrl-C shutdown.

Nothing is skipped: Docker is a hard requirement, and a machine without it
fails the suite rather than quietly passing it.

## What it has found

Bugs the suite surfaced on its first runs, each now fixed and pinned by a
focused regression test closer to the code:

- **Lambda hot swap died after any engine update.** The dev watch loop
  enrolled the function at a stable S3 key once, then only `PutObject`ed
  there. Every engine-driven update (a binding added, an env var changed)
  re-pointed the function at a content-addressed key, and the watcher's
  one-time-enrollment memo never re-pointed it back — so the next source
  edit was silently ignored until the next engine update happened to
  re-bundle. `FlociFunctionProvider` now re-enrolls whenever the engine has
  reconciled since the last swap
  (`test/AWS/Lambda/Function.local.test.ts`).
- **A request in flight across a Worker hot swap hung forever.** The dev
  proxy parked the retryable request in its retry queue and only drained
  that queue on the *next* PUT or the *next* incoming request. A client
  waiting on that response never sends another, workerd's hang detector
  eventually cancelled the stalled proxy call, and the client got nothing.
  The proxy now re-drives its queue immediately after parking
  (`packages/cloudflare-runtime/src/core/test/proxy/WorkerProxy.test.ts`).
- **Cloudflare Containers never hot reloaded, at all.** Three stacked
  causes: the local provider's image hash was memoized in the RPC sidecar,
  whose artifact store outlives every run — so the diff compared the FIRST
  run's hash forever and reported noop; the worker's restart config only
  carried the image's stable paths, so even a detected change never
  restarted the instance; and user Dockerfile/context files are not
  imported by the stack, so `bun --watch` never replanned for them. Fixed
  by per-plan cache eviction, the content hash riding the container
  binding into the worker's hashed config, and a context watcher in the
  local worker runner (`test/Cloudflare/Container/LocalContainerReload.test.ts`).
- **Dev containers couldn't reach services on the host**
  ([#1334](https://github.com/alchemy-run/alchemy/issues/1334)): env
  values injected into a dev container carry loopback URLs (locally
  emulated databases, dev servers) that dangle inside the container. The
  workerd docker proxy now rewrites loopback hosts in URL-shaped env
  values to `host.docker.localhost`. Docker Desktop maps that through
  `host-gateway`; native Linux unix-socket-tunnels the port into the
  sidecar netns so UFW never sees a SYN to the bridge IP.
- **ECS tasks never rolled on prop-driven updates.** Restart/roll logic
  lived only in the file-watch trigger, so a prop change — an inline
  `dockerfile` edit, a new env var — registered a new task-definition
  revision (and `updateService`d onto it) while the running containers kept
  serving the old one until the next source edit. The dev-watch skeleton
  now has an `onReconciled` hook that fires on BOTH engine-driven and
  watcher-driven reconciles, and both ECS dev providers roll their tasks
  from it (`test/AWS/Local/EcsDev.local.test.ts`).
- **A MicroVM image never rebuilt on a content-only edit.** The image's
  diff compared props only; the in-VM program is not a prop, so
  `alchemy dev` *and* `alchemy deploy` called the edit a noop. The diff now
  hashes the bundled content (memoized for the run) before the props
  resolve, the way the Lambda Function diff does
  (`test/AWS/Lambda/MicrovmImage.local.test.ts`).

Two dev-server behaviours the suite tolerates rather than asserts against,
because they self-heal: the bundler hot-swaps a Worker's new script a beat
before the stack re-apply registers the resources it references (a new
Durable Object class, a new image ARN), so that window serves
`DurableObject 'X' not found` / an undefined binding; and a slow delete
(a MicroVM image) is interrupted by the `bun --watch` restart of every
subsequent edit, completing once edits pause.

## Running it

Requires Docker (floci, the Cloudflare Container, and the MicroVM). No cloud
credentials are used or needed — the suite runs under an alchemy profile
that exists nowhere on disk, with AWS credentials stripped from the
environment and `CI=1` set so the placeholder Cloudflare env credentials are
accepted.

It also requires a **built workspace** (`pnpm build`). The MicroVM binding
pulls `@alchemy.run/floci` into the Worker bundle, and the Worker bundler
resolves that workspace package through its `import` condition — i.e.
`packages/floci/lib`. On an unbuilt tree the MicroVM Worker boots with
`No such module "@alchemy.run/floci"`.

```sh
bun test                    # from examples/dev-stress
DEBUG=1 bun test            # mirror the CLI's output to stderr
NO_DESTROY=1 bun test       # keep the scratch project for inspection
DEV_STRESS_PORT_BASE=9100 bun test   # move the pinned ports
```

The first apply builds a MicroVM image, so a cold run takes a few minutes
before the first assertion runs.

The suite never touches the checked-in tree: it copies this project into
`.stress/<stage>/` and mutates the copy. A full CLI log of the run is left
at `.stress/<stage>/dev-stress.log`.

## Running the stack by hand

```sh
bun run dev
```

`src/ports.ts` pins the local addresses (8790–8795 by default, plus fixed
8796–8798 for ECS and EC2), so the same URLs work every time.
