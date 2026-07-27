import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { users } from "../schema/users.ts";
import { invitations } from "./invitations.ts";

export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: integer("owner_id").references(() => users.id),
});

export const workspaceInvites = pgTable("workspace_invites", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").references(() => workspaces.id),
  invitationId: integer("invitation_id").references(() => invitations.id),
});
