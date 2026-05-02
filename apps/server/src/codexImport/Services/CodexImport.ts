import type {
  CodexImportError,
  CodexImportImportSessionsInput,
  CodexImportImportSessionsResult,
  CodexImportListSessionsInput,
  CodexImportPeekSessionInput,
  CodexImportPeekSessionResult,
  CodexImportSessionSummary,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface CodexImportShape {
  readonly listSessions: (
    input: CodexImportListSessionsInput,
  ) => Effect.Effect<ReadonlyArray<CodexImportSessionSummary>, CodexImportError>;
  readonly peekSession: (
    input: CodexImportPeekSessionInput,
  ) => Effect.Effect<CodexImportPeekSessionResult, CodexImportError>;
  readonly importSessions: (
    input: CodexImportImportSessionsInput,
  ) => Effect.Effect<CodexImportImportSessionsResult, CodexImportError>;
}

export class CodexImport extends Context.Service<CodexImport, CodexImportShape>()(
  "t3/codexImport/Services/CodexImport",
) {}
