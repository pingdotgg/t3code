import { getDb } from "./db";

export async function getLatestPosts(limit = 10) {
  const db = getDb();
  const runtime = db.runtime();

  return runtime.execute(
    db.sql.post
      .select("title", "excerpt")
      .orderBy("createdAt", { direction: "desc" })
      .limit(limit)
      .build(),
  );
}

export async function checkDatabaseReady() {
  const db = getDb();
  const runtime = db.runtime();
  await runtime.execute(db.sql.user.select("id").limit(1).build());
}
