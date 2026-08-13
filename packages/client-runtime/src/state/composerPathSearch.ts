import type { EnvironmentId } from "@t3tools/contracts";

export interface ComposerPathSearchEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly parentPath?: string | undefined;
  readonly root?: string | undefined;
}

export interface ComposerPathSearchState {
  readonly entries: ReadonlyArray<ComposerPathSearchEntry>;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly roots?: ReadonlyArray<string> | null | undefined;
  readonly query: string | null;
}
