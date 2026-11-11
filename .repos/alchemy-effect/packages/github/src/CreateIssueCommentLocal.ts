import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreateIssueComment } from "./CreateIssueComment.ts";
import { createIssueCommentOperation } from "./CreateIssueCommentHttp.ts";

/**
 * Implementation of {@link CreateIssueComment} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.CreateIssueComment
 */
export const CreateIssueCommentLocal = Layer.effect(
  CreateIssueComment,
  BindingLocal.make(createIssueCommentOperation),
);
