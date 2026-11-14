import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreateIssue } from "./CreateIssue.ts";
import { createIssueOperation } from "./CreateIssueHttp.ts";

/**
 * Implementation of {@link CreateIssue} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.CreateIssue
 */
export const CreateIssueLocal = Layer.effect(CreateIssue, BindingLocal.make(createIssueOperation));
