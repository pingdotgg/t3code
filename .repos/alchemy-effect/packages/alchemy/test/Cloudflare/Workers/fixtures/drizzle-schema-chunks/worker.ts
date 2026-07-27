/**
 * Plain Worker entry that imports a multi-module Drizzle schema graph with
 * top-level `pgTable(...)` initializers — the shape that triggers #749 when
 * Rolldown splits those schema modules into a chunk away from `drizzle-orm`.
 *
 * See `DrizzleSchemaChunks.test.ts` for the forced-split repro and the
 * grouping workaround.
 */
import { invitations } from "./auth/invitations.ts";
import { workspaces, workspaceInvites } from "./auth/workspace.ts";
import { sessions } from "./schema/sessions.ts";
import { users } from "./schema/users.ts";
import { waitlist } from "./schema/waitlist.ts";

export default {
  async fetch() {
    const tables = [
      users,
      sessions,
      waitlist,
      invitations,
      workspaces,
      workspaceInvites,
    ];
    return Response.json({
      ok: true,
      count: tables.length,
      userCols: Object.keys(users),
    });
  },
};
