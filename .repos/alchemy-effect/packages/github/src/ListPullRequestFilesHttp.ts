import * as Pulls from "@distilled.cloud/github/pulls";
import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { ListPullRequestFiles, type ListPullRequestFilesRequest } from "./ListPullRequestFiles.ts";

export const listPullRequestFilesOperation = BindingHttp.operation(
  "pulls.listFiles",
  (repo) => (request: ListPullRequestFilesRequest) =>
    Pulls.listFiles({ owner: repo.owner, repo: repo.repository, ...request }),
);

/**
 * Token-backed implementation of {@link ListPullRequestFiles}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Pull Request
 * @provides GitHub.ListPullRequestFiles
 */
export const ListPullRequestFilesHttp = Layer.effect(
  ListPullRequestFiles,
  BindingHttp.make(listPullRequestFilesOperation),
);
