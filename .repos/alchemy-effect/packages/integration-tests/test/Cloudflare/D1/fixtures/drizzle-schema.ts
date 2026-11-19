import { defineRelations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const Users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
});
export type User = typeof Users.$inferSelect;

export const Posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => Users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
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
