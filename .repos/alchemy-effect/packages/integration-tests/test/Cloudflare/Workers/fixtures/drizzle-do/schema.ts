import { defineRelations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
});

export const relations = defineRelations({ users, posts }, (t) => ({
  users: {
    posts: t.many.posts(),
  },
  posts: {
    author: t.one.users({
      from: t.posts.userId,
      to: t.users.id,
    }),
  },
}));
