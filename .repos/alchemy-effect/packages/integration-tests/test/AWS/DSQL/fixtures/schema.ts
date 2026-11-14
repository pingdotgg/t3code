import { integer, pgTable, text } from "drizzle-orm/pg-core";

// DSQL restrictions: no SERIAL/sequences and no foreign keys — a plain
// integer primary key + text column stays well inside the supported surface.
export const Widgets = pgTable("dsql_connect_widgets", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
});
export type Widget = typeof Widgets.$inferSelect;
