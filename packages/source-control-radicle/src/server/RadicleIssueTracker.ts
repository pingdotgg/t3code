/**
 * Radicle's issue tracker over `rad issue` and `rad cob show`. Issues are keyed by their hex IDs,
 * which `rad` also takes by prefix. Everything is read from the node at once, so the cursor is an
 * offset into the sorted listing.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueComment,
  type IssueState,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type IssueScopeTarget,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import { issueUrl } from "../shared/definition.ts";
import * as RadicleCli from "./RadicleCli.ts";
import type { RadicleIssue } from "./radicleIssueJson.ts";
import { radicleActor, radicleLogin, shortNodeId } from "./radiclePatches.ts";

const KIND = IssueTrackerKind.make("radicle");

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const STATES: ReadonlyArray<IssueState> = [
  { category: "open", name: "open" },
  { category: "closed", name: "solved", closeReason: "completed" },
  { category: "closed", name: "closed" },
];
const STATE_FLAGS: Record<string, string> = {
  open: "--open",
  solved: "--solved",
  closed: "--closed",
};

const REASONS = {
  "missing-cli": "missing-tool",
  unauthenticated: "unauthenticated",
  "not-found": "not-found",
  failed: "failed",
} as const;

const ISSUE_ID = /\b([0-9a-f]{40})\b/u;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

function issueState(issue: RadicleIssue): IssueState {
  if (issue.open) return STATES[0]!;
  return issue.closeReason === "solved" ? STATES[1]! : STATES[2]!;
}

export const make = Effect.gen(function* () {
  const cli = yield* RadicleCli.RadicleCli;

  const fail = (operation: string) => (error: RadicleCli.RadicleCliError) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: REASONS[error.reason],
      detail: error.detail,
      cause: error,
    });

  const target = Effect.fn("RadicleIssueTracker.target")(function* (input: IssueScopeTarget) {
    const repository = yield* cli.repository({ cwd: input.cwd, selector: input.scope });
    const aliases = yield* cli.aliases({ cwd: input.cwd, repository });
    return { repository, aliases };
  });

  const summary = (
    issue: RadicleIssue,
    rid: string,
    aliases: ReadonlyMap<string, string>,
  ): TrackerIssueSummary => ({
    key: issue.id,
    displayKey: issue.id.slice(0, 7),
    title: issue.title,
    url: issueUrl({ rid, issue: issue.id }),
    author: radicleActor(issue.author, aliases),
    state: issueState(issue),
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    closedAt: null,
    assignees: issue.assignees.map((assignee) => radicleActor(assignee, aliases)),
    labels: issue.labels.map((name) => ({ name, color: null })),
    commentCount: issue.comments.length,
  });

  const issueComment = (
    id: string,
    comment: RadicleIssue["comments"][number]["comment"],
    aliases: ReadonlyMap<string, string>,
  ): IssueComment => ({
    id,
    author: radicleActor(comment.author, aliases),
    body: comment.body,
    createdAt: iso(comment.edits[0]?.timestamp ?? 0),
    url: null,
  });

  const radIssue = (operation: string, input: IssueScopeTarget, args: ReadonlyArray<string>) =>
    cli.repository({ cwd: input.cwd, selector: input.scope }).pipe(
      Effect.flatMap((repository) =>
        cli.rad({
          operation,
          cwd: input.cwd,
          args: ["issue", ...args, "--repo", `rad:${repository.rid}`],
          timeoutMs: 60_000,
        }),
      ),
    );

  /**
   * Logins or DIDs, as a client may hold either, to the DIDs `rad issue assign` takes. A login can
   * be an alias or a shortened node ID, so it is matched against every person the node knows.
   */
  const toDids = (
    people: ReadonlyArray<string>,
    known: ReadonlyArray<string>,
    aliases: ReadonlyMap<string, string>,
  ) => {
    const byLogin = new Map(
      [...aliases.keys(), ...known].map((person) => {
        const did = person.startsWith("did:key:") ? person : `did:key:${person}`;
        return [radicleLogin(did, aliases), did] as const;
      }),
    );
    return people.map(
      (person) =>
        byLogin.get(person) ?? (person.startsWith("did:key:") ? person : `did:key:${person}`),
    );
  };

  const tracker: IssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.self(input.cwd).pipe(
        Effect.map((self) => self.alias ?? shortNodeId(self.did)),
        Effect.mapError(fail("getViewer")),
      ),

    listIssues: Effect.fn("RadicleIssueTracker.listIssues")(
      function* (input) {
        const { repository, aliases } = yield* target(input);
        const issues = yield* cli.listIssues({ cwd: input.cwd, repository });
        const login = (person: string) => radicleLogin(person, aliases);
        const query = input.query?.trim().toLowerCase();
        const rows = issues
          .filter((issue) => {
            if (input.state === "open" && !issue.open) return false;
            if (input.state === "closed" && issue.open) return false;
            if (input.involvement === "authored" && login(issue.author) !== input.viewer)
              return false;
            if (
              input.involvement === "assigned" &&
              !issue.assignees.some((assignee) => login(assignee) === input.viewer)
            )
              return false;
            if (
              input.involvement === "mentioned" &&
              ![issue.body, ...issue.comments.map((entry) => entry.comment.body)].some((body) =>
                body.includes(`@${input.viewer}`),
              )
            )
              return false;
            if (input.labels?.some((label) => !issue.labels.includes(label))) return false;
            if (
              input.assignee !== undefined &&
              !issue.assignees.some((assignee) => login(assignee) === input.assignee)
            )
              return false;
            return !query || issue.title.toLowerCase().includes(query);
          })
          .toSorted((left, right) =>
            input.sort === "created"
              ? right.createdAt - left.createdAt
              : right.updatedAt - left.updatedAt,
          );
        const offset = input.cursor === undefined ? 0 : Number(input.cursor) || 0;
        const end = offset + input.limit;
        return {
          items: rows.slice(offset, end).map((issue) => summary(issue, repository.rid, aliases)),
          nextCursor: end < rows.length ? String(end) : null,
        };
      },
      Effect.mapError(fail("listIssues")),
    ),

    getIssue: Effect.fn("RadicleIssueTracker.getIssue")(
      function* (input) {
        const { repository, aliases } = yield* target(input);
        const [issue, project, self] = yield* Effect.all(
          [
            cli.getIssue({ cwd: input.cwd, repository, key: input.key }),
            cli.project({ cwd: input.cwd, repository }),
            cli.self(input.cwd),
          ],
          { concurrency: 3 },
        );
        const canChange =
          project.delegates.includes(self.did) || `did:key:${issue.author}` === self.did;
        return {
          ...summary(issue, repository.rid, aliases),
          body: issue.body,
          viewer: self.alias ?? shortNodeId(self.did),
          viewerPermissions: {
            setState: canChange,
            comment: true,
            edit: canChange,
            labels: canChange,
            assignees: canChange,
          },
          states: STATES,
          comments: issue.comments.map((entry) => issueComment(entry.id, entry.comment, aliases)),
          commentsCursor: null,
          events: [],
          linkedPullRequests: [],
        };
      },
      Effect.mapError(fail("getIssue")),
    ),

    getIssueLink: Effect.fn("RadicleIssueTracker.getIssueLink")(
      function* (input) {
        const { repository } = yield* target(input);
        const issue = yield* cli.getIssue({ cwd: input.cwd, repository, key: input.key });
        return {
          title: issue.title,
          url: issueUrl({ rid: repository.rid, issue: issue.id }),
          displayKey: issue.id.slice(0, 7),
        };
      },
      Effect.mapError(fail("getIssueLink")),
    ),

    // `getIssue` returns the whole conversation.
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),

    create: Effect.fn("RadicleIssueTracker.create")(
      function* (input) {
        const { repository, aliases } = yield* target(input);
        const project = yield* cli.project({ cwd: input.cwd, repository });
        const stdout = yield* radIssue("create", input, [
          "open",
          "--title",
          input.title,
          // `rad issue open` opens an editor unless both are given; an empty description is fine.
          "--description",
          input.body,
          ...input.labels.flatMap((label) => ["--labels", label]),
          ...toDids(input.assignees, project.delegates, aliases).flatMap((did) => [
            "--assignees",
            did,
          ]),
        ]);
        let id = ISSUE_ID.exec(stdout)?.[1];
        if (id === undefined) {
          const self = yield* cli.self(input.cwd);
          const issues = yield* cli.listIssues({ cwd: input.cwd, repository });
          id = issues
            .filter(
              (issue) => issue.title === input.title && `did:key:${issue.author}` === self.did,
            )
            .toSorted((left, right) => right.createdAt - left.createdAt)[0]?.id;
        }
        if (id === undefined) {
          return yield* new RadicleCli.RadicleCliError({
            operation: "create",
            reason: "failed",
            detail: "The issue was opened, but its ID could not be read back.",
          });
        }
        return {
          key: id,
          displayKey: id.slice(0, 7),
          url: issueUrl({ rid: repository.rid, issue: id }),
        };
      },
      Effect.mapError(fail("create")),
    ),

    comment: Effect.fn("RadicleIssueTracker.comment")(
      function* (input) {
        const { repository } = yield* target(input);
        const issue = yield* cli.getIssue({ cwd: input.cwd, repository, key: input.key });
        yield* radIssue("comment", input, ["comment", issue.id, "--message", input.body]);
      },
      Effect.mapError(fail("comment")),
    ),

    update: Effect.fn("RadicleIssueTracker.update")(
      function* (input) {
        const { repository, aliases } = yield* target(input);
        const issue = yield* cli.getIssue({ cwd: input.cwd, repository, key: input.key });
        if (input.title !== undefined || input.body !== undefined) {
          yield* radIssue("update", input, [
            "edit",
            issue.id,
            ...(input.title === undefined ? [] : ["--title", input.title]),
            ...(input.body === undefined ? [] : ["--description", input.body]),
          ]);
        }
        if (input.labels !== undefined) {
          const wanted = new Set(input.labels);
          const add = input.labels.filter((label) => !issue.labels.includes(label));
          const remove = issue.labels.filter((label) => !wanted.has(label));
          if (add.length + remove.length > 0) {
            yield* radIssue("update", input, [
              "label",
              issue.id,
              ...add.flatMap((label) => ["--add", label]),
              ...remove.flatMap((label) => ["--delete", label]),
            ]);
          }
        }
        if (input.assignees !== undefined) {
          const project = yield* cli.project({ cwd: input.cwd, repository });
          const known = [...issue.assignees, ...project.delegates];
          const current = toDids(issue.assignees, known, aliases);
          const wanted = toDids(input.assignees, known, aliases);
          const add = wanted.filter((did) => !current.includes(did));
          const remove = current.filter((did) => !wanted.includes(did));
          if (add.length + remove.length > 0) {
            yield* radIssue("update", input, [
              "assign",
              issue.id,
              ...add.flatMap((did) => ["--add", did]),
              ...remove.flatMap((did) => ["--delete", did]),
            ]);
          }
        }
      },
      Effect.mapError(fail("update")),
    ),

    setState: Effect.fn("RadicleIssueTracker.setState")(
      function* (input) {
        const flag = STATE_FLAGS[input.state];
        if (flag === undefined) {
          return yield* new RadicleCli.RadicleCliError({
            operation: "setState",
            reason: "failed",
            detail: "A Radicle issue is open, solved, or closed.",
          });
        }
        const { repository } = yield* target(input);
        const issue = yield* cli.getIssue({ cwd: input.cwd, repository, key: input.key });
        yield* radIssue("setState", input, ["state", flag, issue.id]);
      },
      Effect.mapError(fail("setState")),
    ),

    // Radicle keeps no list of labels, so the ones its issues carry are what it offers.
    listCandidates: Effect.fn("RadicleIssueTracker.listCandidates")(
      function* (input) {
        const { repository, aliases } = yield* target(input);
        const [issues, project] = yield* Effect.all(
          [
            cli.listIssues({ cwd: input.cwd, repository }),
            cli.project({ cwd: input.cwd, repository }),
          ],
          { concurrency: 2 },
        );
        const labels = [...new Set(issues.flatMap((issue) => issue.labels))].toSorted();
        return {
          labels: labels.map((name) => ({ name, color: null, description: null })),
          assignees: project.delegates.map((did) => ({ ...radicleActor(did, aliases), id: did })),
          truncated: false,
        };
      },
      Effect.mapError(fail("listCandidates")),
    ),
  };

  return tracker;
});
