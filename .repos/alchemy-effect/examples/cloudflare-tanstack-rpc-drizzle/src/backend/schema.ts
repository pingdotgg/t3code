import { defineRelations } from "drizzle-orm";
import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const Todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type TodoRow = typeof Todos.$inferSelect;

export const relations = defineRelations({ Todos }, () => ({}));
