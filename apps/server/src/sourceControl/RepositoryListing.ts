import {
  SourceControlRepositoryError,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GitHubCli } from "./GitHubCli.ts";
import { GitLabCli } from "./GitLabCli.ts";
import { ForgejoCli } from "./ForgejoCli.ts";
import { AzureDevOpsCli } from "./AzureDevOpsCli.ts";
import { BitbucketApi } from "./BitbucketApi.ts";
import { isSafeRepositoryRemote } from "./remoteValidation.ts";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const forgeRepository = Schema.Struct({ full_name: text, html_url: text, ssh_url: text });
const gitlabRepository = Schema.Struct({
  path_with_namespace: text,
  web_url: text,
  ssh_url_to_repo: text,
});
const azureRepository = Schema.Struct({
  name: text,
  project: Schema.Struct({ name: text }),
  webUrl: text,
  sshUrl: text,
});
const bitbucketRepository = Schema.Struct({
  full_name: text,
  links: Schema.Struct({
    html: Schema.Struct({ href: text }),
    clone: Schema.Array(Schema.Struct({ name: text, href: text })),
  }),
});
const decodeForgeRepositories = Schema.decodeUnknownSync(Schema.Array(forgeRepository));
const decodeGitlabRepositories = Schema.decodeUnknownSync(Schema.Array(gitlabRepository));
const decodeAzureRepositories = Schema.decodeUnknownSync(Schema.Array(azureRepository));
const decodeBitbucketPage = Schema.decodeUnknownSync(
  Schema.Struct({
    values: Schema.Array(bitbucketRepository),
    next: Schema.optional(Schema.String),
  }),
);
const fail = (provider: SourceControlProviderKind) =>
  new SourceControlRepositoryError({
    operation: "listRepositories",
    provider,
    detail: "Repository listing is unavailable for this provider. Check Source Control settings.",
  });
type SourceControlKind = Exclude<SourceControlProviderKind, "unknown">;
type RepositoryList = {
  readonly repositories: readonly SourceControlRepositoryInfo[];
  readonly truncated: boolean;
};

export function parseRepositoryListing(provider: SourceControlKind, raw: string): RepositoryList {
  const data: unknown = JSON.parse(raw);
  let repositories: SourceControlRepositoryInfo[];
  let hasNext = false;
  switch (provider) {
    case "github":
    case "forgejo":
      repositories = decodeForgeRepositories(data).map((repository) => ({
        provider,
        nameWithOwner: repository.full_name,
        url: repository.html_url,
        sshUrl: repository.ssh_url,
      }));
      break;
    case "gitlab":
      repositories = decodeGitlabRepositories(data).map((repository) => ({
        provider,
        nameWithOwner: repository.path_with_namespace,
        url: repository.web_url,
        sshUrl: repository.ssh_url_to_repo,
      }));
      break;
    case "azure-devops":
      repositories = decodeAzureRepositories(data).map((repository) => ({
        provider,
        nameWithOwner: `${repository.project.name}/${repository.name}`,
        url: repository.webUrl,
        sshUrl: repository.sshUrl,
      }));
      break;
    case "bitbucket": {
      const page = decodeBitbucketPage(data);
      hasNext = page.next !== undefined;
      repositories = page.values.map((repository) => ({
        provider,
        nameWithOwner: repository.full_name,
        url: repository.links.html.href,
        sshUrl:
          repository.links.clone.find((clone) => clone.name === "ssh")?.href ??
          repository.links.html.href,
      }));
      break;
    }
  }
  const bounded: SourceControlRepositoryInfo[] = [];
  let bytes = 0;
  for (const repository of repositories) {
    for (const remote of [repository.url, repository.sshUrl]) {
      if (!isSafeRepositoryRemote(remote, true)) throw fail(provider);
    }
    const size = new TextEncoder().encode(JSON.stringify(repository)).byteLength;
    if (bounded.length === 20 || bytes + size > 48 * 1024) break;
    bounded.push(repository);
    bytes += size;
  }
  return {
    repositories: bounded,
    truncated: hasNext || repositories.length >= 21 || bounded.length < repositories.length,
  };
}

export const listSourceControlRepositories = Effect.fn("SourceControl.listRepositories")(
  function* (input: { readonly provider: SourceControlKind; readonly cwd: string }) {
    let raw: string;
    const options = { cwd: input.cwd, timeoutMs: 15_000, maxOutputBytes: 256 * 1024 };
    switch (input.provider) {
      case "github":
        raw = (yield* (yield* GitHubCli).execute({
          ...options,
          args: [
            "api",
            "user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=21",
          ],
        })).stdout;
        break;
      case "gitlab":
        raw = (yield* (yield* GitLabCli).execute({
          ...options,
          args: ["api", "projects?membership=true&order_by=last_activity_at&per_page=21"],
        })).stdout;
        break;
      case "forgejo":
        raw = (yield* (yield* ForgejoCli).api({
          cwd: input.cwd,
          path: "user/repos?sort=updated&limit=21",
        })).stdout;
        break;
      case "azure-devops":
        raw = (yield* (yield* AzureDevOpsCli).execute({
          ...options,
          args: ["repos", "list", "--query", "[:21]", "--output", "json"],
        })).stdout;
        break;
      case "bitbucket": {
        const response = yield* (yield* BitbucketApi).request({
          method: "GET",
          url: "/repositories?role=member&sort=-updated_on&pagelen=21",
          maxBytes: 256 * 1024,
        });
        if (response.truncated) return yield* fail(input.provider);
        raw = response.body;
        break;
      }
    }
    return yield* Effect.try({
      try: () => parseRepositoryListing(input.provider, raw),
      catch: () => fail(input.provider),
    });
  },
  Effect.mapError(() => fail("unknown")),
);
