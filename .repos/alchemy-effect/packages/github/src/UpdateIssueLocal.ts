import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { UpdateIssue } from "./UpdateIssue.ts";
import { updateIssueOperation } from "./UpdateIssueHttp.ts";

/**
 * Implementation of {@link UpdateIssue} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.UpdateIssue
 */
export const UpdateIssueLocal = Layer.effect(UpdateIssue, BindingLocal.make(updateIssueOperation));
