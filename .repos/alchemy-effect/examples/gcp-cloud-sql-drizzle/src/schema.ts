import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
});
