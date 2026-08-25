import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  token: text("token").notNull(),
});
