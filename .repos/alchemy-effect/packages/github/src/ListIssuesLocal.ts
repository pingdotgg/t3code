import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListIssues } from "./ListIssues.ts";
import { listIssuesOperation } from "./ListIssuesHttp.ts";

/**
 * Implementation of {@link ListIssues} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.ListIssues
 */
export const ListIssuesLocal = Layer.effect(ListIssues, BindingLocal.make(listIssuesOperation));
