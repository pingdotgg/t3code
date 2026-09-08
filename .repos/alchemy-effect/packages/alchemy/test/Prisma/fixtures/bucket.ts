// Deep imports keep the Compute bundle lean: the `@/Prisma` barrel pulls in
// the local dev-database machinery (@prisma/dev -> pglite), which balloons
// the bundle and has no business inside a deployed app.
import { Bucket } from "@/Prisma/Bucket.ts";
import { Project } from "@/Prisma/Project.ts";
import * as Effect from "effect/Effect";

/**
 * Project owning the shared bucket. No default database is created — the
 * binding suite only needs Object Store.
 */
export const TestProject = Project("PrismaBucketBindingProject", {
  name: "alchemy-bucket-binding",
  createDatabase: false,
});

/**
 * Shared Prisma Object Store bucket bound by all three binding-test Compute
 * apps (read / write / read-write). Because every app binds this same bucket,
 * a value written through the Write app is observable by the Read app — which
 * is what the test asserts.
 */
export const TestBucket = Effect.gen(function* () {
  const project = yield* TestProject;
  return yield* Bucket("PrismaBucketBindingTestBucket", { project });
});
