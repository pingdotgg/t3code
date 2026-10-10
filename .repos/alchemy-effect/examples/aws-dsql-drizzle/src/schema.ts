import { boolean, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const Todos = pgSchema("app").table("todos", {
  id: uuid("id").primaryKey(),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
