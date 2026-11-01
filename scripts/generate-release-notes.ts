#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Release notes cover web, desktop, and server. Mobile ships its own store notes.
const MOBILE_SCOPES = new Set(["mobile", "android", "ios"]);
const COMMIT_SCOPES = /^[a-z]+\(([^)]*)\)!?:/i;
const PULL_REQUEST_NUMBER = /\(#(\d+)\)$/;
const PULL_REQUEST_BODY_LIMIT = 300;
const SUMMARY_MODEL = "gpt-6.1-terra";

const SUMMARY_INSTRUCTIONS = `You write release notes for T3 Code, a GUI for coding agents (web and desktop apps backed by a server; providers like Codex, Claude, Cursor, OpenCode).

These notes cover the web app, desktop app, and server only. The mobile app has its own release notes, so leave out anything only about mobile, iOS, or Android.

You get the commit subjects merged since the last release, oldest first. Most end with a PR number like (#1234). Each commit shows lines added and removed and files changed, then a trimmed PR description on the next line starting with ">". Use the descriptions to understand what changed for users and why it matters. Line counts hint at size, but a small change can still matter most.

Output Markdown in exactly this shape and nothing else:

## Highlights
Up to 4 short sentences. Name only the new features a user would care about most. If no new feature matters to users, write one sentence about the most important fix. Each feature gets a few words that make the benefit clear, not a description of how it works or where the button is.

## Fixes
- Up to 10 bullets, one fix each, under 10 words, ending with the PR number like (#123). Fewer is fine. Never pad.
- Each bullet names what was broken and says it works now. A user who hit the bug should recognize it.
- Only list fixes from fix commits. New abilities go in Highlights or nowhere. Say "again" only if the commit says it.

How to write:
- Pick only significant, user-facing changes. Leave out visual polish (focus rings, spacing, colors), layout tweaks, refactors, tests, CI, build, docs, deps, internal tooling, and performance or efficiency work a user would not feel.
- Include Labs and beta features, with "(beta)" after the feature. Leave out work marked internal testing or dev-only.
- Describe each feature as it is at the end of the range. If a beta feature became standard later in the range, it is not beta.
- Say what the user gets, as short as possible. Cut details, conditions, and mechanics.
- No defaults or rollout state ("on by default", "now available", "behind a flag").
- For lists of file types or formats, use common extensions: "previews for .docx, .ttf, .sqlite, .zip and more".
- No internal names, env vars, file paths, or code terms.
- No em dashes. No hype words. Do not invent anything that is not in the input.

Examples of the tone:
- Bad: "Cmd+K now finds the right thread first, and it searches message text too." Good: "Much better Cmd+K search."
- Bad: "You can share a thread with a guest who watches it live and sends messages that you approve." Good: "Share threads with guests, safely."
- Bad: "Triage issues from the command palette." Good: "Fix and debug T3 Code itself with a new 'triage' command."
- Bad: "Settings and Usage open as large modals over your thread." Good: leave it out.
- Bad: "Cmd/Ctrl+W closes tabs safely (#25860)" Good: "Cmd/Ctrl+W no longer closes the whole window (#25860)"`;

class EmptyReleaseRangeError extends Schema.TaggedError<EmptyReleaseRangeError>()(
  "EmptyReleaseRangeError",
  { range: Schema.String },
) {}

interface ReleaseCommit {
  readonly subject: string;
  readonly authorName: string;
}

const PullRequest = Schema.Struct({
  body: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  author: Schema.NullOr(
    Schema.Struct({
      __typename: Schema.String,
      login: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type PullRequest = typeof PullRequest.Type;

const PullRequestQueryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Record(Schema.String, Schema.NullOr(PullRequest)),
  }),
});

const GeneratedNotes = Schema.Struct({ body: Schema.String });

const SummaryResponse = Schema.Struct({
  status: Schema.String,
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
  ),
});

const pullRequestNumber = (subject: string) => {
  const match = PULL_REQUEST_NUMBER.exec(subject);
  return match ? Number(match[1]) : undefined;
};

/** Drops a commit only when every scope is mobile, so `fix(web,mobile)` stays. */
export function isReleaseNoteCommit(commit: ReleaseCommit): boolean {
  const scopes = COMMIT_SCOPES.exec(commit.subject)?.[1]?.split(",");
  return !scopes?.every((scope) => MOBILE_SCOPES.has(scope.trim().toLowerCase()));
}

/** Keeps the prose of a PR body: no images, tables, headings, HTML, or verification sections. */
function trimPullRequestBody(body: string, limit = PULL_REQUEST_BODY_LIMIT): string {
  const [prose = ""] = body.split(/\n#+\s*(?:Verification|Council|Test|Testing|Screenshots)\b/i);
  const text = prose
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*[!|#<]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildSummaryInput(
  commits: ReadonlyArray<ReleaseCommit>,
  pullRequests: ReadonlyMap<number, PullRequest>,
): string {
  return commits
    .flatMap(({ subject }) => {
      const number = pullRequestNumber(subject);
      const pullRequest = number === undefined ? undefined : pullRequests.get(number);
      if (!pullRequest) return [subject];
      const line = `${subject} [+${pullRequest.additions} -${pullRequest.deletions}, ${pullRequest.changedFiles} files]`;
      const body = trimPullRequestBody(pullRequest.body);
      return body ? [line, `  > ${body}`] : [line];
    })
    .join("\n");
}

/** PR authors without bots, plus authors of direct pushes who have no PR in the range. */
export function countContributors(
  commits: ReadonlyArray<ReleaseCommit>,
  pullRequests: ReadonlyMap<number, PullRequest>,
): number {
  const people = new Set<string>();
  // A PR's squash commit carries its author's git name, which may differ from the profile name.
  const prAuthorNames = new Set<string>();
  const directAuthors: string[] = [];
  for (const commit of commits) {
    const number = pullRequestNumber(commit.subject);
    const author = number === undefined ? undefined : pullRequests.get(number)?.author;
    if (!author) {
      directAuthors.push(commit.authorName);
      continue;
    }
    if (author.__typename === "Bot" || author.login.endsWith("[bot]")) continue;
    people.add(author.login);
    prAuthorNames.add(commit.authorName);
    if (author.name) prAuthorNames.add(author.name);
  }
  for (const name of directAuthors) {
    if (!name.endsWith("[bot]") && !prAuthorNames.has(name)) people.add(name);
  }
  return people.size;
}

/** No date here: the app shows how long ago a release shipped, and GitHub shows the date. */
function buildReleaseHeader(version: string, changes: number, contributors: number): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return `**v${version.replace(/^v/, "")}** · ${plural(changes, "change")} from ${plural(contributors, "contributor")}`;
}

/** The summary leads; GitHub's full list folds under it. Clients cut the body at `<details>`. */
function assembleReleaseNotes(header: string, summary: string, fullChangelog: string): string {
  return `${header}\n\n${summary.trim()}\n\n<details>\n<summary>Full changelog</summary>\n\n${fullChangelog.trim()}\n\n</details>\n`;
}

const run = Effect.fn("generateReleaseNotes.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args));
});

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const readCommits = Effect.fn("generateReleaseNotes.readCommits")(function* (
  previousTag: string,
  ref: string,
) {
  const log = yield* run("git", [
    "log",
    "--reverse",
    "--format=%s%x1f%an",
    `${previousTag}..${ref}`,
  ]);
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line): ReleaseCommit => {
      const [subject = "", authorName = ""] = line.split("\x1f");
      return { subject, authorName };
    });
});

const readPullRequests = Effect.fn("generateReleaseNotes.readPullRequests")(function* (
  repository: string,
  numbers: ReadonlyArray<number>,
) {
  const [owner, name] = repository.split("/");
  const pullRequests = new Map<number, PullRequest>();
  for (let start = 0; start < numbers.length; start += 100) {
    const fields = numbers
      .slice(start, start + 100)
      .map(
        (number) =>
          `pr${number}: pullRequest(number: ${number}) { body additions deletions changedFiles author { __typename login ... on User { name } } }`,
      )
      .join("\n");
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const response = yield* decodeJson(PullRequestQueryResponse)(
      yield* run("gh", [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
      ]),
    );
    for (const [alias, pullRequest] of Object.entries(response.data.repository)) {
      if (pullRequest) pullRequests.set(Number(alias.slice(2)), pullRequest);
    }
  }
  return pullRequests;
});

const readFullChangelog = Effect.fn("generateReleaseNotes.readFullChangelog")(function* (options: {
  readonly repository: string;
  readonly tag: string;
  readonly ref: string;
  readonly previousTag: string;
}) {
  const response = yield* run("gh", [
    "api",
    `repos/${options.repository}/releases/generate-notes`,
    "-f",
    `tag_name=${options.tag}`,
    "-f",
    `target_commitish=${options.ref}`,
    "-f",
    `previous_tag_name=${options.previousTag}`,
  ]);
  return (yield* decodeJson(GeneratedNotes)(response)).body;
});

export function summaryText(response: typeof SummaryResponse.Type): Option.Option<string> {
  // An incomplete response can carry partial text; publishing it would cut the notes short.
  if (response.status !== "completed") return Option.none();
  const text = response.output
    .flatMap((item) => item.content ?? [])
    .flatMap((part) => (part.type === "output_text" && part.text ? [part.text] : []))
    .join("")
    .trim();
  return text === "" ? Option.none() : Option.some(text);
}

const summarize = Effect.fn("generateReleaseNotes.summarize")(function* (input: string) {
  const apiKey = yield* Config.Redacted("OPENAI_API_KEY");
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post("https://api.openai.com/v1/responses").pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.bodyJson({
      model: SUMMARY_MODEL,
      reasoning: { effort: "low" },
      instructions: SUMMARY_INSTRUCTIONS,
      input: `Commits:\n${input}`,
    }),
    Effect.flatMap(httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(SummaryResponse)),
    Effect.timeout("3 minutes"),
  );
  yield* Effect.logInfo("release summary generated").pipe(
    Effect.annotateLogs({
      model: SUMMARY_MODEL,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }),
  );
  return summaryText(response);
});

const command = Command.make(
  "generate-release-notes",
  {
    repository: Flag.String("repository").pipe(Flag.withDescription("GitHub owner/name.")),
    tag: Flag.String("tag").pipe(Flag.withDescription("Tag being released.")),
    ref: Flag.String("ref").pipe(Flag.withDescription("Commit being released.")),
    previousTag: Flag.String("previous-tag").pipe(Flag.withDescription("Previous release tag.")),
    version: Flag.String("version").pipe(Flag.withDescription("Version shown in the header.")),
    output: Flag.String("output").pipe(Flag.withDescription("File to write the notes to.")),
  },
  ({ repository, tag, ref, previousTag, version, output }) =>
    Effect.gen(function* () {
      // The header counts every commit in the range; the summary skips mobile-only work.
      const allCommits = yield* readCommits(previousTag, ref);
      // The spawner ignores exit codes, so a failed git log shows up as an empty range.
      if (allCommits.length === 0) {
        return yield* new EmptyReleaseRangeError({ range: `${previousTag}..${ref}` });
      }
      const commits = allCommits.filter(isReleaseNoteCommit);
      const numbers = [
        ...new Set(allCommits.flatMap(({ subject }) => pullRequestNumber(subject) ?? [])),
      ];
      const [pullRequests, fullChangelog] = yield* Effect.all(
        [
          readPullRequests(repository, numbers),
          readFullChangelog({ repository, tag, ref, previousTag }),
        ],
        { concurrency: "unbounded" },
      );
      const header = buildReleaseHeader(
        version,
        allCommits.length,
        countContributors(allCommits, pullRequests),
      );
      // With no summary, write nothing: the release falls back to GitHub's generated notes.
      const summary =
        commits.length === 0
          ? Option.none<string>()
          : yield* summarize(buildSummaryInput(commits, pullRequests));
      if (Option.isNone(summary)) {
        return yield* Effect.logWarning("no release summary, leaving GitHub's notes in place");
      }
      const fs = yield* FileSystem.FileSystem;
      // Publish uses the file when it exists, so a partial write must never land at `output`.
      yield* fs.writeFileString(
        `${output}.tmp`,
        assembleReleaseNotes(header, summary.value, fullChangelog),
      );
      yield* fs.rename(`${output}.tmp`, output);
      yield* Effect.logInfo("release notes written").pipe(
        Effect.annotateLogs({ output, commits: commits.length }),
      );
    }),
).pipe(
  Command.withDescription("Write release notes with a model summary over GitHub's full list."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
