import { defineRelations } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const Widgets = pgTable("alchemy_postgres_widgets", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});
export type Widget = typeof Widgets.$inferSelect;

export const relations = defineRelations({ Widgets }, () => ({}));
