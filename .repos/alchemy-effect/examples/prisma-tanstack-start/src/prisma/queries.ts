import { getDb } from "./db";

export async function getLatestPosts(limit = 10) {
  const db = getDb();
  const runtime = db.runtime();

  return runtime.query(
    db.sql.public.post
      .select("title", "excerpt")
      .orderBy("createdAt", { direction: "desc" })
      .limit(limit)
      .build(),
  );
}

export async function checkDatabaseReady() {
  const db = getDb();
  const runtime = db.runtime();
  await runtime.query(db.sql.public.user.select("id").limit(1).build());
}
