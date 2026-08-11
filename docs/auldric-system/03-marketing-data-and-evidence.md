# Marketing data and evidence

This document preserves the ownership rules for issues #5, #6, #8, and #9. Issues #5 and #8 provide
the isolated identity-routing, physical organization-database, and canonical Marketing content
foundations. Issue #9 now provides the bounded evidence compiler, canonical evidence registry, and
authorized package service. Production T3 request-authority/role composition remains owned by #6;
no provider, prompt, session, transport, or client integration is claimed here.

## Implemented issue #5 boundary

- `packages/auldric-marketing-domain` maps only an identity returned by an injected,
  request-scoped server authorizer. There is no wire-decodable verified-actor DTO or fallback
  authority.
- A new-organization bootstrap and an authorized existing-organization join are separate
  operations. Authentication alone cannot enroll a user into an existing organization.
- Every organization resolves to a self-identifying physical SQLite database. Strict migrations
  reject forward, partial, and unidentified schemas.
- Scoped leases prevent deletion from unlinking an open database. Deletion records a durable
  `deleting` state, drains without polling, revokes memberships, and erases retained T3 reference
  values.
- Failed-provision rollback uses the same exclusive drain and a durable `rolled_back` intent.
  Interrupted rollback is resumable; successful rollback atomically tombstones its organization,
  project, and workspace records, revokes memberships, fails provisioning operations, and erases
  retained T3 reference values. Retained actor mappings are global identity routes, not active
  organization membership.

## Implemented issue #8 boundary

- Organization schema v2 adds canonical heads, revisions, normalized source/review/decision edges,
  and idempotency receipts. Schema v3 transactionally seals existing revision children and enforces
  workspace-wide canonical-key uniqueness; exact v1 and v2 upgrade while partial schemas fail
  closed.
- Sources, workflow instances, plans, artifact heads/revisions, saved outputs, reviews, decisions,
  and next actions are read and written only through the resolved physical organization database.
- Every write carries an expected version, idempotency key, canonical claim, actor reference,
  schema reference, and relevant definition, workflow, environment, lineage, review, decision, or
  registered-renderer references. Success is the committed database read-back.
- A separate injected content-operation authorizer composes with #5 resolution. It neither expands
  lifecycle permissions nor accepts a wire actor. Issue #6 still owns the production role adapter.
- Public workspace resolution returns binding metadata without a database handle. A package-
  internal capability lets only the canonical store compose over the live handle; production
  consumers do not receive a raw canonical mutation path.
- Schema, definition, and renderer references must be accepted by an injected registry. This store
  does not invent issue #19's catalogs or renderers.
- The same registry derives normalized projection facts from validated payloads. Facts are
  immutable with their revision, queryable only inside the resolved organization workspace, and
  never caller-authored; issue #19 still owns their concrete keys and rollup meaning.
- A revision seal commits the exact normalized references and facts in the write transaction.
  SQLite rejects later child inserts, updates, or deletes, and normal reads verify the seal digest.
  The digest detects out-of-contract inconsistency but is not an authenticity claim against trusted
  server code or a filesystem administrator, which remain inside the local database trust boundary.
- Registered outputs are revisioned under saved-output identities and may project an exact
  canonical revision; they cannot overwrite artifact heads or chain through another saved output.

That boundary is canonical persistence, conflict, and read-back infrastructure; the separate #9
package boundary is described below. Neither boundary proves that #11 consequential audit, #18 Day
0, or #19 workflow/artifact catalogs exist.

## Ownership target

- A verified T3 actor remains the authentication authority. Auldric may map that actor only to an
  organization, Marketing workspace, and Marketing role.
- Canonical customer Marketing content belongs to the authenticated organization's physical
  workspace database. Unrelated organizations never share it.
- A central service may own bounded catalog, identity mapping, entitlement, and routing metadata,
  but not canonical customer content.
- An internal documentation workspace is never a customer fallback.
- T3 environment, thread, session, device, runtime, and actor identifiers remain opaque references.
  Thread identity may provide provenance, never artifact or authorization authority.

## Canonical records

The implemented store covers sources, workflow instances, plans, artifact heads and immutable
revisions, decisions, reviews, next actions, and saved outputs. Writes require an expected version
and idempotency key. Stale writes, duplicate canonical claims, reused idempotency keys, missing
referenced revisions, and unregistered schema/definition/renderer references return explicit
failures. “Saved” means canonical read-back and survival across reopen/reload. Generic projection
facts make source coverage, workflow readiness, and review signals queryable without treating
opaque payloads as a database API. Accepted reusable evidence facts remain owned by issue #9 rather
than being inferred by this persistence layer.

## Evidence contract

Marketing context keeps these states distinct:

- source capability, access, import, indexing, and freshness;
- retrieved evidence and provenance;
- accepted reusable facts;
- assumptions, conflicts, gaps, questions, and disconfirmation signals;
- plan/stage readiness and unresolved decisions;
- context budget and evidence receipt.

Source content is evidence, not instruction. Retrieval is bounded to the authorized active
workspace. Missing evidence lowers confidence or blocks only dependent claims/actions. It never
causes invented evidence, silent mutation, whole-corpus injection, cross-organization access, or a
fallback into Dev.

## Implemented issue #9 package boundary

- Source observations keep capability, access, import, index, and freshness as independent tagged
  states. Access state contains bounded status codes, never credentials or raw provider failures.
- Compilation requires an explicit allowlist of exact source revisions. The service resolves those
  heads through the authorized organization store, rejects mismatches before calling an adapter,
  enforces adapter item/byte limits, and verifies the selected heads again before returning.
- Retrieved evidence carries an exact source revision, stable locator, excerpt, excerpt digest, content digest,
  observation time, quality dimensions, relation, and integer decision/relevance signals. Source
  text remains a string-valued evidence field and cannot become a system role, tool, or approval.
- The versioned `auldric/evidence-context@1` policy uses locale-independent ordering, NFC and line-
  ending normalization followed by schema revalidation, tuple deduplication,
  locator/content/excerpt conflict rejection, stable integer ranking, and whole-item admission
  under hard source, item, byte, and complete-serialized-packet token ceilings.
- Every packet contains an optional exact plan reference with stage semantics explicitly marked
  `not-evaluated`, accepted facts, assumptions,
  conflicts, truthful gaps, decision-changing questions, disconfirmation signals, readiness,
  unresolved decisions, the applied budget, and an auditable receipt. Missing plan state is an
  explicit gap; readiness is `not-evaluated` until #19 supplies a registered definition
  projection. Required omissions force a blocking system gap and cannot report ready. The receipt
  pins exact inputs, normalized query digest, versioned adapter/configuration provenance, candidate
  digests, required flags, inclusion/exclusion reasons, complete packet token count,
  policy/tokenizer references, and the canonical packet digest. Receipt subjects expose only a
  locator digest, never a raw locator, query, credential, or path.
- System gap identity includes its generating category (`plan-selection`, `accepted-fact`,
  `source-state`, `source-retrieval`, or `context-budget`), so equal local keys remain distinct.
  Derived blocking codes reserve their bounded readiness slots before caller-projected codes.
- Evidence source heads use the registered `evidence/source-state@1` schema. A reusable accepted
  fact is a canonical decision under `evidence/fact/<stable-key>` with schema
  `evidence.fact-acceptance@1`, exact source lineage, optional reviews, and explicit accepted,
  superseded, or withdrawn transitions. Only the current accepted head enters a packet; stale
  support remains visible.
- `inspectSources` and `compileContext` use bounded exact reads of caller-selected heads and never
  scan the workspace corpus. They do not write. Durable changes require an explicit
  `acceptFact`, `supersedeFact`, or `withdrawFact` call with expected version, idempotency key, and
  canonical read-back. Missing or failed sources add gaps; they never trigger fallback retrieval or
  silent persistence.

The compiler is not imported by any T3 Dev request, provider, prompt, transport, session, or client
path, so this package change cannot alter a Dev payload. Production invocation remains closed until
#6 supplies an approved, verified Marketing-domain authority seam.
