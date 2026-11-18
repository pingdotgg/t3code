import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListPullRequestFiles } from "./ListPullRequestFiles.ts";
import { listPullRequestFilesOperation } from "./ListPullRequestFilesHttp.ts";

/**
 * Implementation of {@link ListPullRequestFiles} with the provider's current credentials.
 * Provide it on an `Action` or another deploy-time Effect.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequestFiles
 */
export const ListPullRequestFilesLocal = Layer.effect(
  ListPullRequestFiles,
  BindingLocal.make(listPullRequestFilesOperation),
);
