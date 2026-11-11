import * as Cause from "effect/Cause";
import * as SchemaIssue from "effect/SchemaIssue";

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (!(error instanceof Error) || error.message.trim().length === 0) {
    return "The environment request failed.";
  }
  if (!SchemaIssue.isIssue(error.cause)) return error.message;
  try {
    return `${error.message}: ${formatSchemaIssue(error.cause).replace(/\s*\n\s*/g, " ")}.`;
  } catch {
    // A server defect keeps the issue brand over JSON but can lose the AST the formatter reads.
    return error.message;
  }
}
