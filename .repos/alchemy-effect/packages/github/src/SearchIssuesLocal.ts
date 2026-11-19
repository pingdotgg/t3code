import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { SearchIssues } from "./SearchIssues.ts";
import { searchIssuesOperation } from "./SearchIssuesHttp.ts";

/**
 * Implementation of {@link SearchIssues} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Issue
 * @provides GitHub.SearchIssues
 */
export const SearchIssuesLocal = Layer.effect(
  SearchIssues,
  BindingLocal.make(searchIssuesOperation),
);
