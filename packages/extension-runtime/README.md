# Environment extension runtime

Trusted developer-installed, bundled JavaScript packages for one T3 environment.
This package supplies installation and execution to the server adapter. It does
not launch an application server, install dependencies, run lifecycle scripts,
provide a marketplace, or sandbox trusted JavaScript.

`createExtensionRuntime({ rootDir, environmentId, services, authorize, timeoutMs })`
owns one installation registry and the child processes it starts. Use exactly one
runtime owner per root. The authenticated server must derive the environment,
project, thread and workspace revision; client-supplied context is not authority.
The authorization callback runs before and after tool execution and every named
host service. Explicit capability and project grants are stored outside packages;
both default to empty. Pure tools still require a project grant.

The returned runtime supports `install(sourceDir, grants)`, `list()`,
`enable(id)`, `disable(id)`, `remove(id)`, `update(id, sourceDir)`,
`readClient(id)`, `invoke(toolId, input, verifiedContext, signal, expectedContentHash?)`
and `dispose()`. Installation records include validated package metadata,
contentHash, enabled and grants. Updates retain grants and enabled state.
Client delivery returns authenticated-adapter-ready `{ code, contentHash }`;
clients should bind that hash to every invocation so an update rejects stale code.

Formats 1/2/3 copy only `t3-extension.json` and declared client/server entries.
Format 4 additionally copies explicitly declared binary assets. Entries remain
bundled ESM .mjs/.js, with no separately installed dependencies. Installation checks format, strict draft-7 schemas without external
references, byte bounds and JavaScript syntax without executing package code.
The runtime owns a small module-scope file outside the content hash directories,
so declared ESM .js entries remain modules even beneath a CommonJS ancestor.
An existing conflicting file or symlink is rejected and preserved. Legacy package
hash framing remains unchanged. A format-4 manifest commits each asset's path,
size, media type and SHA-256 digest into the installation hash.
The server default export is validated during lazy first invocation. A valid
syntax file with an invalid export fails explicitly at that point; an explicit
update can replace it. No package code runs inside the host process.

Each installation has a lazy Node child using the compiled `dist/worker.js`.
Code and metadata digests are checked before invocation and client delivery.
Disable, remove and update invalidate pending results and terminate only the
captured child. Cancellation aborts only its call and associated services. Cooperative tools settle
without affecting another viewer's call. A cancelled tool that does not settle by
the hard deadline terminates its installation's worker, as do other hard deadlines;
concurrent calls then fail together. Other installations are unaffected.
Host services receive a copied context and an AbortSignal. Services must observe
that signal to stop their own underlying work. A late result is never admitted
after cancellation, generation change or authorization revocation.

Bounds: 32 installations, 128 stored content revisions, 1 MiB for declared code
and metadata, 64 KiB manifest/JSON messages, 16 tools and capabilities per
tool, 64 project grants, eight pending calls and host-service requests per worker.
The default total invocation deadline is ten seconds (configurable up to sixty).
Workers receive a 96 MiB V8 heap limit. These bounds constrain normal protocol
work; trusted code retains the operating-system permissions of its Node process.
Install, update and remove prune unreferenced hash directories before committing.
Current installation hashes are retained; one most recently retired revision may
remain until the next mutation. Old owned children drain before a retired revision
can be pruned. Cleanup errors therefore leave the active registry unchanged.

Build the SDK, then this package before use. The Node tests import the compiled
runtime and launch real disposable worker processes and temporary packages.

Bundled server adapters may pass workerUrl pointing at their separately emitted
worker entry, bundled from @t3tools/extension-runtime/worker. The default uses
the packaged adjacent dist/worker.js. IPC envelope overhead has a separate
256 KiB bound; each input, result and package retains its public SDK bound.

Syntax checks and workers explicitly set ELECTRON_RUN_AS_NODE=1 because desktop
backends use the Electron executable as Node. Their environment remains limited
to PATH, this mode flag, and production NODE_ENV for workers; host credentials
are not inherited through environment variables. To exercise this path, set
T3_EXTENSION_TEST_ELECTRON to a cached Electron executable when running the tests.
The optional test installs the public reader and invokes its real child worker
without launching an Electron GUI. Ordinary Node test runs report it skipped.

## Versioned APIs and authenticated host adapters

Format-2 packages can provide/consume versioned unary APIs; format 3 adds bounded read-only
streams while preserving format-1/2 loading. Dependencies, selected providers, version ranges
and grants determine availability. Registration alone gives no authority. The runtime exposes
catalogue/discovery, provider selection and rollback in addition to the earlier tool methods.

The public runtime entry exports HostApiProvider, HostApiInvocationMetadata,
HostApiPrincipal and HostApiRootAuthority as TypeScript types. Host providers are supplied
through apiProviders; plugins declare APIs in their package and run handlers in their worker.
Do not import the private broker module to implement an embedding adapter.

invokeApi(installationId, expectedContentHash, request, signal, root?) and
subscribeApi(installationId, expectedContentHash, request, signal, root?) accept a host-created
root as their final argument. The host constructs it from verified authentication and a
revalidation callback. Identity/scopes are captured immutably, descendants inherit attenuated
authority, and plugin JSON cannot replace it. Providers with requiresRootAuthority reject
legacy rootless entry. Existing tool/MCP entrypoints do not acquire authenticated roots yet.

Host metadata supplies call ancestry, provider/caller generations, sanitized principal, and
the optional host-only assertAuthority callback. A mutation adapter must require this callback
and await it immediately before its side-effect boundary, after any preparatory I/O. It checks
the current invocation's cancellation, root authority, grants and resource scope; retained
callbacks reject after the invocation/stream closes. The callback is not a plugin API, is never
sent in worker IPC and must not be returned or copied into audit payloads.

This check does not create a filesystem transaction, serialize external editors or undo an
already-completed mutation. Interrupted writes need explicit unknown-outcome recovery.
The broker still checks before dispatch and before admitting results/frames; adapters must
pass AbortSignal to their underlying I/O as well.

Format-4 assets are limited to 32 files, 4 MiB each and 8 MiB combined.
readAsset(id, expectedContentHash, path, signal) returns verified bytes and
declared mediaType/sha256. It admits at most 16 concurrent reads overall and four
per installation; overflow fails immediately and cancellation/failure releases
capacity. The host adapter supplies authenticated read authority; registration
does not grant terminal, workspace or orchestration control.

Installation, client delivery, enable and rollback verify complete assets.
Ordinary API/tool integrity checks read code and metadata only; each asset is
size/digest-verified before its own delivery. Unrequested asset files are not
continuously rehashed. This avoids rereading renderer binaries on every API call.
Returned bytes are static package data, not an authority or resource lease.
