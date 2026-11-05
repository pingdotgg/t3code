import { defineRelations } from "drizzle-orm";
import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core";

// Mirrors migrations/0001_create_widgets.sql, which the branch applies on
// deploy via `migrationsDir`.
export const Widgets = mysqlTable("alchemy_mysql_widgets", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
});
export type Widget = typeof Widgets.$inferSelect;

export const relations = defineRelations({ Widgets }, () => ({}));
