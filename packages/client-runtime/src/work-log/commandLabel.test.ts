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
    ["/bin/zsh -lc 'git status\nsed -n '\"'1,20p' apps/web/src/components/DiffPanel.tsx\"", "git"],
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
    ["$HOME/.bun/bin/bun test", "bun"],
    ['"$ANDROID_HOME/emulator/emulator" -list-avds', "emulator"],
    ["${ROOT}/bin/tool --version", "tool"],
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

  it.each([
    "if test -f package.json; then vp test; fi",
    "[ -f package.json ]",
    "[[ -f package.json ]]",
    "test -f package.json",
    'for file in *; do echo "$file"; done',
    "while true; do sleep 1; done",
    "until false; do sleep 1; done",
    "case $name in test) vp test;; esac",
    'select item in one two; do echo "$item"; done',
    "function check() { vp test; }",
    "check() { vp test; }",
    "k(){ echo ok; }; k",
    "{ vp test; }",
    "(vp test)",
    "(( count += 1 ))",
    "! vp test",
    ":",
    ". ./script.sh",
    "source ./script.sh",
    "eval 'vp test'",
    "cd packages/client-runtime",
    "export NODE_ENV=test",
    "local name=value",
    "set -e",
    "alias ll='ls -la'",
    "repeat 3 echo ok",
    "and vp test",
    "return 1",
    "break",
    "continue",
    "true",
    "false",
  ])("falls back for shell syntax and internal control commands: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it.each([
    ['rg -n "if|for|while" src', "rg"],
    ["printf '%s\\n' 'a;b|c'", "printf"],
    ["node -e \"if (true) console.log('ok')\"", "node"],
    ["echo '$(git status)'", "echo"],
    ["vp test && git status", "vp"],
    ["vp test || git status", "vp"],
    ["rg needle src | head", "rg"],
    ["vp test; git status", "vp"],
    ["vp test &", "vp"],
    ["vp test\ngit status", "vp"],
    ['echo "$(git status)"', "echo"],
    ["echo `git status`", "echo"],
    ["cat <(rg needle src)", "cat"],
  ])("uses the first executable-looking program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["cd packages/client-runtime && vp test run", "vp"],
    ['cd "a path with spaces"; git status', "git"],
    ["cd apps/web\npnpm test", "pnpm"],
    ["cd first && cd second && bun test", "bun"],
    ["CI=1 cd apps/web && npm test", "npm"],
    ["PATH+=:/tools npm test", "npm"],
    ["PATH+=:/tools && npm test", "npm"],
    ['TMP=$(mktemp -d); cd "$TMP"; npm pack ./package', "npm"],
    ["cd $(find . -type d | head -1) && git status", "git"],
    ["cd `find . -type d | head -1` && node script.js", "node"],
    ["cd /tmp 2>&1 && npm test", "npm"],
    ["cd /tmp 2<&0 && pnpm test", "pnpm"],
    ["cd /tmp &>/dev/null && bun test", "bun"],
    ["cd work |& npm test", "npm"],
    ["cd /tmp && # use the selected workspace\nnpm test", "npm"],
    ["export CI=1; # first note\n# second note\npnpm test", "pnpm"],
    ["cd&&npm test", "npm"],
    ["export CI=1;pnpm test", "pnpm"],
    ["cd ${ROOT:-path;with;semicolons} && bun test", "bun"],
    ["cd ${ROOT:-path&&fallback} && node app.js", "node"],
    ["cd @(first|second) && npm test", "npm"],
    ["cd /tmp \\\n&& npm test", "npm"],
    ["/bin/zsh -lc 'cd apps/web && vp test run'", "vp"],
  ])("skips leading cd commands and uses the next useful program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["source ~/.nvm/nvm.sh && nvm use", "nvm"],
    [". ./.env && pnpm test", "pnpm"],
    ["export CI=1 && vp test run", "vp"],
    ["unset DEBUG; node app.js", "node"],
    ["export CI=1 && cd apps/web && pnpm test", "pnpm"],
    ["/bin/zsh -lc 'source ~/.nvm/nvm.sh && nvm use'", "nvm"],
  ])("skips shell setup commands and uses the next useful program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["set -eu; npm test", "npm"],
    [": && npm test", "npm"],
    ["true && npm test", "npm"],
    ["false || npm test", "npm"],
    ["false; npm test", "npm"],
    ["sudo -n true && npm test", "npm"],
    ["sudo -n true; echo checked", "echo"],
    ["test -d node_modules || vp i", "vp"],
    ["[ -d node_modules ] || vp i", "vp"],
  ])("skips non-descriptive shell commands before a useful program: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each(
    ["cd /tmp", "export CI=1", "unset DEBUG", "source env.sh", ". env.sh"].flatMap((setup) =>
      ["&&", " || ", ";", "\n", "|", " |& ", " & "].map(
        (operator) => [`${setup}${operator}npm test`, "npm"] as const,
      ),
    ),
  )("handles shell setup followed by every command separator: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["command git status", "git"],
    ["command -p git status", "git"],
    ["command -- git status", "git"],
    ["builtin printf ok", "printf"],
    ["builtin -- echo ok", "echo"],
    ["command cd /tmp && npm test", "npm"],
    ["builtin cd /tmp && pnpm test", "pnpm"],
    ["exec node app.js", "node"],
    ["exec -cl -a worker node app.js", "node"],
    ["exec env CI=1 /opt/tools/check --verbose", "check"],
    ['exec "C:\\Program Files\\nodejs\\node.exe" app.js', "node.exe"],
    ["exec sh -c 'cd /tmp && npm test'", "npm"],
    ["exec sh -c 'cd /tmp\nnpm test'", "npm"],
    ["exec bash -c 'set -e\nnpm test'", "npm"],
  ])("unwraps shell command wrappers: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["timeout 10 pnpm test", "pnpm"],
    ["timeout 10s python3 script.py", "python3"],
    ["gtimeout 1.5 node app.js", "node"],
    ["nohup npx expo start >/tmp/metro.log 2>&1 &", "npx"],
    ["nohup -- env CI=1 bun test", "bun"],
    ["arch -x86_64 ./build/app-under-test", "app-under-test"],
    ["arch -arch arm64 /opt/tools/check", "check"],
    ["bundle exec pod install", "pod"],
    ["timeout 30 nohup env CI=1 node app.js", "node"],
    ["timeout 60 script -q /dev/null env CI=1 node app.js", "node"],
  ])("unwraps process-launch wrappers: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["& 'C:\\Program Files\\nodejs\\node.exe' script.js", "node.exe"],
    ['& "$env:WINDIR\\Microsoft.NET\\Framework64\\v4\\csc.exe" file.cs', "csc.exe"],
  ])("resolves literal PowerShell call operators: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["$env:CI='1'; npm test", "npm"],
    ["$value = 'configured'; node app.js", "node"],
    ["$process = Get-Process node; $process.Id", "Get-Process"],
    ["$tmp = Join-Path $env:TEMP repo; git clone example", "Join-Path"],
    ["$html = (Invoke-WebRequest https://example.com).Content", "Invoke-WebRequest"],
    ["$process = Start-Process -FilePath .\\app.exe -PassThru; $process.Id", "app.exe"],
  ])("labels commands inside simple PowerShell assignments: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["cmd /c bcdedit /enum", "bcdedit"],
    ["cmd /c cd C:\\work && npm test", "npm"],
    ['cmd.exe /d /s /c "cd C:\\work && npm test"', "npm"],
    [
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\work\\scripts\\doctor.ps1"',
      "doctor.ps1",
    ],
    ['pwsh -NoProfile -Command "Set-Location C:\\work; pnpm test"', "pnpm"],
    ["pwsh -Command Set-Location C:\\work; pnpm test", "pnpm"],
  ])("unwraps Windows shell launchers: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["Set-Location C:\\work; npm test", "npm"],
    ["Push-Location C:\\work; node app.js", "node"],
    ["Start-Process -FilePath node -ArgumentList server.js", "node"],
    ["Start-Process -ArgumentList '-FilePath helper' node", "node"],
    ["Start-Process -ErrorAction Stop -FilePath node", "node"],
    ["Start-Process -NoNewWindow -WorkingDirectory C:\\work node", "node"],
    ['Start-Process "C:\\Program Files\\Example\\app.exe"', "app.exe"],
    ['Start-Process -FilePath ".\\dist\\Example App.exe" -PassThru', "Example App.exe"],
    [".\\.venv\\Scripts\\python.exe script.py", "python.exe"],
    ["$env:LOCALAPPDATA\\Programs\\tool.exe --version", "tool.exe"],
    ['"=== CHECK FILE ==="; Get-Content file.txt', "Get-Content"],
    ["$x = @'\ndata'; Get-Fake\n'@\nGet-Process", "Get-Process"],
    ["@'\nprint('ok; still data')\n'@ | python -", "python"],
  ])("handles common PowerShell setup and launch commands: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["timeout --help", "timeout"],
    ["nohup --version", "nohup"],
    ["arch", "arch"],
    ["bundle install", "bundle"],
    ["script output.log", "script"],
    ["/usr/bin/timeout 10 node app.js", "timeout"],
  ])("keeps process-launch wrappers when no safe payload is present: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    "command -v git",
    "command -V git",
    "command -a git",
    "command -pv git",
    "builtin -p",
    "exec",
    "exec > output.log",
    "exec --",
    "exec cd /tmp && npm test",
    "exec env CI=1 cd /tmp && npm test",
    "exec CI=1 npm test",
    "env CI=1 cd /tmp && npm test",
    "env CI=1; npm test",
    "sudo cd /tmp && npm test",
    "command CI=1 npm test",
    "command false && npm test",
    "cmd /c false && npm test",
    "cd /tmp <<EOF\nunterminated heredoc",
    "cd /tmp && >/tmp/log",
    "(xcrun simctl io booted recordVideo /tmp/video.mp4 &) ; wait",
    "export CI=1 && (bundle exec pod install || pod install)",
    "$PY scripts/check.py",
    "${TOOL} --version",
    "%TOOL% --version",
    "!TOOL! --version",
    "& $tool --version",
    "& { Get-Process }",
    "$value = 'configured'",
    "$headers = @{ 'Accept' = 'application/json'; 'Content-Type' = 'application/json' }; Invoke-WebRequest https://example.com",
    '"sha256(value)=$hash"',
    "broken{",
    "@echo off",
    ":: comment",
    "time -- npm test",
    "time -v npm test",
    "coproc npm test",
    "coproc worker { npm test; }",
    "cd [first|second] && pnpm test",
    "npm) --version",
    "try { Invoke-WebRequest https://example.com } catch { Write-Error $_ }",
    "for($i=0; $i -lt 2; $i++){ Start-Sleep 1 }",
    "# comment only",
  ])("does not treat shell lookup and commandless wrapper forms as executions: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it.each([
    ["parallel -j4", "parallel"],
    ["hash --help", "hash"],
    ["process --help", "process"],
    ["rem comment", "rem"],
    ["Exec node app.js", "Exec"],
    ["CD /tmp && npm test", "CD"],
  ])("does not hide legitimate or case-distinct program names: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["env sh -c 'cd /tmp && npm test'", "npm"],
    ["sudo zsh -lc 'export CI=1 && pnpm test'", "pnpm"],
  ])("parses shell setup inside an explicitly launched shell: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["nocorrect pnpm test", "pnpm"],
    ["noglob bun test", "bun"],
    ["time node app.js", "node"],
    ["time -p deno test", "deno"],
    ["time nocorrect npm test", "npm"],
  ])("skips shell precommand modifiers: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it("uses the command after leading shell comments", () => {
    expect(commandProgramName("# first comment\n  # second comment\ngit status")).toBe("git");
  });

  it.each([
    ["CI=1 # note\nnpm test", "npm"],
    ["CI=1 # it's configured\nnpm test", "npm"],
    ['CI=1 # "unterminated quote\nbun test', "bun"],
    [">/tmp/log # note\npnpm test", "pnpm"],
    [">/tmp/log # it's configured\ndeno test", "deno"],
  ])("skips comments after commandless shell setup: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["./cd /tmp && npm test", "cd"],
    ["/opt/exec node app.js", "exec"],
    ["/usr/bin/time npm test", "time"],
    ["/usr/bin/test -f package.json", "test"],
  ])("does not treat qualified paths as shell syntax: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it("skips a shell array assignment before the command", () => {
    expect(commandProgramName("items=(one two); npm test")).toBe("npm");
  });

  it.each([
    ['EMU="/opt/android/emulator"; "$EMU" -list-avds', "emulator"],
    ["AAPT=/opt/android/aapt2\n$AAPT dump badging app.apk", "aapt2"],
    [
      'SSH=(ssh -i /tmp/key -o IdentitiesOnly=yes); HOST=user@example; "${SSH[@]}" "$HOST" uptime',
      "ssh",
    ],
    ["SCP=(/usr/bin/scp -i /tmp/key); if true; then ${SCP[@]} file user@example:/tmp; fi", "scp"],
    ['TOOL="/Applications/My Tool/bin/check"; "$TOOL" --verbose', "check"],
  ])("resolves literal command aliases from earlier shell segments: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    'TOOL=$(pick-command); "$TOOL" --version',
    'TOOL="git status"; "$TOOL"',
    "# TOOL=git\n$TOOL status",
    'TOOL=git true; "$TOOL" status',
    'TOOL=git; TOOL=$(pick-command); "$TOOL" status',
    'TOOL=git; unset TOOL; "$TOOL" status',
  ])("does not evaluate dynamic or non-persistent command aliases: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it("does not retain aliases assigned inside control flow", () => {
    expect(commandProgramName('TOOL=git; if false; then\nTOOL=npm\nfi\n"$TOOL" status')).toBe(
      "git",
    );
  });

  it.each([
    ["ROOT=${BASE:-path with spaces}; npm test", "npm"],
    ["ROOT=`printf 'path with spaces'`; pnpm test", "pnpm"],
  ])("keeps expansions inside assignment words: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    [">/tmp/log && npm test", "npm"],
    ["2>/tmp/error.log; pnpm test", "pnpm"],
    ["cd /tmp && >/tmp/log npm test", "npm"],
    ["cd /tmp && > /tmp/log pnpm test", "pnpm"],
    ["cd /tmp && 2>&1 bun test", "bun"],
    ["cd /tmp && 2>& 1 node app.js", "node"],
    ["cd /tmp && &>/tmp/log git status", "git"],
    ["cd /tmp && *>>/tmp/log vp test", "vp"],
    ["cd /tmp && {output}>/tmp/log deno test", "deno"],
    ["cd /tmp && <<<input ruby script.rb", "ruby"],
  ])("skips redirections before the next command: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each([
    ["cd /tmp <<EOF\nnot-a-command\nEOF\nnpm test", "npm"],
    ["cd /tmp <<'EOF'\nnot-a-command\nEOF\npnpm test", "pnpm"],
    ["cd /tmp <<'EOF'\nnot-a-command\\\nEOF\npnpm test", "pnpm"],
    ["cd /tmp <<-EOF\n\tnot-a-command\n\tEOF\nbun test", "bun"],
    ["cd /tmp <<A <<B\none\nA\ntwo\nB\ngit status", "git"],
    ["cd /tmp <<EOF; # setup\nnot-a-command\nEOF\nnpm test", "npm"],
    ["cd /tmp <<EOF && pnpm test\nnot-a-command\nEOF\nbun test", "pnpm"],
  ])("skips heredoc bodies before finding the next command: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each(["cd apps/web && [ -f package.json ]", "cd apps/web || exit 1", "cd one && cd two"])(
    "falls back when no useful program follows cd: %s",
    (command) => {
      expect(commandProgramName(command)).toBeNull();
    },
  );

  it.each([
    "if test -f package.json\nthen\n  npm test\nfi",
    "[[ -d first && -d second ]] && npm test",
    'for file in *\ndo\n  echo "$file"\ndone',
    "while true\ndo\n  sleep 1\ndone",
    "cd /tmp; build () { npm test; }",
  ])("does not label commands inside multiline shell control flow: %s", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });

  it("bounds nested shell unwrapping", () => {
    let command = "git status";
    for (let depth = 0; depth < 9; depth += 1) {
      command = `sh -c '${command.replaceAll("'", "'\\''")}'`;
    }
    expect(commandProgramName(command)).toBeNull();
  });

  it("does not spend the shell nesting budget on setup commands", () => {
    const command = [
      ...Array.from({ length: 10 }, (_, index) => `export VALUE_${index}=configured`),
      "npm test",
    ].join("\n");

    expect(commandProgramName(command)).toBe("npm");
  });

  it("bounds the number of top-level setup segments", () => {
    const command = [
      ...Array.from({ length: 2_000 }, (_, index) => `export VALUE_${index}=configured`),
      "npm test",
    ].join(";");

    expect(commandProgramName(command)).toBeNull();
  });

  it("bounds nested command wrappers", () => {
    expect(commandProgramName(`${"command ".repeat(9)}git status`)).toBeNull();
  });
});
