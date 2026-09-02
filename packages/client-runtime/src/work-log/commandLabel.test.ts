import { describe, expect, it } from "vite-plus/test";

import { commandProgramName } from "./commandLabel.ts";

describe("commandProgramName", () => {
  it.each([
    ["/bin/zsh -lc 'vp test run apps/web/src/session-logic.test.ts'", "vp"],
    ["/bin/zsh -lc 'git diff --check'", "git"],
    ['/bin/zsh -lc "npx -y react-doctor@latest apps/web"', "npx"],
    ["/bin/zsh -lc 'rg -n \"registerHooks|worker\" apps/web/src'", "rg"],
    ["/bin/bash --noprofile --norc -l -c 'sed -n 1,270p file.ts'", "sed"],
    ["/bin/bash -o pipefail -lc 'vp test run'", "vp"],
    ["/bin/bash --rcfile /tmp/config -c 'git status'", "git"],
    ["sh -ec 'node scripts/check.js'", "node"],
    ["fish --command 'rg --files'", "rg"],
    ["zsh -lc 'CI=1 env -u DEBUG sudo -u root vp test run'", "vp"],
    ["env CI=1 /bin/zsh -lc '\"/Applications/My Tools/bin/check\" --verbose'", "check"],
    ["bash -lc \"zsh -c 'git status'\"", "git"],
    ['"C:\\Program Files\\Git\\bin\\bash.exe" -lc "git status"', "git"],
  ])("unwraps shell scripts without executing them: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["vp test run", "vp"],
    ["sudo -u root pnpm test", "pnpm"],
    ["env --split-string='CI=1 node scripts/check.js'", "node"],
    ['"C:\\Program Files\\nodejs\\node.exe" script.js', "node.exe"],
    ["/bin/zsh", "zsh"],
    ["/bin/bash -l", "bash"],
    ["zsh script.sh -c 'git status'", "zsh"],
    ["bash -- -c 'git status'", "bash"],
    ["bash --rcfile config.sh", "bash"],
    ["my-shell -c 'git status'", "my-shell"],
  ])("preserves ordinary programs and actual shell launches: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    "",
    "zsh -lc",
    "zsh -lc ''",
    "zsh -lc 'git status",
    "zsh -lc 'env'",
    'zsh -lc "git \\\"',
  ])("falls back for missing or malformed scripts: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it("bounds nested shell unwrapping", () => {
    let command = "git status";
    for (let depth = 0; depth < 9; depth += 1) {
      command = `sh -c '${command.replaceAll("'", "'\\''")}'`;
    }
    expect(commandProgramName(command)).toBeNull();
  });
});
