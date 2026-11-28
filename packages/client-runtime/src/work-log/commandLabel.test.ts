import { describe, expect, it } from "vite-plus/test";

import { commandDisplayText, commandProgramName } from "./commandLabel.ts";

describe("commandProgramName", () => {
  it.each([
    ["/bin/bash --rcfile /tmp/config -c 'git status'", "git"],
    ['bash -lc -- "printf ok"', "printf"],
    ['bash -euo pipefail -c "ls -la"', "ls"],
    ['bash +x +o history -c "ls -la"', "ls"],
    // fish runs `--` itself as the script; "printf ok" is a positional argument
    ['fish -c -- "printf ok"', "--"],
    ["zsh -lc 'CI=1 env -u DEBUG sudo -u root vp test run'", "vp"],
    ['"C:\\Program Files\\Git\\bin\\bash.exe" -lc "git status"', "git"],
    // regression: #9371 a multiline script whose later line re-quotes must still label its first program
    ["/bin/zsh -lc 'git status\nsed -n '\"'1,20p' apps/web/src/components/DiffPanel.tsx\"", "git"],
    ["bash -c $'ls\\nnpm test'", "ls"],
    ["bash -c $'\\x6e\\160m test'", "npm"],
    ['powershell -NoP -exec bypass -c "git status"', "git"],
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

  it.each(["zsh -lc", "bash -c --", "zsh -lc 'git status", "zsh -lc 'env'"])(
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

  // regression: #41718 a leading env-setup eval hid the real program behind "Running command"
  it.each([
    [
      'cd /path/to/repo && eval "$(fnm env --shell zsh)" && fnm use 26.13.1 && git commit -m "msg"',
      "fnm",
    ],
    ['eval "$(/opt/homebrew/bin/brew shellenv)" && pnpm test', "pnpm"],
  ])("skips leading env-setup eval segments: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["source ~/.nvm/nvm.sh && nvm use", "nvm"],
    ["unset DEBUG; node app.js", "node"],
    ["/bin/zsh -lc 'source ~/.nvm/nvm.sh && nvm use'", "nvm"],
    ["sudo [ -f /etc/hosts ] && git status", "git"],
    ["sudo -n [ -d /opt ] && pytest", "pytest"],
    ["sudo [[ -f /etc/hosts ]] && git status", "git"],
    ["true && git --version", "git"],
  ])("skips shell setup commands and uses the next useful program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["timeout 10s python3 script.py", "python3"],
    ["arch -arch arm64 /opt/tools/check", "check"],
    ["timeout 60 script -q /dev/null env CI=1 node app.js", "node"],
    ["timeout -s KILL 30 npm test", "npm"],
    ["timeout --signal=TERM -v 60 cargo test", "cargo"],
    ["gtimeout -fk5 -- 30 node app.js", "node"],
    ['env -S"FOO=1 git status"', "git"],
    ['env -vS "FOO=1 git status"', "git"],
    ['env -S"FOO=1" git status', "git"],
    ["env - git status", "git"],
  ])("unwraps process-launch wrappers: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each(["timeout -x 30 npm test", "timeout -s 30 npm test"])(
    "keeps the timeout label for invalid timeout options: %s",
    (command) => {
      expect(commandProgramName(command)).toBe("timeout");
    },
  );

  it.each([
    "command -v git",
    "exec > output.log",
    "env CI=1 cd /tmp && npm test",
    "$PY scripts/check.py",
    "& { Get-Process }",
    "coproc npm test",
    "true || git --version",
    "builtin true || git --version",
    ": || git --version",
    "builtin : || git --version",
    "command : || git --version",
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
    ["whoami>/dev/null", "whoami"],
    ["cat</etc/hosts", "cat"],
    ["whoami&>/dev/null", "whoami"],
    ["'my>tool' arg", "my>tool"],
    ["my\\>tool arg", "my>tool"],
  ])("handles redirections around commands: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["cd /tmp <<-EOF\n\tnot-a-command\n\tEOF\nbun test", "bun"],
    ["cd /tmp <<A <<B\none\nA\ntwo\nB\ngit status", "git"],
    ["cd /tmp <<EOF && pnpm test\nnot-a-command\nEOF\nbun test", "pnpm"],
    ["cd . <<''\npretend\n\nprintf ok", "printf"],
    ['cd . <<""\npretend\n\nprintf ok', "printf"],
    [": <<< hi\nprintf '%s' visible", "printf"],
    [": <<<-hi && printf '%s' visible", "printf"],
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

describe("commandDisplayText with shell option terminators", () => {
  it.each([
    ['bash -lc -- "printf ok"', "printf ok"],
    ['bash -eo pipefail -c "printf ok"', "printf ok"],
    ['fish -c -- "printf ok"', 'fish -c -- "printf ok"'],
    ['bash -c -- "printf ok" arg0', 'bash -c -- "printf ok" arg0'],
  ])("shows %j as %j", (input, expected) => {
    expect(commandDisplayText(input)).toBe(expected);
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

describe("commandDisplayText with Windows shell wrappers", () => {
  it.each([
    [
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`,
      "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
    ],
    [
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
      'rg -n -F "new Date()" .',
    ],
    ['cmd.exe /c "npm test"', "npm test"],
    ['Bash.exe -lc "git status"', "git status"],
    ['"C:\\Program Files\\Git\\bin\\Bash.exe" -lc "rg foo"', "rg foo"],
    [
      'powershell.exe -NoProf -NonI -ep Bypass -ExecutionPol Bypass -wd C:\\repo -Comm "git status"',
      "git status",
    ],
    ['pwsh -v ignored -c "git status"', 'pwsh -v ignored -c "git status"'],
    ['powershell -v 5.1 -c "git status"', "git status"],
  ])("shows %j as %j", (input, expected) => {
    expect(commandDisplayText(input)).toBe(expected);
  });
});

describe("commandDisplayText with ANSI-C and locale quoting", () => {
  it.each([
    ["bash -c $'npm test'", "npm test"],
    ["bash -c $'echo \\'hi\\'; ls'", "echo 'hi'; ls"],
    ['bash -lc $"npm test"', "npm test"],
  ])("shows %j as %j", (input, expected) => {
    expect(commandDisplayText(input)).toBe(expected);
  });
});

describe("commandDisplayText with line continuations", () => {
  it.each([
    ['bash \\\n-lc "git status"', "git status"],
    ['bash -lc "git status \\\n--short"', "git status --short"],
  ])("removes them as bash does: %j", (input, expected) => {
    expect(commandDisplayText(input)).toBe(expected);
  });

  it.each([
    ["bash -lc 'git status \\\n--short'", "git status \\\n--short"],
    ["bash -c $'git status \\\n--short'", "git status \\\n--short"],
    ['bash \\\n-lc "git status \\\r\n--short"', "git status \\\r\n--short"],
  ])("keeps them where bash does: %j", (input, expected) => {
    expect(commandDisplayText(input)).toBe(expected);
  });

  it("keeps Windows shell scripts on separate lines", () => {
    expect(commandDisplayText('cmd.exe /c "dir C:\\\necho done"')).toMatch(
      /^dir C:\\?\necho done$/u,
    );
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
