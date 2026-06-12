import { defineRelations } from "drizzle-orm";
import { int, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

export const Users = mysqlTable("users", {
  id: int("id").primaryKey().autoincrement(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type User = typeof Users.$inferSelect;

export const Posts = mysqlTable("posts", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: varchar("body", { length: 4096 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Post = typeof Posts.$inferSelect;

export const relations = defineRelations({ Users, Posts }, (t) => ({
  Users: {
    posts: t.many.Posts(),
  },
  Posts: {
    user: t.one.Users({
      from: t.Posts.userId,
      to: t.Users.id,
    }),
  },
}));
