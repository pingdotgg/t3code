import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as RadicleCli from "./RadicleCli.ts";

export const RID = "zTestRepo123456789abcdefGHJKm";
export const AUTHOR = "z6MkAuthor1111111111111111111111111111111111111";
export const VIEWER = "z6MkViewer2222222222222222222222222222222222222";
export const PATCH = "57045d7f5e43f0bc09a18504970d2993b0c16edc";
export const REVISION_2 = "aaaa000000000000000000000000000000000002";
export const COMMENT = "126a5fd3dcd8919735fac801f4da3ca773eab291";
export const REPLY = "5ac7692fd7910331bc68fff4341631d116056a01";
export const ISSUE = "854b7c3ee77fc372d04dacb03cbb76f6249bb20c";
export const ISSUE_COMMENT = "9999000000000000000000000000000000000001";

const edit = (author: string, timestamp: number, body: string) => ({
  author,
  timestamp,
  body,
  embeds: [],
});

/** An issue as `rad cob show` printed it on Radicle 1.10.3, with a comment added. */
function issueCob() {
  return {
    assignees: [`did:key:${VIEWER}`],
    title: "Sandbox: sample issue",
    state: { status: "open" },
    labels: ["test"],
    thread: {
      comments: {
        [ISSUE]: {
          author: AUTHOR,
          reactions: [],
          resolved: false,
          body: "An open issue.",
          edits: [edit(AUTHOR, 1_000, "An open issue.")],
        },
        [ISSUE_COMMENT]: {
          author: VIEWER,
          reactions: [],
          resolved: false,
          body: "A comment",
          edits: [edit(VIEWER, 2_000, "A comment")],
        },
      },
      timeline: [ISSUE, ISSUE_COMMENT],
    },
  };
}

/** A patch as `rad cob show` printed it on Radicle 1.10.3, with a second revision added. */
function patchCob(options?: { readonly status?: string }) {
  return {
    title: "docs: add a usage section",
    author: { id: `did:key:${AUTHOR}` },
    state: { status: options?.status ?? "open" },
    target: "delegates",
    labels: [],
    assignees: [],
    merges: {},
    reviews: {},
    timeline: [PATCH, REVISION_2],
    revisions: {
      [PATCH]: {
        id: PATCH,
        author: { id: `did:key:${AUTHOR}` },
        description: [edit(AUTHOR, 1_000, "First"), edit(AUTHOR, 1_500, "The description")],
        base: "0d620edd304125a11123a08352009499874cb617",
        oid: "faa1ac95fa90bf649c4655b1a8a26edf9d2fa4da",
        discussion: {
          comments: {
            [COMMENT]: {
              author: VIEWER,
              reactions: [],
              resolved: false,
              body: "A comment",
              edits: [edit(VIEWER, 2_000, "A comment")],
            },
            [REPLY]: {
              author: AUTHOR,
              replyTo: COMMENT,
              reactions: [],
              resolved: false,
              body: "A reply",
              edits: [edit(AUTHOR, 3_000, "A reply")],
            },
          },
          timeline: [COMMENT, REPLY],
        },
        reviews: {},
        timestamp: 1_000,
        resolves: [],
        reactions: [],
      },
      [REVISION_2]: {
        id: REVISION_2,
        author: { id: `did:key:${AUTHOR}` },
        description: [edit(AUTHOR, 4_000, "")],
        base: "0d620edd304125a11123a08352009499874cb617",
        oid: "bbbb000000000000000000000000000000000002",
        discussion: { comments: {}, timeline: [] },
        reviews: {
          [VIEWER]: {
            id: "7d53efe1ce9a9a454545cf64f720b3814d3c80e3",
            author: { id: `did:key:${VIEWER}` },
            verdict: "accept",
            summary: [edit(VIEWER, 5_000, "Looks good")],
            comments: { comments: {}, timeline: [] },
            labels: [],
            timestamp: 5_000,
          },
        },
        timestamp: 4_000,
        resolves: [],
        reactions: [],
      },
    },
  };
}

export type Run = SourceControlHost.SourceControlProcessInput;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A node with one repository and one patch. `answer` may take a command first; anything neither
 * handles fails the test, so each test names the commands it expects beyond reading.
 */
export function radicleLayer(options: {
  readonly runs: Array<Run>;
  readonly delegates?: ReadonlyArray<string>;
  readonly status?: string;
  readonly answer?: (input: Run) => string | undefined;
  readonly git?: TestSourceControlHost.TestSourceControlHostOptions["git"];
  /** The node's alias, or null for a node that has none. */
  readonly viewerAlias?: string | null;
  /** Repository IDs the node's storage holds. */
  readonly storage?: ReadonlyArray<string>;
}) {
  const out = (stdout: string, exitCode = 0) =>
    Effect.succeed(
      TestSourceControlHost.processOutput(stdout, {
        exitCode: ChildProcessSpawner.ExitCode(exitCode),
      }),
    );
  const host = TestSourceControlHost.layer({
    ...(options.git ? { git: options.git } : {}),
    process: {
      run: Effect.fn("RadicleTestFixture.run")(function* (input) {
        options.runs.push(input);
        const custom = options.answer?.(input);
        if (custom !== undefined) return yield* out(custom);
        const args = (input.args[0] === "--git-dir" ? input.args.slice(2) : input.args).join(" ");
        if (input.command === "rad") {
          if (args === ".") return yield* out(`rad:${RID}\n`);
          if (args === "self --did") return yield* out(`did:key:${VIEWER}\n`);
          if (args === "self --alias")
            return yield* out(
              `${options.viewerAlias === undefined ? "viewer@bridge" : (options.viewerAlias ?? "")}\n`,
            );
          if (args === "self --home") return yield* out("/home/test/.radicle\n");
          if (args.endsWith("--payload"))
            return yield* out(
              encodeJson({
                "xyz.radicle.project": { defaultBranch: "main", name: "sandbox", description: "" },
              }),
            );
          if (args.endsWith("--delegates"))
            return yield* out(
              (options.delegates ?? [AUTHOR])
                .map((nid) => `did:key:${nid}${nid === AUTHOR ? " (author@laptop)" : ""}`)
                .join("\n"),
            );
          if (input.args[0] === "patch") return yield* out("");
          if (args.startsWith("cob") && args.includes("xyz.radicle.issue"))
            return yield* out(
              args.startsWith("cob list") ? `${ISSUE}\n` : `${encodeJson(issueCob())}\n`,
            );
          if (input.args[0] === "issue") return yield* out(`Issue ${ISSUE}\n`);
          if (args.startsWith("cob list")) return yield* out(`${PATCH}\n`);
          if (args.startsWith("cob show"))
            return yield* out(`${encodeJson(patchCob({ status: options.status ?? "open" }))}\n`);
        }
        if (input.command === "git") {
          if (args === "remote") return yield* out("rad\n");
          if (args.startsWith("diff --shortstat"))
            return yield* out(" 2 files changed, 4 insertions(+), 1 deletion(-)\n");
          if (args.startsWith("merge-tree")) return yield* out("tree\n");
          if (args.startsWith("log"))
            return yield* out(
              `bbbb${"0".repeat(36)}\u001fdocs: usage\u001f2026-11-24T05:00:00+07:00\n`,
            );
        }
        return yield* Effect.die(`Unexpected ${input.command} ${args}`);
      }),
    },
  });
  const storage = FileSystem.layerNoop({
    readDirectory: () => Effect.succeed([...(options.storage ?? [RID])]),
  });
  return RadicleCli.layer.pipe(Layer.provide(storage), Layer.provideMerge(host));
}
