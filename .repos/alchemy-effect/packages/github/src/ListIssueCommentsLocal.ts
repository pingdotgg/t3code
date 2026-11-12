import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListIssueComments } from "./ListIssueComments.ts";
import { listIssueCommentsOperation } from "./ListIssueCommentsHttp.ts";

/**
 * Implementation of {@link ListIssueComments} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.ListIssueComments
 */
export const ListIssueCommentsLocal = Layer.effect(
  ListIssueComments,
  BindingLocal.make(listIssueCommentsOperation),
);
