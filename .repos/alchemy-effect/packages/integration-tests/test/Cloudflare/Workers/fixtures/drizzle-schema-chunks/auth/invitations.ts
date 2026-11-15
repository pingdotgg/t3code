import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../schema/users.ts";

/**
 * Mirrors the issue #749 layout: auth package schema modules that construct
 * Drizzle tables at module scope and cross-import the db schema.
 */
export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  invitedBy: integer("invited_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});
