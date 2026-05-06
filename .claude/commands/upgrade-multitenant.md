---
description: Guide through upgrading a single-tenant Better Auth setup to multi-tenant (organizations).
---

Guide the user through adding multi-tenant support using Better Auth's `organization` plugin.

Reference: Better Auth v1.4 docs — https://www.better-auth.com/docs/plugins/organization

## Step 1: Confirm prerequisites

- [ ] Better Auth v1.4 is installed (not 1.5 — breaking changes exist)
- [ ] Single-tenant auth is working end-to-end
- [ ] Database migrations are in a working state

## Step 2: Add organization plugin (Stack A)

```ts
// apps/api/src/auth/auth.ts
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  // ... existing config
  plugins: [
    organization({
      allowUserToCreateOrganization: true, // or role-gated
      creatorRole: "owner",
      membershipRoles: ["owner", "admin", "member"],
    }),
  ],
});
```

## Step 3: Run migrations

Better Auth will generate new tables for organizations, memberships, and invitations.
Review the migration before applying:

```bash
# Stack A (Drizzle)
bun drizzle-kit generate
# Review migration file
bun drizzle-kit migrate
```

## Step 4: Update auth middleware/guards

All protected routes need to check both session AND organization membership:

```ts
// apps/api/src/auth/auth.guard.ts
// After verifying session, verify org membership for org-scoped routes
const membership = await auth.api.getOrganizationMembership({
  headers: request.headers,
});
if (!membership) throw new ForbiddenError("Not a member of this organization");
```

## Step 5: Update data model

Tag all resource tables with `organizationId` using a **staged migration** so existing rows are not broken:

1. **Add nullable column** — `organizationId: uuid('organization_id').references(() => organizations.id)` (omit `.notNull()` until backfill completes).
2. **Backfill** — assign every existing row to a default organization (or run a one-off script / manual assignment per tenant).
3. **Enforce NOT NULL** — follow-up migration: alter column to `.notNull()`.
4. **Index** — `.index('by_org', ['organizationId'])` after the column is stable.

Update all queries to filter by `organizationId`.

## Step 6: Invitation flow

Better Auth provides invitation-based onboarding:

- `auth.api.createInvitation()` — send invite
- `auth.api.acceptInvitation()` — accept invite link
- Email delivery: integrate with your email provider (Resend recommended)

## Step 7: Update tests

- Add test fixtures for org + membership
- Test: owner can invite, member cannot invite, non-member cannot access
- Test: data isolation between organizations

## Step 8: PDPL note

Multi-tenant adds a new data boundary. Ensure:

- Privacy notice updated to mention organizational data sharing
- Audit logs include `organizationId`
- Data erasure scoped to org membership (leaving org ≠ deleting account)
