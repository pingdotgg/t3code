import { defineContract } from "@/Prisma/ORM/index.ts";

export const contract = defineContract(
  { extensions: {}, foreignKeyDefaults: { constraint: true, index: true } },
  ({ field, model, rel }) => {
    const User = model("User", {
      fields: {
        id: field
          .int()
          .id()
          .default({ kind: "function", expression: "autoincrement()" }),
        email: field.text().unique(),
        name: field.text().optional(),
      },
    }).sql({ table: "user" });
    const Post = model("Post", {
      fields: {
        id: field
          .int()
          .id()
          .default({ kind: "function", expression: "autoincrement()" }),
        title: field.text(),
        authorId: field.int(),
      },
      relations: {
        author: rel.belongsTo(User, { from: "authorId", to: "id" }).sql({
          fk: { constraint: true, index: true },
        }),
      },
    }).sql({ table: "post" });
    return {
      models: {
        User: User.relations({ posts: rel.hasMany(Post, { by: "authorId" }) }),
        Post,
      },
    };
  },
);
