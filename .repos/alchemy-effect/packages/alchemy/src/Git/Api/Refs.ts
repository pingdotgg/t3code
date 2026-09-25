/**
 * The `refs` group: ref reads and transactional (CAS) writes (DESIGN.md §5).
 *
 * Ref names contain `/`, so the single-ref endpoints address the ref via
 * the `name` query parameter, not a path segment.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  ObjectNotFound,
  Oid,
  ReadOnlyRepo,
  Ref,
  RefConflict,
  RefName,
  RefNotFound,
  RepoNotFound,
  RepoPath,
  PushDenied,
} from "./Schema.ts";

/** Lists refs, optionally filtered by prefix (e.g. `refs/heads/`). */
export const ListRefs = HttpApiEndpoint.get(
  "list",
  "/repos/:owner/:repo/refs",
  {
    params: RepoPath,
    query: Schema.Struct({
      /** Filter by prefix, e.g. `refs/heads/`. */
      prefix: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({
      /** The default branch's full ref name, `null` on an unborn repo. */
      head: Schema.NullOr(Schema.String),
      refs: Schema.Array(Ref),
    }),
    error: [RepoNotFound],
  },
);

/** Reads one ref by full name (`?name=refs/heads/main`). */
export const GetRef = HttpApiEndpoint.get("get", "/repos/:owner/:repo/ref", {
  params: RepoPath,
  query: Schema.Struct({ name: RefName }),
  success: Ref,
  error: [RepoNotFound, RefNotFound],
});

/** Writes one ref with CAS semantics. */
export const UpdateRef = HttpApiEndpoint.put(
  "update",
  "/repos/:owner/:repo/ref",
  {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({
      newOid: Oid,
      /**
       * CAS token: current oid the ref must hold. `null` = the ref must
       * not exist (create). Absent = unconditional write.
       */
      expectedOid: Schema.optional(Schema.NullOr(Oid)),
    }),
    success: Ref,
    error: [
      PushDenied,
      RepoNotFound,
      RefConflict,
      ObjectNotFound,
      ReadOnlyRepo,
    ],
  },
);

/** Deletes one ref with CAS semantics. */
export const RemoveRef = HttpApiEndpoint.delete(
  "remove",
  "/repos/:owner/:repo/ref",
  {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({
      /** CAS token: current oid the ref must hold. Absent = unconditional. */
      expectedOid: Schema.optional(Oid),
    }),
    success: HttpApiSchema.NoContent,
    error: [PushDenied, RepoNotFound, RefNotFound, RefConflict, ReadOnlyRepo],
  },
);

/** The `refs` group, mounted at `/api/v1`. */
export class Refs extends HttpApiGroup.make("refs")
  .add(ListRefs, GetRef, UpdateRef, RemoveRef)
  .prefix("/api/v1") {}
