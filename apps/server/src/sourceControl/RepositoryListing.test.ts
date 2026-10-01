import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { parseRepositoryListing, listSourceControlRepositories } from "./RepositoryListing.ts";
import { GitHubCli } from "./GitHubCli.ts";
import { GitLabCli } from "./GitLabCli.ts";
import { AzureDevOpsCli } from "./AzureDevOpsCli.ts";
import { ForgejoCli } from "./ForgejoCli.ts";
import { BitbucketApi } from "./BitbucketApi.ts";

const repository = {
  full_name: "alex/repo",
  html_url: "https://host/alex/repo",
  ssh_url: "git@host:alex/repo.git",
};
const records = {
  github: [repository],
  forgejo: [repository],
  gitlab: [
    {
      path_with_namespace: "group/repo",
      web_url: "https://host/group/repo",
      ssh_url_to_repo: "git@host:group/repo.git",
    },
  ],
  "azure-devops": [
    {
      name: "repo",
      project: { name: "project" },
      webUrl: "https://dev.azure.com/org/project/_git/repo",
      remoteUrl: "https://org@dev.azure.com/org/project/_git/repo",
      sshUrl: "git@ssh.dev.azure.com:v3/org/project/repo",
    },
  ],
  bitbucket: {
    values: [
      {
        full_name: "team/repo",
        links: {
          html: { href: "https://host/team/repo" },
          clone: [{ name: "ssh", href: "git@host:team/repo.git" }],
        },
      },
    ],
    next: "https://host/next",
  },
};

it.each([
  "-cfoo.x@h:y.z=1",
  "-uX@h:y",
  "ssh://-oProxyCommand=x/y",
  "git@-host:repo.git",
  "ssh://-user@host/repo.git",
  "ssh://%2Duser@host/repo.git",
])("rejects unsafe listed remote %s", (sshUrl) => {
  expect(() =>
    parseRepositoryListing("github", JSON.stringify([{ ...repository, ssh_url: sshUrl }])),
  ).toThrow();
});

it.each(["github", "forgejo", "gitlab", "azure-devops", "bitbucket"] as const)(
  "projects %s's native response without private response metadata",
  (provider) => {
    const page = parseRepositoryListing(provider, JSON.stringify(records[provider]));
    expect(page.repositories).toHaveLength(1);
    expect(Object.keys(page.repositories[0]!)).toEqual([
      "provider",
      "nameWithOwner",
      "url",
      "sshUrl",
    ]);
    expect(page.truncated).toBe(provider === "bitbucket");
    if (provider === "azure-devops")
      expect(page.repositories[0]?.url).toBe(records["azure-devops"][0]?.webUrl);
  },
);

it("bounds results honestly and refuses credential-bearing URLs", () => {
  const page = parseRepositoryListing(
    "github",
    JSON.stringify(Array.from({ length: 21 }, () => repository)),
  );
  expect(page.repositories).toHaveLength(20);
  expect(page.truncated).toBe(true);
  expect(() =>
    parseRepositoryListing(
      "github",
      JSON.stringify([{ ...repository, html_url: "https://user:secret@host/repo" }]),
    ),
  ).toThrow();
  expect(() =>
    parseRepositoryListing("github", JSON.stringify([{ ...repository, ssh_url: "ext::command" }])),
  ).toThrow();
});

it.effect(
  "lists through the existing native provider clients without a shell or credential reader",
  () => {
    const calls: string[] = [];
    const output = (provider: keyof typeof records) => ({
      stdout: JSON.stringify(records[provider]),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: ChildProcessSpawner.ExitCode(0),
    });
    const clients = Layer.mergeAll(
      Layer.mock(GitHubCli)({
        execute: (input) => {
          calls.push(input.args.join(" "));
          return Effect.succeed(output("github"));
        },
      }),
      Layer.mock(GitLabCli)({
        execute: (input) => {
          calls.push(input.args.join(" "));
          return Effect.succeed(output("gitlab"));
        },
      }),
      Layer.mock(AzureDevOpsCli)({
        execute: (input) => {
          calls.push(input.args.join(" "));
          return Effect.succeed(output("azure-devops"));
        },
      }),
      Layer.mock(ForgejoCli)({
        api: (input) => {
          calls.push(input.path);
          return Effect.succeed(output("forgejo"));
        },
      }),
      Layer.mock(BitbucketApi)({
        request: (input) => {
          calls.push(input.url);
          return Effect.succeed({ body: JSON.stringify(records.bitbucket), truncated: false });
        },
      }),
    );
    return Effect.gen(function* () {
      for (const provider of [
        "github",
        "gitlab",
        "forgejo",
        "azure-devops",
        "bitbucket",
      ] as const) {
        expect(
          (yield* listSourceControlRepositories({ provider, cwd: "/host" })).repositories,
        ).toHaveLength(1);
      }
      expect(calls).toEqual([
        "api user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=21",
        "api projects?membership=true&order_by=last_activity_at&per_page=21",
        "user/repos?sort=updated&limit=21",
        "repos list --query [:21] --output json",
        "/repositories?role=member&sort=-updated_on&pagelen=21",
      ]);
    }).pipe(Effect.provide(clients));
  },
);
