import { describe, expect, it } from "vite-plus/test";

import { embeddedScripts } from "./embeddedScripts";

/** Each script's language, its text, and the part of the command that spells it. */
function scriptsOf(command: string) {
  return embeddedScripts(command).map((script) => {
    // Every character maps inside the command, in order.
    script.starts.forEach((start, index) => {
      expect(start).toBeLessThan(script.ends[index]!);
      if (index > 0) expect(start).toBeGreaterThanOrEqual(script.ends[index - 1]!);
    });
    return [
      script.language,
      script.text,
      command.slice(script.starts[0], script.ends.at(-1)),
    ] as const;
  });
}

const pythonScript = `from pathlib import Path
import json

# print every package.json name and version
for p in sorted(Path('.').glob('**/package.json')):
    data = json.loads(p.read_text())
    print(f"{data['name']:16} {data.get('version', '?')}")
`;

describe("embeddedScripts", () => {
  it("finds the script inside a Codex login-shell wrapper and the script inside that", () => {
    // Recorded in the turn_interrupt_mid_tool Codex transcript
    // (apps/server/src/orchestration-v2/testkit/fixtures).
    const inner = `console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)`;
    const command = `/bin/bash -lc "node -e \\"${inner}\\""`;
    expect(scriptsOf(command)).toEqual([
      ["shellscript", `node -e "${inner}"`, `node -e \\"${inner}\\"`],
      ["javascript", inner, inner],
    ]);
  });

  it("highlights a heredoc fed to an interpreter in that interpreter's language", () => {
    const command = `python3 - <<'PY'\n${pythonScript}PY`;
    expect(scriptsOf(command)).toEqual([["python", pythonScript, pythonScript]]);
  });

  it("maps escaped characters back to both source characters", () => {
    const command = `/bin/zsh -lc "python3 - <<'PY'\nprint(\\"\\$HOME\\")\nPY"`;
    const [shell, python] = scriptsOf(command);
    expect(shell?.[1]).toBe(`python3 - <<'PY'\nprint("$HOME")\nPY`);
    expect(python).toEqual(["python", `print("$HOME")\n`, `print(\\"\\$HOME\\")\n`]);
  });

  it.each([
    [`python3 -c 'print(1)'`, "python", "print(1)"],
    [`python3 -X dev -c 'print(1)'`, "python", "print(1)"],
    [`node --eval "process.exit(0)"`, "javascript", "process.exit(0)"],
    [`bun -e 'console.log(Bun.version)'`, "typescript", "console.log(Bun.version)"],
    [`deno eval 'console.log(1)'`, "typescript", "console.log(1)"],
    [`deno eval --config deno.json 'console.log(1)'`, "typescript", "console.log(1)"],
    [`node -C development -e 'console.log(1)'`, "javascript", "console.log(1)"],
    [`ruby -e 'puts 1'`, "ruby", "puts 1"],
    [`ruby -I lib -e 'puts 1'`, "ruby", "puts 1"],
    [`perl -E 'say 1'`, "perl", "say 1"],
    [`sqlite3 app.db "select * from users"`, "sql", "select * from users"],
    [`psql -d app -c 'select 1'`, "sql", "select 1"],
    [`pwsh -NoProfile -Command "Get-ChildItem"`, "powershell", "Get-ChildItem"],
    [`env FOO=1 sudo -u bob python3 -c 'print(1)'`, "python", "print(1)"],
    [`env -- FOO=1 python3 -c 'print(1)'`, "python", "print(1)"],
    [`node --eval="process.exit(0)"`, "javascript", "process.exit(0)"],
    [`psql --command='select 1'`, "sql", "select 1"],
    [`mysql -c -e 'select 1'`, "sql", "select 1"],
    [`mysql -f app <<'EOF'\nselect 1;\nEOF`, "sql", "select 1;\n"],
    [`psql app <<'EOF'\nselect 1;\nEOF`, "sql", "select 1;\n"],
    [`echo "$(node -e 'console.log(1)')"`, "javascript", "console.log(1)"],
    [`python3 <<< 'print(1)'`, "python", "print(1)"],
  ])("finds the inline script in %s", (command, language, script) => {
    expect(scriptsOf(command)).toEqual([[language, script, expect.any(String)]]);
  });

  it.each([[`psql -c 'select 1' -c 'select 2'`], [`sqlite3 app.db "select 1" "select 2"`]])(
    "finds every statement a SQL shell runs: %s",
    (command) => {
      expect(scriptsOf(command).map(([language, text]) => [language, text])).toEqual([
        ["sql", "select 1"],
        ["sql", "select 2"],
      ]);
    },
  );

  it.each([
    ["the file `cat` writes", `cat > src/app.ts <<'EOF'\nconst a = 1;\nEOF`, "typescript"],
    ["the file `tee` writes", `tee -a config.json <<EOF\n{}\nEOF`, "json"],
    ["its delimiter", `kubectl apply -f - <<'YAML'\nkind: Pod\nYAML`, "yaml"],
    ["the shell reading it", `bash <<'EOF'\necho hi\nEOF`, "shellscript"],
  ])("takes a heredoc's language from %s", (_source, command, language) => {
    expect(scriptsOf(command).map(([lang]) => lang)).toEqual([language]);
  });

  it.each([
    ["a script file", `python3 build.py <<EOF\ndata\nEOF`],
    ["a module", `python3 -m json.tool <<EOF\n{}\nEOF`],
    ["a SQL file", `psql -f migrate.sql <<EOF\ny\nEOF`],
    ["a SQL file given with =", `psql --file=migrate.sql <<EOF\ny\nEOF`],
    ["plain commands", `rg -n "foo" src && git status`],
    ["an unnamed heredoc into a plain command", `git commit -F - <<'EOF'\nfix: x\nEOF`],
    ["an empty script", `bash -lc '   '`],
    ["a heredoc `cat` sends to stdout while stderr goes to a file", `cat 2>log.ts <<'EOF'\nx\nEOF`],
  ])("finds nothing for %s", (_case, command) => {
    expect(scriptsOf(command)).toEqual([]);
  });

  it("trusts nothing in a command whose quoting does not parse", () => {
    // Codex's secret redaction dropped the backslash of an escaped quote, so
    // the -lc argument ends early and the rest no longer balances.
    const command = `/bin/zsh -lc "python3 -c 'token=[REDACTED_SECRET]"apiToken\\"]; print(token)'"`;
    expect(scriptsOf(command)).toEqual([]);
  });
});
