# Auldric Marketing launch readiness

## Honest status

Auldric Marketing is not currently ready for a random user. The explicit Marketing route and a
separate fail-closed public information surface now exist, but a usable authorized product service,
data stores, workflows, in-product UI, operational access, and end-to-end proof remain implementation
work.

## Production definition

Random-user readiness requires a new authorized user, without operator narration, to:

1. reach a truthful approved access surface;
2. enter and exit Marketing without changing native T3 Dev;
3. create or select authorized sources and understand access/index/freshness state;
4. produce, save, reopen, and review a Day 0 packet;
5. accept or override exactly one Marketing Strategy or GTM route;
6. complete the selected workflow's required child artifacts and exact parent rollup;
7. revise, compare, review, approve, and reopen canonical artifacts through Library;
8. optionally approve a bounded brief for native T3 Dev;
9. encounter understandable empty, loading, denied, conflict, unavailable, and recovery states;
10. remain isolated from every other organization.

The final proof must cover desktop and narrow layouts, keyboard/focus behaviour, accessibility,
overflow/clipping, console errors, canonical read-back, role enforcement, immutable provenance,
failure recovery, and exact Dev payload/import invariance.

## Gates

| Gate                      | Owner                 | Exit condition                                                             |
| ------------------------- | --------------------- | -------------------------------------------------------------------------- |
| T3 baseline and authority | #2, #17               | Pin/guard passes and active guidance is reconciled                         |
| Donor classification      | #14                   | Every retained requirement has owner, seam, migration, rollback, and proof |
| Domain and access         | #4, #5, #6            | Explicit reversible domain plus verified actor and organization isolation  |
| Canonical Marketing core  | #8, #9, #11, #18, #19 | Persistence, evidence, provenance, Day 0, and typed workflows pass         |
| Product surfaces          | #13 and #21-#27       | Approved UI/public surfaces cover required states                          |
| Final release proof       | #15                   | Complete two-user journey and unchanged native Dev proof                   |

No gate is satisfied by legacy status, copied code, a static mock, or a generated preview. The
static Auldric information site and native T3 functionality must not be presented as completed
Auldric Marketing product work.

## Verification rhythm

Each capability closes with focused tests, repository formatting/lint/typechecking, canonical
read-back where applicable, and the browser evidence required by its issue. Final launch remains
no-go until #15 succeeds on an integrated pinned baseline.

**Decision:** use this random-user production definition without weakening its gates.

**Next action:** complete the prerequisite and dependency waves in issue order.

**Parked until:** any capability whose supported T3 seam, organization authority, donor
classification, or integrated proof is missing.
