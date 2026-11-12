import { pgTable, text, uuid, index } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
  },
  (table) => [index("users_email_idx").on(table.email)],
);
