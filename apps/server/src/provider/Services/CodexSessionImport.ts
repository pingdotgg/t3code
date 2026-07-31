/**
 * CodexSessionImport - adoption of persisted Codex conversations.
 *
 * The import keeps the native conversation authoritative. T3 stores a
 * text-only display snapshot and a strict resume reference; it never copies,
 * moves, archives, or deletes the original Codex thread.
 *
 * @module provider/Services/CodexSessionImport
 */
import type {
  CodexSessionImportError,
  CodexSessionImportInput,
  CodexSessionImportResult,
  CodexSessionListInput,
  CodexSessionListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface CodexSessionImportShape {
  /** Discover importable sessions whose native workspace matches a T3 project. */
  readonly list: (
    input: CodexSessionListInput,
  ) => Effect.Effect<CodexSessionListResult, CodexSessionImportError>;
  /** Adopt selected native sessions into the project's T3 thread list. */
  readonly import: (
    input: CodexSessionImportInput,
  ) => Effect.Effect<CodexSessionImportResult, CodexSessionImportError>;
}

export class CodexSessionImport extends Context.Service<
  CodexSessionImport,
  CodexSessionImportShape
>()("t3/provider/Services/CodexSessionImport") {}
