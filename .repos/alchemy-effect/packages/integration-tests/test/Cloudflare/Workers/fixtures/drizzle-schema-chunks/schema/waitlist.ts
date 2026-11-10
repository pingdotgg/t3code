import { boolean, integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

export const waitlist = pgTable("waitlist", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  approved: boolean("approved").default(false),
  referredBy: integer("referred_by").references(() => users.id),
});
