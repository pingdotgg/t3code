import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface ListApplicationRevisionsRequest extends Omit<
  SVC.ListApplicationRevisionsInput,
  "applicationName"
> {}

/**
 * Runtime binding for `codedeploy:ListApplicationRevisions` — lists the
 * revisions registered with the bound application (optionally filtered by
 * S3 bucket/prefix or deployed state).
 * @binding
 * @section Managing Revisions
 * @example List Registered Revisions
 * ```typescript
 * const listApplicationRevisions =
 *   yield* AWS.CodeDeploy.ListApplicationRevisions(app);
 *
 * const { revisions } = yield* listApplicationRevisions({
 *   sortBy: "registerTime",
 *   sortOrder: "descending",
 * });
 * ```
 */
export interface ListApplicationRevisions extends Binding.Service<
  ListApplicationRevisions,
  "AWS.CodeDeploy.ListApplicationRevisions",
  <P extends Application>(
    application: P,
  ) => Effect.Effect<
    (
      request?: ListApplicationRevisionsRequest,
    ) => Effect.Effect<
      SVC.ListApplicationRevisionsOutput,
      SVC.ListApplicationRevisionsError
    >
  >
> {}
export const ListApplicationRevisions =
  Binding.Service<ListApplicationRevisions>(
    "AWS.CodeDeploy.ListApplicationRevisions",
  );
