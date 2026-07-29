import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ComposerPathSearchEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly parentPath?: string;
}

export interface ComposerPathSearchState {
  readonly entries: ReadonlyArray<ComposerPathSearchEntry>;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly query: string | null;
}
