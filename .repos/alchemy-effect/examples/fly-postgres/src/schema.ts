import { defineRelations } from "drizzle-orm";
import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const Users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type User = typeof Users.$inferSelect;

export const Posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => Users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
