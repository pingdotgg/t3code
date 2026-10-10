import "dotenv/config";
import { closeDb, getDb } from "../src/prisma/db";

const seedUsers = [
  {
    email: "alice@example.com",
    name: "Alice",
    posts: [
      {
        title: "Deploying TanStack Start with Alchemy",
        excerpt: "One stack owns Prisma Postgres, Prisma Compute, and app env.",
      },
      {
        title: "Local dev without cloud credentials",
        excerpt: "alchemy dev starts @prisma/dev and passes DATABASE_URL in.",
      },
    ],
  },
  {
    email: "bob@example.com",
    name: "Bob",
    posts: [
      {
        title: "Prisma Next query helpers",
        excerpt: "The route loader reads through src/prisma/queries.ts.",
      },
    ],
  },
] as const;

async function main() {
  const db = getDb();
  const runtime = db.runtime();

  for (const user of seedUsers) {
    const existing = await runtime.execute(
      db.sql.user
        .select("id", "email")
        .where((fields, fns) => fns.eq(fields.email, user.email))
        .limit(1)
        .build(),
    );

    const existingUser = existing[0];
    if (existingUser) {
      await runtime.execute(
        db.sql.post
          .delete()
          .where((fields, fns) => fns.eq(fields.userId, existingUser.id))
          .build(),
      );
      await runtime.execute(
        db.sql.user
          .delete()
          .where((fields, fns) => fns.eq(fields.id, existingUser.id))
          .build(),
      );
    }

    const created = await runtime.execute(
      db.sql.user
        .insert({
          email: user.email,
          name: user.name,
          createdAt: new Date(),
        })
        .returning("id", "email")
        .build(),
    );

    const createdUser = created[0];
    if (!createdUser) {
      throw new Error(`Failed to seed ${user.email}`);
    }

    for (const post of user.posts) {
      await runtime.execute(
        db.sql.post
          .insert({
            title: post.title,
            excerpt: post.excerpt,
            userId: createdUser.id,
            createdAt: new Date(),
          })
          .build(),
      );
    }
  }

  console.log(`Seeded ${seedUsers.length} users.`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
