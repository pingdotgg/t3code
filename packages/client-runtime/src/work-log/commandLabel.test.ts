import { describe, expect, it } from "vite-plus/test";

import {
  commandDisplayText,
  commandProgramName,
  parseIgnoredCommandPrefixes,
} from "./commandLabel.ts";

describe("ignored command prefixes", () => {
  const prefixes = ["rtk", "rtk proxy", "wrapper"];

  it.each([
    ["rtk git status", "git", "git status"],
    ["rtk proxy git status", "git", "git status"],
    ['wrapper rtk git diff -- "file name.ts"', "git", 'git diff -- "file name.ts"'],
    ["/usr/local/bin/rtk git status", "git", "git status"],
    ['"/Applications/My Tools/rtk" git status', "git", "git status"],
    [".\\rtk git status", "git", "git status"],
    ["CI=1 env -u DEBUG sudo -u root rtk git status", "git", "git status"],
    ["/bin/zsh -lc 'rtk git status'", "git", "git status"],
    ["rtk git status && git diff", "git", "git status && git diff"],
    ['& "C:\\Tools\\rtk" git status', "git", "git status"],
    ["rtk \\\n git status", "git", "git status"],
  ])("unwraps configured prefixes in %s", (command, program, preview) => {
    expect(commandProgramName(command, prefixes)).toBe(program);
    expect(commandDisplayText(command, prefixes)).toBe(preview);
  });

  it.each([
    "command rtk git status",
    "cd repo && rtk git status",
    "sh -c 'rtk git status' && npm test",
    "bash -c 'rtk git status' && npm test",
    "bash -c 'rtk git status'; npm test",
    "bash -c 'rtk git status' && git status",
    "sh -c 'rtk git status' git status",
    "timeout 10 rtk git status; npm test",
  ])("preserves shell boundaries and other commands in %s", (command) => {
    expect(commandProgramName(command, prefixes)).toBe("git");
    expect(commandDisplayText(command, prefixes)).toBe(command);
  });

  it.each([
    ["rtk git status; npm test", "git status; npm test"],
    ["rtk git status  ;  npm test", "git status  ;  npm test"],
    ["rtk git status&&npm test", "git status&&npm test"],
    ["rtk git status\nnpm test", "git status\nnpm test"],
    ["wrapper rtk git status; npm test", "git status; npm test"],
    ["rtk sh -c 'rtk git status' && npm test", "sh -c 'rtk git status' && npm test"],
    ["rtk cat <<EOF\nhello\nEOF\nnpm test", "cat <<EOF\nhello\nEOF\nnpm test"],
  ])("retains the original command suffix when removing prefixes in %s", (command, preview) => {
    expect(commandDisplayText(command, prefixes)).toBe(preview);
  });

  it.each([
    "rtk",
    "rtk --version",
    "rtk proxy",
    "rtk rtk --help",
    "rtk git 'unterminated",
    "rtk $(choose-command)",
    `${"rtk ".repeat(12)}git status`,
  ])("keeps the original command when unwrapping is uncertain: %s", (command) => {
    expect(commandProgramName(command, prefixes)).toBe(commandProgramName(command));
    expect(commandDisplayText(command, prefixes)).toBe(commandDisplayText(command));
  });

  it.each(["rtk-extra git status", "git log --grep=rtk", "echo 'rtk git status'"])(
    "only matches complete leading command tokens in %s",
    (command) => {
      expect(commandProgramName(command, prefixes)).toBe(commandProgramName(command));
      expect(commandDisplayText(command, prefixes)).toBe(commandDisplayText(command));
    },
  );

  it("keeps wrappers visible by default and supports prefixes that include flags", () => {
    expect(commandProgramName("rtk git status")).toBe("rtk");
    expect(commandDisplayText("rtk git status")).toBe("rtk git status");
    expect(commandProgramName("wrapper --quiet git status", ["wrapper --quiet"])).toBe("git");
    expect(commandDisplayText("wrapper --quiet git status", ["wrapper --quiet"])).toBe(
      "git status",
    );
  });

  it("normalizes one prefix per line without duplicates", () => {
    expect(parseIgnoredCommandPrefixes(" rtk \r\n\nrtk proxy\nrtk\n ")).toEqual([
      "rtk",
      "rtk proxy",
    ]);
  });

  it("only treats a nested multiword prefix as ignored when every token matches", () => {
    const prefixes = ["rtk", "git status"];
    expect(commandProgramName("rtk git diff", prefixes)).toBe("git");
    expect(commandDisplayText("rtk git diff", prefixes)).toBe("git diff");
    expect(commandDisplayText("rtk git status", prefixes)).toBe("rtk git status");
  });
});

describe("commandProgramName", () => {
  it.each([
    ["/bin/bash --rcfile /tmp/config -c 'git status'", "git"],
    ["zsh -lc 'CI=1 env -u DEBUG sudo -u root vp test run'", "vp"],
    ['"C:\\Program Files\\Git\\bin\\bash.exe" -lc "git status"', "git"],
    // regression: #9371 a multiline script whose later line re-quotes must still label its first program
    ["/bin/zsh -lc 'git status\nsed -n '\"'1,20p' apps/web/src/components/DiffPanel.tsx\"", "git"],
  ])("unwraps shell scripts without executing them: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["sudo -u root pnpm test", "pnpm"],
    ["zsh script.sh -c 'git status'", "zsh"],
    ["my-shell -c 'git status'", "my-shell"],
    ["$HOME/.bun/bin/bun test", "bun"],
  ])("preserves ordinary programs and actual shell launches: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each(["zsh -lc", "zsh -lc 'git status", "zsh -lc 'env'"])(
    "falls back for missing or malformed scripts: %s",
    (command) => {
      expect(commandProgramName(command)).toBeNull();
    },
  );

  it.each([
    "if test -f package.json; then vp test; fi",
    "[[ -f package.json ]]",
    "test -f package.json",
    'for file in *; do echo "$file"; done',
    "check() { vp test; }",
    "{ vp test; }",
    "(( count += 1 ))",
    ". ./script.sh",
    "export NODE_ENV=test",
    "repeat 3 echo ok",
    "return 1",
    "true",
  ])("falls back for shell syntax and internal control commands: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it.each([
    ['rg -n "if|for|while" src', "rg"],
    ["vp test && git status", "vp"],
    ["echo `git status`", "echo"],
    ["cat <(rg needle src)", "cat"],
  ])("uses the first executable-looking program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["cd packages/client-runtime && vp test run", "vp"],
    ["PATH+=:/tools npm test", "npm"],
    ["cd $(find . -type d | head -1) && git status", "git"],
    ["cd /tmp && # use the selected workspace\nnpm test", "npm"],
    ["cd ${ROOT:-path;with;semicolons} && bun test", "bun"],
  ])("skips leading cd commands and uses the next useful program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["source ~/.nvm/nvm.sh && nvm use", "nvm"],
    ["unset DEBUG; node app.js", "node"],
    ["/bin/zsh -lc 'source ~/.nvm/nvm.sh && nvm use'", "nvm"],
  ])("skips shell setup commands and uses the next useful program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["timeout 10s python3 script.py", "python3"],
    ["arch -arch arm64 /opt/tools/check", "check"],
    ["timeout 60 script -q /dev/null env CI=1 node app.js", "node"],
  ])("unwraps process-launch wrappers: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    "command -v git",
    "exec > output.log",
    "env CI=1 cd /tmp && npm test",
    "$PY scripts/check.py",
    "& { Get-Process }",
    "coproc npm test",
  ])("does not treat shell lookup and commandless wrapper forms as executions: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it.each([
    ["hash --help", "hash"],
    ["Exec node app.js", "Exec"],
    ["CD /tmp && npm test", "CD"],
  ])("does not hide legitimate or case-distinct program names: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it("uses the command after leading shell comments", () => {
    expect(commandProgramName("# first comment\n  # second comment\ngit status")).toBe("git");
  });

  it.each([
    [">/tmp/log && npm test", "npm"],
    ["cd /tmp && 2>& 1 node app.js", "node"],
    ["cd /tmp && {output}>/tmp/log deno test", "deno"],
  ])("skips redirections before the next command: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["cd /tmp <<-EOF\n\tnot-a-command\n\tEOF\nbun test", "bun"],
    ["cd /tmp <<A <<B\none\nA\ntwo\nB\ngit status", "git"],
    ["cd /tmp <<EOF && pnpm test\nnot-a-command\nEOF\nbun test", "pnpm"],
  ])("skips heredoc bodies before finding the next command: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it("bounds nested shell unwrapping", () => {
    let command = "git status";
    for (let depth = 0; depth < 9; depth += 1) {
      command = `sh -c '${command.replaceAll("'", "'\\''")}'`;
    }
    expect(commandProgramName(command)).toBeNull();
  });

  it("bounds the number of top-level setup segments", () => {
    const command = [
      ...Array.from({ length: 2_000 }, (_, index) => `export VALUE_${index}=configured`),
      "npm test",
    ].join(";");

    expect(commandProgramName(command)).toBeNull();
  });
});

describe("commandDisplayText with redacted Codex commands", () => {
  // Codex replaces secrets in command text before sending it
  // (codex-rs/secrets/src/sanitizer.rs). Usually the quoting survives.
  it("unwraps a redacted command whose quoting is intact", () => {
    expect(
      commandDisplayText(
        `/bin/zsh -lc 'curl -H "Authorization: Bearer [REDACTED_SECRET]" https://example.com'`,
      ),
    ).toBe('curl -H "Authorization: Bearer [REDACTED_SECRET]" https://example.com');
  });

  // Its secret-assignment pattern can also swallow the backslash of an escaped
  // quote: `token=config[\"apiToken\"]` becomes `token=[REDACTED_SECRET]"apiToken\"]`.
  // The bare quote ends the -lc argument early, so where the script ends is unknown.
  it("keeps the wrapper when redaction broke the quoting", () => {
    const input = `/bin/zsh -lc "python3 -c 'token=[REDACTED_SECRET]"apiToken\\"]; print(token)'"`;
    expect(commandDisplayText(input)).toBe(input);
  });
});

describe("commandDisplayText control characters", () => {
  it.each([
    ["printf '\u001b[31mred\u001b[0m'", "printf '␛[31mred␛[0m'"],
    ["zsh -lc 'printf \"\u001b[1m\"'", 'printf "␛[1m"'],
    ["printf 'a\\tb'\r\necho done", "printf 'a\\tb'\r\necho done"],
  ])("shows %j as %j", (input, expected) => {
    expect(commandDisplayText(input)).toBe(expected);
  });
});
