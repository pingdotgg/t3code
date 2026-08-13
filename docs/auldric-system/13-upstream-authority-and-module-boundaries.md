# RFC: Upstream T3 authority, product distributions, and domain-module boundaries

## Status and authority

**Status:** accepted architecture classification; not a general implementation authorization.

This RFC is subordinate to [the canonical Marketing spine](./README.md) and `AGENTS.md`. It
supersedes every locally retained assumption that Auldric owns a T3-derived runtime or may build a
generic downstream composition platform. The legacy `AuldricAI/Auldric` repository and material in
`docs/_archive` are donor evidence with no authority.

Acceptance authorizes only rows whose status is `existing-consume`,
`approved-distribution-config`, `approved-domain`, or `approved-thin-adapter`, and only the action
written in that row. It does not unlock a registry, extension framework, distribution runtime,
composition SDK, or Marketing slice. An implementation brief must separately prove that its entire
dependency chain uses eligible rows.

> Describing a missing contract in this RFC records an architectural requirement. It does not
> confer downstream ownership of the missing platform capability.

## Governing decision

Auldric is an independent product distribution statically composed from upstream T3 and required
first-party Marketing domain modules. T3 remains authoritative for shared runtime, clients,
providers, transport, sessions, collaboration, authentication foundations, and remote operation.
Auldric owns distribution identity and product policy plus Marketing logic, contributions, data,
and migrations.

Integration may use an existing upstream composition contract or a narrowly scoped adapter over a
capability T3 already provides. A missing generic seam is an upstream prerequisite or parked work,
never permission for an Auldric runtime fork. Homeschool is a possible future empirical test and
creates no present acceptance criterion or abstraction requirement.

## Terms and closed status vocabulary

- **Distribution:** the customer product, build identity, product policy, packaging, and release
  selection.
- **Domain module:** first-party Marketing behavior, data, migrations, and contributions.
- **Composition contract:** an existing supported boundary through which a module consumes T3.
- **Thin adapter:** narrow translation over an existing T3-owned capability without copied state or
  behavior.
- **Optional module:** initially a trusted, statically bundled module selected or disabled by build
  configuration. It is not downloaded or dynamically executed.

| Status                         | Meaning and permitted action                                             |
| ------------------------------ | ------------------------------------------------------------------------ |
| `existing-consume`             | Consume an existing upstream capability through the named boundary.      |
| `approved-distribution-config` | Define only the named product identity or policy at build time.          |
| `approved-domain`              | Implement only Marketing-owned behavior and data in an isolated module.  |
| `approved-thin-adapter`        | Adapt the named existing capability narrowly and preserve T3 authority.  |
| `upstream-prerequisite`        | Document or propose upstream; do not implement downstream.               |
| `parked`                       | Record the requirement; take no implementation action.                   |
| `deferred-ecosystem`           | Document future ecosystem concerns only.                                 |
| `prohibited-downstream`        | Do not implement, copy, shadow, or present a patch as a stable contract. |

A row containing `TBD` for authority, classification/action, failure behavior, supported surfaces,
or data ownership is not implementation-ready.

## Decisional capability matrix

“Web + desktop” reflects the shared web client. Mobile support is never implied. Exact evidence is
named so later work cannot infer a seam from architectural prose alone.

| Capability                                                                              | Current T3 evidence / composition mechanism                                                              | Authority and data owner                                                              | Surfaces / activation / failure                                                                         | Status and permitted repository action                                                                                               | Verification                                                               |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Native Dev runtime and shell                                                            | Native T3 server, clients, contracts, providers, and non-Marketing routes                                | T3; T3 migrations                                                                     | All shipped T3 surfaces; required; native recovery                                                      | `existing-consume`: preserve and consume unchanged                                                                                   | Baseline drift guard and Dev-invariance tests                              |
| Explicit Marketing route boundary                                                       | Existing TanStack route/root-layout seam classified in [01](./01-product-domain-seam.md)                 | T3 owns root/auth; Marketing owns lazy payload; no new persisted data                 | Web + desktop; required only for the Marketing surface; failure stays inside Marketing and links to Dev | `approved-thin-adapter`: retain only the bounded route/layout composition and exact drift exceptions; do not generalize              | Route, pairing, lazy-failure, desktop-hash, and exact Dev-request tests    |
| Marketing identity in RPC, sessions, events, or provider requests                       | None; the route seam deliberately adds no such field                                                     | T3                                                                                    | All surfaces; unavailable                                                                               | `prohibited-downstream`: do not reinterpret or duplicate T3 runtime identities                                                       | Contract and payload invariance                                            |
| Distribution identity and policy                                                        | Issue #3 owns classification; this RFC identifies no general manifest                                    | Distribution; no domain runtime data                                                  | Surface support and failure behavior remain owned by #3; build-time only                                | `parked`: document desired identity/policy; use no conceptual `defineT3Distribution` API until #3 identifies an eligible mechanism   | #3 decision and per-surface identity checks                                |
| General distribution manifest                                                           | No existing upstream composition contract identified                                                     | T3 if generic; distribution only for an approved private packaging input              | Unresolved; required-module recovery cannot depend on it                                                | `upstream-prerequisite`: propose upstream or park; do not build an Auldric host/bootstrap                                            | Upstream contract tests when a seam exists                                 |
| Pre-module branded recovery                                                             | No pre-activation recovery boundary identified                                                           | T3 mechanism; distribution supplies identity assets only                              | Every distribution-supported surface; required; refuse normal startup                                   | `upstream-prerequisite`: document/propose upstream; do not create an Auldric bootstrap runtime                                       | Startup-failure proof on every supported surface                           |
| Marketing actor and organization binding                                                | Injected request-authority seam and isolated package foundation described in [00](./00-current-state.md) | T3 owns authenticated actor; Marketing owns membership/role binding and domain schema | Server-backed Marketing; required; deny Marketing without affecting Dev                                 | `approved-thin-adapter`: complete only separately owned request-scoped mapping over verified T3 identity; no parallel authentication | Role, organization-isolation, denial, and Dev-invariance tests             |
| Authentication mechanism                                                                | Native T3 pairing/session/transport lifecycle                                                            | T3; T3 credentials                                                                    | All T3 surfaces; required; native refusal/recovery                                                      | `existing-consume`: configure only through a separately approved distribution seam                                                   | Native authentication and remote tests                                     |
| Entitlements, login presentation, privacy, and support destinations                     | No generic composition seam classified here                                                              | Distribution policy; Marketing owns only its tenant policy                            | Decide per shipped surface; protected Marketing behavior fails closed                                   | `parked`: #3/#6 may classify exact configuration; do not replace T3 authentication                                                   | Policy and unauthorized-access tests after classification                  |
| Canonical Marketing persistence                                                         | Isolated store in `packages/auldric-marketing-domain`, described in [00](./00-current-state.md)          | Marketing module; module migration ledger                                             | Server-backed Marketing; required for durable flows; refuse Marketing operation on failure              | `approved-domain`: retain organization-local schemas, immutable revisions, idempotency, and read-back; do not alter T3 event schemas | Migration, isolation, conflict, idempotency, and read-back tests           |
| Marketing evidence and Day 0 pure kernels                                               | Additive foundations described in [00](./00-current-state.md)                                            | Marketing module; domain schemas                                                      | Not composed into production; activation unavailable; failure remains domain-local                      | `approved-domain`: pure Marketing logic only under its owning issue; production composition needs separately eligible dependencies   | Focused deterministic tests; later authorized read-back proof              |
| Domain message envelope and generic fallback                                            | No upstream host-owned envelope identified                                                               | T3 owns transport envelope; module would own payload schema/migrations                | Web, desktop, mobile, hosted, and remote need explicit rules; unknown blocks need fallback              | `upstream-prerequisite`: specify/propose upstream; do not widen T3 core unions or inject arbitrary renderers                         | Version-skew, unknown-kind preservation, and fallback tests when available |
| Declarative UI contributions                                                            | Existing route seam is specific, not a general contribution protocol                                     | T3 if generic; Marketing owns route content                                           | Current approved seam is web + desktop; mobile remains Dev-only                                         | `parked`: use only the approved route seam; create no registry, slot API, or arbitrary React injection                               | Per-surface route and Dev-startup bundle proof                             |
| Required/optional module lifecycle                                                      | No generic activation mechanism identified; optionality is conceptual build configuration                | T3 if generic; distribution selects trusted bundled modules                           | Unresolved; required failure would recover and optional failure would quarantine                        | `upstream-prerequisite`: document semantics only; do not implement an Auldric module loader                                          | Compatibility, recovery, and quarantine tests when available               |
| Marketplace, runtime loading, dependency resolution, signatures, sandboxing, and unload | No supported ecosystem mechanism classified                                                              | T3                                                                                    | Cross-surface and remote implications unresolved                                                        | `deferred-ecosystem`: document only                                                                                                  | None until separately authorized upstream design                           |
| Parallel providers, sessions, transport, auth, client state, updates, or recovery       | Legacy donor implementations only                                                                        | T3                                                                                    | All surfaces; native failure semantics                                                                  | `prohibited-downstream`: never import, rebuild, shadow, or selectively retain                                                        | Drift guard and donor-inventory checks                                     |
| Homeschool-driven abstraction                                                           | No Homeschool implementation or evidence here                                                            | None                                                                                  | Not applicable                                                                                          | `parked`: introduce no contract or acceptance criterion in anticipation of Homeschool                                                | Future empirical classification only                                       |

## Startup invariant (target, not current capability)

```text
Distribution identity and recovery assets
→ compatibility and capability checks
→ required-module activation
→ optional-module activation or quarantine
→ upstream T3 shell with activated domain contributions
```

The distribution input contains identity and policy, never domain runtime behavior. Recovery assets
must be available before module activation and cannot be rendered by the failed module.
Compatibility checks belong to T3 or an explicitly approved thin adapter. Required-module failure
refuses normal startup; optional-module failure quarantines only that trusted bundled module. The
normal shell remains upstream T3, not an Auldric-owned host.

This sequence is blocked wherever the matrix marks an upstream prerequisite. It is not permission
to create the missing mechanism.

## Gate for a Marketing implementation brief

A brief must list user-visible behavior, exact T3 evidence and contracts, every thin adapter,
domain code/data, surfaces, activation and recovery behavior, migration owner, verification, and
explicit non-goals. Every dependency must resolve to `existing-consume`,
`approved-distribution-config`, `approved-domain`, or `approved-thin-adapter`. Any dependency marked
`upstream-prerequisite`, `parked`, `deferred-ecosystem`, or `prohibited-downstream` blocks that
slice. Homeschool supplies no criterion.

## Non-goals

This RFC does not authorize a downstream shared runtime, an Auldric replacement for T3
infrastructure, Homeschool-driven generalization, arbitrary client bundles, runtime package loading,
a marketplace, sandboxing, independent provider/session/transport behavior, shadow T3 state, or an
internal T3 patch presented as a stable composition contract.

**Decision:** adopt the authority model, vocabulary, matrix, startup target, and row-level gate.

**Next action:** use this matrix when preparing issue-owned briefs; propose or park every missing
generic seam upstream.

**Parked until:** every unclassified or ineligible dependency and all generic composition machinery.
