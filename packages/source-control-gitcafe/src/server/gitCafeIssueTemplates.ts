import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueTrackerKind, type IssueTemplate } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueScopeTarget,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import { Cursor } from "./gitCafeIssueJson.ts";

const LIMIT = 20;
const MAX_BYTES = 1024 * 1024;
const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Entry = Schema.Struct({
  name: Path,
  path: Path,
  oid: Oid,
  kind: Schema.Literals(["blob", "tree", "commit", "symlink"]),
});
const Tree = Schema.Struct({
  oid: Oid,
  items: Schema.Array(Entry).check(Schema.isMaxLength(200)),
  next: Schema.NullOr(Cursor),
});
const Commits = Schema.Struct({
  items: Schema.Array(Schema.Struct({ oid: Oid })).check(Schema.isMaxLength(1)),
  next: Schema.NullOr(Cursor),
});
const Blob = Schema.Struct({
  commit: Oid,
  oid: Oid,
  path: Path,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_BYTES)),
  binary: Schema.Boolean,
  content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_BYTES))),
});
const PREFIXES = [".gitcafe", ".github"];
const FALLBACKS = ["ISSUE_TEMPLATE.md", "ISSUE_TEMPLATE", "issue_template.md"];
const fileName = (name: string) => name !== "." && name !== ".." && !/[/\\\p{Cc}]/u.test(name);
const templatePath = (path: string) =>
  path.length <= 4096 &&
  PREFIXES.some(
    (prefix) =>
      FALLBACKS.some((name) => path === `${prefix}/${name}`) ||
      (path.startsWith(`${prefix}/ISSUE_TEMPLATE/`) &&
        fileName(path.slice(`${prefix}/ISSUE_TEMPLATE/`.length)) &&
        /\.(md|markdown|txt)$/u.test(path)),
  );
export const parseTemplateKey = (key: string) => {
  const match = key.match(/^([0-9a-f]{40}):(.+)$/u);
  return match !== null && templatePath(match[2]!) ? match : null;
};
const fail = (detail: string) =>
  new IssueTrackerError({
    tracker: IssueTrackerKind.make("gitcafe"),
    operation: "listTemplates",
    reason: "failed",
    detail,
  });

export const makeListTemplates =
  (
    request: (input: IssueScopeTarget, path: string) => Effect.Effect<string, IssueTrackerError>,
  ): NonNullable<IssueTrackerApi["listTemplates"]> =>
  (input) =>
    Effect.gen(function* () {
      const selected =
        input.templateKey === undefined ? undefined : parseTemplateKey(input.templateKey);
      if (
        (input.metadataOnly && input.templateKey !== undefined) ||
        (input.templateKey !== undefined && selected == null)
      )
        return yield* fail("Choose a valid GitCafe issue template.");
      const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
        path: string,
        schema: S,
      ) =>
        request(input, `/repos/${input.scope}/${path}`).pipe(
          Effect.flatMap((raw) =>
            Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
              Effect.mapError(() => fail("GitCafe returned an unreadable template response.")),
            ),
          ),
        );
      let commit = selected?.[1];
      if (commit === undefined) {
        const commits = yield* read("commits?ref=HEAD&limit=1", Commits);
        commit = commits.items[0]?.oid;
        if (commit === undefined) return { templates: [], blankIssuesEnabled: true };
      }
      const at = commit;
      const entries = (path: string, templates = false) =>
        Effect.gen(function* () {
          const items: Array<typeof Entry.Type> = [];
          const seenPaths = new Set<string>();
          const seenCursors = new Set<string>();
          let after: string | null = null;
          let oid: string | undefined;
          for (let page = 0; page < 10; page++) {
            const query = new URLSearchParams({ oid: at, path, limit: "200" });
            if (after !== null) query.set("after", after);
            const result: typeof Tree.Type | null = yield* read(`tree?${query}`, Tree).pipe(
              Effect.catchIf(
                (error) => error.reason === "not-found" && page === 0 && !templates,
                () => Effect.succeed(null),
              ),
            );
            if (result === null) return items;
            if (oid !== undefined && oid !== result.oid)
              return yield* fail("GitCafe changed the template tree.");
            oid = result.oid;
            for (const entry of result.items) {
              if (
                !fileName(entry.name) ||
                entry.path !== `${path}/${entry.name}` ||
                seenPaths.has(entry.path)
              )
                return yield* fail("GitCafe returned an invalid template path.");
              seenPaths.add(entry.path);
              if (!templates || (entry.kind === "blob" && templatePath(entry.path)))
                items.push(entry);
            }
            if (templates && items.length >= LIMIT) return items.slice(0, LIMIT);
            if (result.next === null) return items;
            if (seenCursors.has(result.next))
              return yield* fail("GitCafe repeated a template tree cursor.");
            seenCursors.add(result.next);
            after = result.next;
          }
          return yield* fail("GitCafe exceeds the supported template tree page limit.");
        });
      let candidates: Array<typeof Entry.Type> = [];
      const folders: Array<Array<typeof Entry.Type>> = [];
      let foundDirectory = false;
      for (const prefix of PREFIXES) {
        const items = yield* entries(prefix);
        folders.push(items);
        if (items.some((entry) => entry.name === "ISSUE_TEMPLATE" && entry.kind === "tree")) {
          candidates = yield* entries(`${prefix}/ISSUE_TEMPLATE`, true);
          foundDirectory = true;
          break;
        }
      }
      if (!foundDirectory) {
        for (const items of folders) {
          const fallback = FALLBACKS.map((name) =>
            items.find((entry) => entry.name === name && entry.kind === "blob"),
          ).find((entry) => entry !== undefined);
          if (fallback !== undefined) {
            candidates = [fallback];
            break;
          }
        }
      }
      if (selected != null) {
        candidates = candidates.filter((entry) => entry.path === selected[2]);
        if (candidates.length === 0)
          return yield* fail("This GitCafe issue template is unavailable.");
      }
      const templates: IssueTemplate[] = [];
      let bytes = 0;
      for (const entry of candidates) {
        let body = "";
        if (!input.metadataOnly) {
          const query = new URLSearchParams({ oid: at, path: entry.path });
          const blob = yield* read(`blob?${query}`, Blob);
          if (
            blob.commit !== at ||
            blob.path !== entry.path ||
            blob.oid !== entry.oid ||
            blob.binary ||
            blob.content === null
          )
            return yield* fail("GitCafe returned a different or unreadable issue template.");
          const size = new TextEncoder().encode(blob.content).length;
          bytes += size;
          if (size !== blob.size || bytes > MAX_BYTES)
            return yield* fail("GitCafe issue templates exceed the 1 MiB content limit.");
          body = blob.content;
        }
        templates.push({
          key: `${at}:${entry.path}`,
          name: entry.name.trim(),
          about: "",
          title: "",
          body,
          labels: [],
          assignees: [],
          ...(input.metadataOnly ? { contentDeferred: true } : {}),
        });
      }
      return { templates, blankIssuesEnabled: true };
    });
