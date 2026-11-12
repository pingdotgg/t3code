import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Top-level `pgTable(...)` — evaluated at module init. When Rolldown puts
 * this module in a separate chunk from `drizzle-orm`, workerd can observe
 * incomplete cross-chunk bindings during startup (#749).
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});
