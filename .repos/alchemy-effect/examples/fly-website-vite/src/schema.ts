import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const Notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Note = typeof Notes.$inferSelect;

export const ENSURE_NOTES_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id serial PRIMARY KEY,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
`;
