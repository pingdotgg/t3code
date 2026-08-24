import * as Lambda from "@/AWS/Lambda";
import * as RolesAnywhere from "@/AWS/RolesAnywhere";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent subject id — drives the typed error path for
// GetSubject (proving the IAM grant + typed union; an IAM gap would surface
// AccessDeniedException instead).
const NONEXISTENT_SUBJECT_ID = "00000000-0000-0000-0000-000000000000";

export class RolesAnywhereTestFunction extends Lambda.Function<Lambda.Function>()(
  "RolesAnywhereTestFunction",
) {}

export default RolesAnywhereTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // --- account-level bindings (subjects are the audit records of every
    // certificate identity that authenticated via Roles Anywhere) ---
    const getSubject = yield* RolesAnywhere.GetSubject();
    const listSubjects = yield* RolesAnywhere.ListSubjects();

    const bound = { getSubject, listSubjects };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/subjects") {
          // The testing account has no external workloads authenticating via
          // Roles Anywhere, so an empty list still proves the
          // rolesanywhere:ListSubjects grant end-to-end.
          const result = yield* listSubjects().pipe(
            Effect.map((r) => ({
              ok: true as const,
              count: r.subjects?.length ?? 0,
            })),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/subject-not-found") {
          const tag = yield* getSubject({
            subjectId: NONEXISTENT_SUBJECT_ID,
          }).pipe(
            Effect.map((r) =>
              r.subject === undefined ? "NoSubject" : "Found",
            ),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        RolesAnywhere.GetSubjectHttp,
        RolesAnywhere.ListSubjectsHttp,
      ),
    ),
  ),
);
