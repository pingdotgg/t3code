import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { GetIssue } from "./GetIssue.ts";
import { getIssueOperation } from "./GetIssueHttp.ts";

/**
 * Implementation of {@link GetIssue} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.GetIssue
 */
export const GetIssueLocal = Layer.effect(GetIssue, BindingLocal.make(getIssueOperation));
