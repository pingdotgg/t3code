# Product-domain seam

## Decision

Use the web client's existing TanStack file-route and root-layout composition point as the smallest
supported seam. The URL is the complete client-side product-domain state:

```text
/marketing[/...] -> marketing
every other path -> dev
```

The resolver returns only `dev | marketing`; missing, unknown, or malformed values resolve to
`dev`. It is independent of T3's provider interaction modes. No product-domain field is added to a
T3 command, event, RPC, provider request, session, or database record.

The route tree statically registers only a generic virtual route. The Marketing route component is
a lazy chunk, so native Dev startup and turn paths do not import Marketing payload code. The root
layout selects the isolated route outlet only for the exact Marketing namespace and otherwise
renders the existing T3 command palette and sidebar tree. The lazy route contains render failures;
the generic root error boundary detects the Marketing namespace for chunk-load failures. Both
failure paths expose a direct return to Dev.

## Repo-grounded options

### Selected: bounded route and layout composition

The current client already creates browser history for web and hash history for Electron in
`apps/web/src/main.tsx`, builds its router from the generated file tree in `apps/web/src/router.ts`,
and enables TanStack file routing in `apps/web/vite.config.ts`. `apps/web/src/routes/__root.tsx` is
the single authenticated layout composition point. These existing public framework seams are
sufficient; no provider, session, prompt, transport, authentication, or persistence hook is
required.

Affected ownership:

- T3 owns the `dev` fallback, the generic root-layout selection, authentication, connection state,
  and unchanged Dev shell.
- Auldric owns the explicit `/marketing` namespace and its lazy payload.
- Web and desktop share the same route implementation. Native mobile remains Dev-only until a
  separately approved Marketing surface owns its navigation and proof.

The existing T3 files changed by this bounded seam are exact-path temporary exceptions in the
shared-core drift guard. The generic upstream extension discussion is
[`pingdotgg/t3code#5020`](https://github.com/pingdotgg/t3code/issues/5020). Newly added domain and
route files are listed as exact additive Marketing paths; the guard is not broadened to an existing
T3 directory.

Proof covers fallback decoding, exact namespace matching, reversible destinations, generated lazy
imports, route-local loading and failure states, generic chunk-load recovery, and the exact native
`thread.turn.start` request payload. Focused tests run without changing the native interaction-mode
contract.

Risk is confined to the root layout conditional and generated route registration. The Dev branch
keeps the existing component tree and all non-Marketing paths select it. Rollback removes the new
route and conditional without translating or rewriting T3 state.

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
