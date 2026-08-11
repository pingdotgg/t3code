# Auldric Marketing organization storage boundary

This package owns the issue #5 identity-routing and physical organization-database foundation, the
issue #8 canonical Marketing content store, and the issue #9 bounded evidence-context core. It does
not authenticate a request and cannot decode or mint a T3 actor.

The server composition root must instantiate `makeOrganizationWorkspaceStore` with an
`authorize(requestAuthority, requirement)` adapter. `requestAuthority` is generic so the adapter
can accept the server's opaque, request-scoped principal or invitation capability directly. The
adapter is the only trusted boundary: it must reject copied JSON, expired sessions, wrong
organizations, and insufficient roles, then return the canonical issuer and subject. Do not use a
contracts DTO, pairing subject, session ID, thread ID, device ID, or caller-supplied Marketing actor
ID as this authority.

The public workspace `resolve` callback returns identity and routing metadata only. Its live SQLite
handle is carried in a module-private capability registry that is absent from the store object and
package exports, and consumed only by `makeMarketingCanonicalStore`. Production consumers mutate
canonical tables only through that canonical API; they must never reopen the organization database
and issue SQL themselves.

The store asks for one explicit permission per lifecycle operation:

- `bootstrap-new-organization`
- `join-existing-organization`
- `resolve-workspace`
- `revoke-membership`
- `delete-workspace`
- `link-t3-reference`
- `mark-t3-reference-stale`
- `delete-t3-reference`
- `backfill-workspace`
- `rollback-provisioning`

Those lifecycle permissions remain unchanged by issue #8. `makeMarketingCanonicalStore` composes
over an already constructed organization store and asks a separate injected authorizer for an exact
content operation. The requirement carries the resolved Marketing actor, organization selection,
typed object identity, and canonical claim where relevant. The server's issue #6 role adapter owns
that decision; wire credentials and caller-created actor IDs are never accepted by this package.

The canonical content store persists source, workflow-instance, plan, artifact, saved-output,
review, decision, and next-action heads in the resolved physical organization database. Every write
requires an expected version and idempotency key, creates an immutable revision, records the acting
Marketing actor and typed schema/definition references, normalizes source/review/decision revision
edges, and returns a database read-back. Registered outputs use their own identity and a registry-
accepted renderer reference; they cannot target or overwrite an artifact head. The schema and
renderer registry is injected so issue #8 does not invent issue #19's definition catalog.
Canonical keys are unique across every object kind in a workspace.

The injected registry also derives a narrow set of typed projection facts from each validated
payload. Those facts are stored with, and made immutable by, the exact revision that produced them.
Authorized queries read only facts on current canonical heads from the resolved organization
database; revision history retains older facts. Callers cannot submit arbitrary fact keys or use
facts to mutate canonical heads. Issue #19 owns the concrete fact keys and rollup semantics.
Each committed revision has an immutable child seal. SQLite rejects reference or fact inserts after
that seal and rejects every update or deletion; reads independently verify the sealed child digest.
The digest is a consistency seal, not a MAC or authorization credential. Arbitrary code running in
the trusted server process—or an operator with direct filesystem write access—can rewrite SQLite
and is outside this boundary. Remote callers, plugins, and ordinary domain consumers never receive
that authority.

Bootstrap is public only for a genuinely new organization. It generates or resolves the Marketing
actor ID inside the transaction and atomically rejects an existing organization before inserting
an actor or membership. Joining an existing organization is a separate operation and requires the
server to authorize an invitation or equivalent role capability.

Each organization database has a hashed physical path and self-identifying schema. Migration is
strict: an empty database is v0, v0 advances through v1, v2, and v3; exact v1 and v2 upgrade
transactionally; exact v3 is repeatable; and forward, partial, or unidentified schemas fail closed.
Resolution holds a scoped lease around the open
SQLite handle. All store factories for the same resolved state root share one process-local
coordinator, so initialization, leases, and deletion locks cannot diverge when the composition root
creates multiple adapters. Deletion first records `deleting`, blocks new leases, drains existing
leases without polling, erases the database/WAL/SHM files, revokes memberships, and nulls every
retained T3 reference value. Failed-provision rollback uses the same exclusive drain: it records a
durable `rolled_back` intent, cannot be overwritten by the provisioning fiber, and can resume after
interruption. Completion atomically marks the organization and project deleted, revokes every
membership, fails the provisioning operation, and erases retained T3 reference values. The control
database retains those non-sensitive lifecycle and idempotency records to prevent either path from
reviving an old organization. A global actor mapping may remain because the same actor can belong
to another organization; the deleted organization's membership never remains active.

The deployment invariant is one live Auldric/T3 server process per state root. The shared
coordinator deliberately covers every store factory in that process without coupling different
roots; it is not an inter-process filesystem lock. Operators must never point two live server
processes at the same Auldric state root. Coordinators remain registered for the process lifetime;
that set is bounded by the server's configured Auldric state roots. They are not evicted because a
factory has no scoped shutdown signal that could prove every older adapter and lease is gone.

Issue #6 still owns the production request-authority and role adapter. Issue #11 owns the full
consequential audit model, and issue #19 owns exact workflow/artifact families, payload schemas,
renderers, and rollup semantics. This package supplies their fail-closed persistence seam without
claiming those layers are implemented. Content never falls back to T3 `state.sqlite`, browser state,
another organization, or documentation.

## Bounded evidence context

`compileMarketingEvidenceContext` builds a transient, Marketing-only packet from one exact
organization snapshot. Callers must supply an explicit allowlist of source revisions. The compiler
keeps an optional exact plan/stage selection and source capability, access, import, index, and
freshness separate from retrieved evidence, accepted facts, assumptions, conflicts, gaps,
questions, disconfirmation signals, and readiness.
It normalizes text deterministically, rejects locator/hash conflicts and non-allowlisted evidence,
ranks with a versioned integer policy, admits whole items only, and returns a SHA-256 receipt for
every inclusion and exclusion under explicit item, source, byte, and token ceilings.

`makeMarketingEvidenceContextService` composes only over the existing authorized canonical store
and injected source adapters. It checks exact heads before adapters run and again before returning a
packet. Inaccessible, unindexed, stale, or failed sources produce truthful gaps without fabricated
evidence. A missing plan is explicit, and readiness remains `not-evaluated` unless an injected
domain projector supplies it. Compilation and source inspection are read-only. The only durable evidence operations are
explicit `acceptFact`, `supersedeFact`, and `withdrawFact` calls; each writes a canonical decision,
exact source lineage, optional exact reviews, an expected version, an idempotency receipt, and a
committed read-back.

Evidence-owned source heads use `evidence/source-state@1`. Accepted reusable facts use
`evidence.fact-acceptance@1` and the workspace-wide canonical key
`evidence/fact/<stable-key>`. The exported schema-handler composition keeps this namespace separate
from #11 review/audit and #19 workflow/artifact registrations. There is no provider, prompt,
session, transport, client, Dev, or production endpoint integration in this package. Issue #6 must
provide the approved Marketing request seam before a production caller can use it.
