# Auldric Marketing domain storage boundary

This package owns the issue #5 identity-routing and physical organization-database foundation. It
does not authenticate a request and cannot decode or mint a T3 actor.

The server composition root must instantiate `makeOrganizationWorkspaceStore` with an
`authorize(requestAuthority, requirement)` adapter. `requestAuthority` is generic so the adapter
can accept the server's opaque, request-scoped principal or invitation capability directly. The
adapter is the only trusted boundary: it must reject copied JSON, expired sessions, wrong
organizations, and insufficient roles, then return the canonical issuer and subject. Do not use a
contracts DTO, pairing subject, session ID, thread ID, device ID, or caller-supplied Marketing actor
ID as this authority.

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

Bootstrap is public only for a genuinely new organization. It generates or resolves the Marketing
actor ID inside the transaction and atomically rejects an existing organization before inserting
an actor or membership. Joining an existing organization is a separate operation and requires the
server to authorize an invitation or equivalent role capability.

Each organization database has a hashed physical path and self-identifying schema. Migration is
strict: an empty database is v0, v0 advances once to v1, exact v1 is repeatable, and forward,
partial, or unidentified schemas fail closed. Resolution holds a scoped lease around the open
SQLite handle. Deletion first records `deleting`, blocks new leases, drains existing leases without
polling, erases the database/WAL/SHM files, revokes memberships, and nulls every retained T3
reference value. Failed-provision rollback uses the same exclusive drain: it records a durable
`rolled_back` intent, cannot be overwritten by the provisioning fiber, and can resume after
interruption. Completion atomically marks the organization and project deleted, revokes every
membership, fails the provisioning operation, and erases retained T3 reference values. The
control database retains those non-sensitive lifecycle and idempotency records to prevent either
path from reviving an old organization. A global actor mapping may remain because the same actor
can belong to another organization; the deleted organization's membership never remains active.
