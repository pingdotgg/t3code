import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const STORE = "board.files.expanded";
// Roots are kept most recent first and capped, so worktrees that come and go do not grow storage.
const MAX_ROOTS = 20;
const Stored = Schema.Array(
  Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.String) }),
);
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

const stored = () => Option.getOrElse(decode(localStorage.getItem(STORE) ?? "[]"), () => []);

/** The folders that were open under a root when it was last shown. */
export function readExpanded(root: string): ReadonlyArray<string> {
  return stored().find((entry) => entry.root === root)?.paths ?? [];
}

export function writeExpanded(root: string, paths: ReadonlyArray<string>): void {
  const others = stored().filter((entry) => entry.root !== root);
  const next = paths.length > 0 ? [{ root, paths }, ...others] : others;
  localStorage.setItem(STORE, JSON.stringify(next.slice(0, MAX_ROOTS)));
}

/** Calls made while `run` is running rerun it once it returns, instead of nesting. */
export function coalesceReentrantCalls(run: () => void): () => void {
  let running = false;
  let calledAgain = false;
  return () => {
    if (running) {
      calledAgain = true;
      return;
    }
    running = true;
    try {
      do {
        calledAgain = false;
        run();
      } while (calledAgain);
    } finally {
      running = false;
    }
  };
}
