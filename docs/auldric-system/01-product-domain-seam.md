# Product-domain seam

## Decision

Use the web client's existing TanStack file-route and root-layout composition point as the smallest
supported seam. The route tree structurally owns the complete client-side product-domain state:

```text
/marketing[/...] -> marketing
every other path -> dev
```

The resolver returns only `dev | marketing` from matched route identity, not a pathname guess.
Missing, unknown, or malformed routes resolve to `dev`. It is independent of T3's provider
interaction modes. No product-domain field is added to a T3 command, event, RPC, provider request,
session, or database record.

The route tree statically registers a case-sensitive critical `/marketing` parent plus lazy index
and splat children. That parent reserves every Marketing descendant before T3's dynamic chat route
can match it. It owns only the native authentication gate, accessible pending state, and failure
containment; Marketing payload UI remains in lazy chunks and is absent from native Dev startup and
turn paths. The root layout selects the isolated outlet only when the Marketing parent actually
matched and otherwise renders the existing T3 command palette and sidebar tree.

Local unauthenticated access redirects through native pairing with a narrowly validated local
Marketing return path. Hosted static is a supported T3 client surface, not Marketing data
authorization: it terminates at an explicit no-data state linking to Connections before a lazy
Marketing child can load. Issue #6 must provide a request-scoped verified environment actor before
that surface can read Marketing data. Lazy-load and render failures remain inside the Marketing
parent and expose a direct return to Dev.

## Repo-grounded options

### Selected: bounded route and layout composition

The current client already creates browser history for web and hash history for Electron in
`apps/web/src/main.tsx`, builds its router from the generated file tree in `apps/web/src/router.ts`,
and enables TanStack file routing in `apps/web/vite.config.ts`. `apps/web/src/routes/__root.tsx`
provides the native authentication gate context and the single layout composition point. These
existing public framework seams are sufficient; no provider, session, prompt, transport, new
authentication implementation, or persistence hook is required.

Affected ownership:

- T3 owns the `dev` fallback, the generic root-layout selection, pairing, authentication,
  connection state, and unchanged Dev shell.
- Auldric owns the explicit `/marketing` namespace and its lazy payload.
- Web and desktop share the same route implementation. Native mobile remains Dev-only until a
  separately approved Marketing surface owns its navigation and proof.

The existing T3 files changed by this bounded seam are exact-path, content-hashed temporary
exceptions in the shared-core drift guard, and CI executes each declared focused test. The generic
upstream extension discussion is related provenance, not a proposal for this route patch:
[`pingdotgg/t3code#5020`](https://github.com/pingdotgg/t3code/issues/5020). Newly added domain and
route files are listed as exact additive Marketing paths; the guard is not broadened to an existing
T3 directory.

Proof uses real memory-router matching for exact, deep, catch-all, case-mismatched, and adjacent
paths, plus desktop hash history. It covers authenticated, pairing-gated, and hosted-static access;
safe post-pair return; delayed and rejected lazy imports; accessible pending and error recovery;
reversible destinations; and the exact native `thread.turn.start` request payload. Focused tests
run without changing the native interaction-mode contract.

Risk is confined to the root layout conditional, generated route registration, and the validated
Marketing-only return handled by the native pair route. The Dev branch keeps the existing component
tree and all non-Marketing matches select it. Rollback removes the route, return parser, and
conditional without translating or rewriting T3 state.

### Not selected: durable public extension registry

A general public architecture would add a T3-owned, versioned product-domain registry with lazy
client entries, capability discovery, lifecycle cleanup, optional typed RPC-group composition, and
defined web, desktop, and mobile behavior. That would affect `packages/contracts`,
`packages/client-runtime`, the web router/root, server RPC authorization and assembly, and client
bootstrap code.

This option creates a long-term public compatibility surface, version-skew rules, extension
authorization policy, and multi-client failure semantics. Its risk and upstream review cost are
materially higher than the single-domain requirement. It remains appropriate upstream work if T3
adopts a general extension system, but it is not necessary for the isolated Marketing route and
would expand issue #4 into shared platform architecture.

**Decision:** use the bounded URL-owned route/layout seam and keep all T3 runtime and turn contracts
unchanged.

**Next action:** issue #21 replaces the minimal lazy boundary proof with the approved responsive
Marketing shell; Marketing backend issues add only separately typed domain operations.

**Parked until:** a generic installable product-domain or client-extension registry until T3 owns a
public extension API and its cross-client compatibility contract.
