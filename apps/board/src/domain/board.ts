import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const BOARDS_DIR = ".agentboard";
export const BOARD_FILE = "board.json";

/** Orchestrators spawn at most this many building agents until a board says otherwise. */
export const DEFAULT_BUILDER_CAP = 2;

const Text = Schema.String.check(Schema.isNonEmpty());

export const Board = Schema.Struct({
  id: Text,
  slug: Text,
  name: Text,
  projectId: Text,
  /** Null until the board's orchestrator starts. */
  orchestratorThreadId: Schema.NullOr(Text),
  createdAt: Text,
  archived: Schema.Boolean,
  builderCap: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The name of the board's review template. No value means the system template. */
  reviewTemplate: Schema.optionalKey(Text),
});
export type Board = typeof Board.Type;

export interface BoardIssue {
  /** The `board.json` fields the decoder rejected, in file order. */
  readonly fields: ReadonlyArray<string>;
  readonly message: string;
}

const decodeBoardJson = Schema.decodeUnknownResult(Schema.fromJsonString(Board));
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Decodes the text of a `board.json`, naming the fields that are missing or wrong. */
export function parseBoard(text: string): Result.Result<Board, BoardIssue> {
  return Result.mapError(decodeBoardJson(text, { errors: "all" }), (error): BoardIssue => {
    const issues = formatIssues(error.issue).issues;
    const fields = [
      ...new Set(issues.flatMap((issue) => (issue.path?.length ? [String(issue.path[0])] : []))),
    ];
    return {
      fields,
      message:
        fields.length > 0
          ? `board.json is invalid: ${issues.map((issue) => `${issue.path?.join(".") || "(file)"} ${issue.message}`).join("; ")}`
          : `board.json is not valid JSON or not a board: ${issues.map((issue) => issue.message).join("; ")}`,
    };
  });
}

export function serializeBoard(board: Board): string {
  return `${JSON.stringify(board, null, 2)}\n`;
}

/** `Claude connector` becomes `claude-connector`; a name with no letters or digits becomes `board`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "board" : slug;
}

/** The slug for a new board's folder: `claude-connector`, then `claude-connector-2` once it is taken. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
