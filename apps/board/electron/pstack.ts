import type { PstackResult } from "../src/connection/engineState";
import type { LinuxHost } from "./wslEngine";

const REPO = "https://github.com/13kparkin/pstack-t3";
const CLONE_TIMEOUT_MS = 120_000;

// The folder is the board's own, in the WSL home. A failed refresh keeps the checkout that is there,
// so an offline board still starts. A new clone is shallow because only the latest skills are read.
const SCRIPT = `set -e
dir="$HOME/.agent-board/pstack-t3"
if [ -d "$dir/.git" ]; then
  git -C "$dir" fetch -q --depth 1 origin main && git -C "$dir" reset -q --hard FETCH_HEAD || echo "pstack-t3 could not be refreshed, so the checkout stays as it is" >&2
else
  mkdir -p "$HOME/.agent-board"
  git clone -q --depth 1 -b main ${REPO} "$dir"
fi
printf '%s\\n' "$dir"
`;

/** Clones `13kparkin/pstack-t3` into the board's folder in WSL, or refreshes it, and returns that folder. */
export async function ensurePstack(host: Pick<LinuxHost, "shell">): Promise<PstackResult> {
  const result = await host.shell(SCRIPT, { timeoutMs: CLONE_TIMEOUT_MS });
  const dir = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.exitCode !== 0 || !dir.startsWith("/")) {
    const detail = result.stderr.trim() || "git did not finish";
    return {
      ok: false,
      reason: `The pstack-t3 skills could not be fetched: ${detail}. The repo is private, so git needs your credentials in WSL (gh auth setup-git).`,
    };
  }
  return { ok: true, dir };
}
