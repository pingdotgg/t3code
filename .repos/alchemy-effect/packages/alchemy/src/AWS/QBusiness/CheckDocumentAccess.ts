import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `CheckDocumentAccess` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface CheckDocumentAccessRequest extends Omit<
  qbusiness.CheckDocumentAccessRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `CheckDocumentAccess` operation (IAM action
 * `qbusiness:CheckDocumentAccess`), scoped to one {@link Index}.
 *
 * Checks whether a specific user can access a document, returning
 * the user's groups/aliases and the document's ACL evaluation.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.CheckDocumentAccessHttp)`.
 *
 * @binding
 * @section Document Ingestion
 * @example Check a User's Document Access
 * ```typescript
 * const checkAccess = yield* AWS.QBusiness.CheckDocumentAccess(index);
 *
 * const { hasAccess } = yield* checkAccess({
 *   userId: "user@example.com",
 *   documentId: "welcome",
 * });
 * ```
 */
export interface CheckDocumentAccess extends Binding.Service<
  CheckDocumentAccess,
  "AWS.QBusiness.CheckDocumentAccess",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: CheckDocumentAccessRequest,
    ) => Effect.Effect<
      qbusiness.CheckDocumentAccessResponse,
      qbusiness.CheckDocumentAccessError
    >
  >
> {}
export const CheckDocumentAccess = Binding.Service<CheckDocumentAccess>(
  "AWS.QBusiness.CheckDocumentAccess",
);
