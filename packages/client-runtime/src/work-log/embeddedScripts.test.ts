import { describe, expect, it } from "vite-plus/test";

import { embeddedScripts, withEmbeddedScripts } from "./embeddedScripts.ts";

function scriptsOf(command: string) {
  return embeddedScripts(command).map((script) => {
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
    const inner = `console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)`;
    const command = `/bin/bash -lc "node -e \\"${inner}\\""`;
    expect(scriptsOf(command)).toEqual([
      ["shellscript", `node -e "${inner}"`, `node -e \\"${inner}\\"`],
      ["javascript", inner, inner],
    ]);
  });

  it("skips the -- that ends a login shell's options before the script", () => {
    expect(scriptsOf(`bash -lc -- "python3 -c 'print(1)'"`)).toEqual([
      ["shellscript", "python3 -c 'print(1)'", "python3 -c 'print(1)'"],
      ["python", "print(1)", "print(1)"],
    ]);
  });

  it.each([
    [`bash -c -e "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -c +e "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -c -e -- "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -c - "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -c -o pipefail "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -co pipefail "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -c -oe pipefail "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -oc pipefail "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [`bash -c +o errexit "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
    [
      `zsh -oextendedglob -c "python3 -c 'print(1)'"`,
      "python3 -c 'print(1)'",
      "python",
      "print(1)",
    ],
    [`zsh -c --errexit "python3 -c 'print(1)'"`, "python3 -c 'print(1)'", "python", "print(1)"],
  ])(
    "extracts nested scripts across POSIX shell options in %s",
    (command, shellScript, nestedLanguage, nestedScript) => {
      expect(scriptsOf(command).map(([language, text]) => [language, text])).toEqual([
        ["shellscript", shellScript],
        [nestedLanguage, nestedScript],
      ]);
    },
  );

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

  it("maps attached short inline scripts back to exact source offsets", () => {
    expect(scriptsOf(`bash -lc "python3 -c'print(\\"\\$HOME\\")'"`)).toEqual([
      ["shellscript", `python3 -c'print("$HOME")'`, `python3 -c'print(\\"\\$HOME\\")'`],
      ["python", `print("$HOME")`, `print(\\"\\$HOME\\")`],
    ]);
    expect(scriptsOf("python3 -c'x = 1\nprint(x)'")).toEqual([
      ["python", "x = 1\nprint(x)", "x = 1\nprint(x)"],
    ]);
  });

  it.each([
    [`bash -Ec 'echo hi'`, "shellscript", "echo hi"],
    [`bash -euo pipefail -c 'echo hi'`, "shellscript", "echo hi"],
    [`bash +x -c 'echo hi'`, "shellscript", "echo hi"],
    [`bash -c -- -e`, "shellscript", "-e"],
    [`sh --rcfile /dev/null -c 'echo SCRIPT'`, "shellscript", "echo SCRIPT"],
    [`fish -c -e "python3 -c 'print(1)'"`, "fish", "-e"],
    [`python3 -c 'print(1)'`, "python", "print(1)"],
    [`py -3 -c 'print(1)'`, "python", "print(1)"],
    [`"C:\\Program Files\\Python312\\python.exe" -c 'print(1)'`, "python", "print(1)"],
    [`node --eval "process.exit(0)"`, "javascript", "process.exit(0)"],
    [`bun -e 'console.log(Bun.version)'`, "typescript", "console.log(Bun.version)"],
    [`deno eval 'console.log(1)'`, "typescript", "console.log(1)"],
    [`deno eval --config deno.json 'console.log(1)'`, "typescript", "console.log(1)"],
    [`psql -f schema.sql -c 'select 1'`, "sql", "select 1"],
    [`node -C development -e 'console.log(1)'`, "javascript", "console.log(1)"],
    [
      `node --input-type module -e "import fs from 'node:fs'"`,
      "javascript",
      "import fs from 'node:fs'",
    ],
    [
      `node --env-file .env -e 'console.log(process.env.FOO)'`,
      "javascript",
      "console.log(process.env.FOO)",
    ],
    [`node --env-file-if-exists .env.local -e 'console.log(1)'`, "javascript", "console.log(1)"],
    [`node --experimental-loader ./loader.mjs -e 'console.log(1)'`, "javascript", "console.log(1)"],
    [`ruby -e 'puts 1'`, "ruby", "puts 1"],
    [`ruby -I lib -e 'puts 1'`, "ruby", "puts 1"],
    [`ruby -ne 'print if /foo/' input.txt`, "ruby", "print if /foo/"],
    [`python3 -uc 'print(1)'`, "python", "print(1)"],
    [`python3 -c'print(1)'`, "python", "print(1)"],
    [`python3 -uc'print(1)'`, "python", "print(1)"],
    [`python3 -Rc'print(42)'`, "python", "print(42)"],
    [`python3 -uXdev -c'print(42)'`, "python", "print(42)"],
    [`python3 -uWignore -c'print(42)'`, "python", "print(42)"],
    [`node -pe 'process.version'`, "javascript", "process.version"],
    [`perl -E 'say 1'`, "perl", "say 1"],
    [`perl -e'print 1'`, "perl", "print 1"],
    [`perl -E'say 1'`, "perl", "say 1"],
    [`perl -pe 's/foo/bar/' input.txt`, "perl", "s/foo/bar/"],
    [`perl -pe's/a/b/' input.txt`, "perl", "s/a/b/"],
    [`perl -0e'print 1'`, "perl", "print 1"],
    [`perl -0777e'print 1'`, "perl", "print 1"],
    [`perl -l0123e 'print 42'`, "perl", "print 42"],
    [`perl -l0777e'print 1'`, "perl", "print 1"],
    [`perl -0777ne 'print length' input.txt`, "perl", "print length"],
    [`perl -I lib -Mstrict -pe 's/foo/bar/' input.txt`, "perl", "s/foo/bar/"],
    [`perl -nwIlib -e'print 1'`, "perl", "print 1"],
    [`perl -e'print 1;' file.txt -e 'print 2'`, "perl", "print 1;"],
    [`ruby -e'puts 1'`, "ruby", "puts 1"],
    [`ruby -ne'puts $_' input.txt`, "ruby", "puts $_"],
    [`ruby -0e'puts 42'`, "ruby", "puts 42"],
    [`ruby -0777e'puts 42'`, "ruby", "puts 42"],
    [`ruby -W0e'puts 42'`, "ruby", "puts 42"],
    [`ruby -W2e'puts 42'`, "ruby", "puts 42"],
    [`ruby -Kue'puts 42'`, "ruby", "puts 42"],
    [`ruby -wIlib -e'puts 42'`, "ruby", "puts 42"],
    [`ruby -e'puts 1' -- -e'puts 2'`, "ruby", "puts 1"],
    [`sqlite3 app.db "select * from users"`, "sql", "select * from users"],
    [`pwsh -NoProfile -Command "Get-ChildItem"`, "powershell", "Get-ChildItem"],
    [`env FOO=1 sudo -u bob python3 -c 'print(1)'`, "python", "print(1)"],
    [`env -- FOO=1 python3 -c 'print(1)'`, "python", "print(1)"],
    [`timeout 30 python3 -c 'print(1)'`, "python", "print(1)"],
    [`gtimeout 30 python3 -c 'print(1)'`, "python", "print(1)"],
    [`timeout -k 5 30s node -e 'console.log(1)'`, "javascript", "console.log(1)"],
    [`timeout -k5s -v -sKILL 10 bash -c 'echo hi'`, "shellscript", "echo hi"],
    [`timeout --kill-after 5 --signal KILL 30 bash -c 'echo hi'`, "shellscript", "echo hi"],
    [`timeout -fk 5 1.5m bash -c 'echo hi'`, "shellscript", "echo hi"],
    [`timeout -s KILL -v -- 0 bash -c 'echo hi'`, "shellscript", "echo hi"],
    [`timeout 30 env FOO=1 python3 -c 'print(1)'`, "python", "print(1)"],
    [`node --eval="process.exit(0)"`, "javascript", "process.exit(0)"],
    [`psql --command='select 1'`, "sql", "select 1"],
    [`mysql -c -e 'select 1'`, "sql", "select 1"],
    [`psql app <<'EOF'\nselect 1;\nEOF`, "sql", "select 1;\n"],
    [`echo "$(node -e 'console.log(1)')"`, "javascript", "console.log(1)"],
    [`python3 <<< 'print(1)'`, "python", "print(1)"],
  ])("finds the inline script in %s", (command, language, script) => {
    expect(scriptsOf(command)).toEqual([[language, script, expect.any(String)]]);
  });

  it.each([
    [
      `perl -e'print 1;' -E 'say 2'`,
      [
        ["perl", "print 1;", "print 1;"],
        ["perl", "say 2", "say 2"],
      ],
    ],
    [
      `ruby -e'puts 1' -e 'puts 2'`,
      [
        ["ruby", "puts 1", "puts 1"],
        ["ruby", "puts 2", "puts 2"],
      ],
    ],
  ])("finds repeated inline scripts in %s", (command, expected) => {
    expect(scriptsOf(command)).toEqual(expected);
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
    ["a perl -i backup suffix of e", `perl -pie 's/foo/bar/' input.txt`],
    ["a ruby -i backup suffix of e", `ruby -ie 'puts 1' input.txt`],
    ["a python -W value of c", `python3 -Wc 'print(1)'`],
    ["an attached python -W value starting with c", `python3 -Wc'print(1)'`],
    ["a bundled python -X consuming the next arg", `python3 -uX -c'print(42)'`],
    ["a bundled python -W consuming the next arg", `python3 -uW -c'print(42)'`],
    ["an attached python -m module before -c", `python3 -mthis -c'print(42)'`],
    ["a bundled attached python -m module before -c", `python3 -umthis -c'print(42)'`],
    ["a bundled python -m module before -c", `python3 -um this -c'print(42)'`],
    ["an attached perl -M module starting with e", `perl -Me'print 1'`],
    ["a bundled perl -I consuming the next arg", `perl -nwI -e'print 1'`],
    ["an invalid perl octal switch without leading 0", `perl -7e'print 1'`],
    ["a 4-digit perl -l octal switch without leading 0", `perl -l7777e'print 1'`],
    ["an attached ruby -r require starting with e", `ruby -re'puts 1'`],
    ["a ruby -K option consuming e as its encoding", `ruby -Ke 'puts 42'`],
    ["a bundled ruby -I consuming the next arg", `ruby -wI -e'puts 42'`],
    ["a bundled ruby -r consuming the next arg", `ruby -wr -e'puts 42'`],
    ["a bundled ruby -C consuming the next arg", `ruby -wC -e'puts 42'`],
    ["a ruby -W category before e", `ruby -W:deprecatede'puts 42'`],
    ["a node -e flag with an attached value", `node -e'console.log(1)'`],
    ["an attached inline flag after --", `python3 -- -c'print(1)'`],
    [
      "a whitespace-only attached inline script before a heredoc",
      `python3 -c'   ' <<'EOF'\nprint(2)\nEOF`,
    ],
    ["an empty attached python -c before a heredoc", `python3 -c'' <<'EOF'\nprint(2)\nEOF`],
    ["an empty attached perl -e before a heredoc", `perl -e'' <<'EOF'\nprint 2\nEOF`],
    ["an empty attached ruby -e before a heredoc", `ruby -e'' <<'EOF'\nputs 2\nEOF`],
    ["an empty separate python -c before a heredoc", `python3 -c '' <<'EOF'\nprint(2)\nEOF`],
    ["a bare python -c before a heredoc", `python3 -c <<'EOF'\nprint(2)\nEOF`],
    ["a bare psql -c before a heredoc", `psql -c <<'EOF'\nselect 1;\nEOF`],
    ["a shell whose -c has no script, before a heredoc", `sh -c -- <<'EOF'\necho hi\nEOF`],
    [
      "a shell whose -c has only trailing options before a heredoc",
      `sh -c -e <<'EOF'\necho hi\nEOF`,
    ],
    [
      "a shell whose -co option has no script after its option value",
      `bash -co pipefail <<'EOF'\necho hi\nEOF`,
    ],
    [
      "a shell with a GNU long option after -c",
      `bash -c --rcfile /dev/null "python3 -c 'print(1)'"`,
    ],
    ["a heredoc `cat` sends to stdout while stderr goes to a file", `cat 2>log.ts <<'EOF'\nx\nEOF`],
  ])("finds nothing for %s", (_case, command) => {
    expect(scriptsOf(command)).toEqual([]);
  });

  it("trusts nothing in a command whose quoting does not parse", () => {
    // Secret redaction removed an escaped quote's backslash, breaking the -lc argument.
    const command = `/bin/zsh -lc "python3 -c 'token=[REDACTED_SECRET]"apiToken\\"]; print(token)'"`;
    expect(scriptsOf(command)).toEqual([]);
  });
});

describe("withEmbeddedScripts", () => {
  function tokenize(text: string, language: string) {
    if (language === "unknown") throw new Error("Language not found");
    let lineStart = 0;
    return text.split(/\r?\n/u).map((line) => {
      const tokens = [...line.matchAll(/\S+|\s+/gu)].map((match) => ({
        content: match[0],
        offset: lineStart + match.index,
        color: language,
      }));
      lineStart +=
        line.length + (text.slice(lineStart + line.length).match(/^\r?\n/u)?.[0].length ?? 0);
      return tokens;
    });
  }

  function colorsOf(code: string, scripts = embeddedScripts(code)) {
    const lines = withEmbeddedScripts(code, tokenize(code, "shellscript"), scripts, tokenize);
    expect(lines.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
      code.replaceAll("\r\n", "\n"),
    );
    return lines.flat().map((token) => [token.content, token.color]);
  }

  it("colors each nested script with its own grammar, keeping the text", () => {
    expect(colorsOf(`bash -lc "python3 -c 'print(1)'"`)).toEqual([
      [`bash -lc "python3 -c '`, "shellscript"],
      ["print(1)", "python"],
      [`'"`, "shellscript"],
    ]);
  });

  it("colors an escape sequence like the character it spells", () => {
    expect(colorsOf(`bash -c "python3 -c 'print(\\"x\\")'"`)).toContainEqual([
      `print(\\"x\\")`,
      "python",
    ]);
  });

  it("keeps the surrounding colors where a grammar is missing", () => {
    const code = "cat > x.ts <<'EOF'\r\nbody\r\nEOF";
    const [script] = embeddedScripts(code);
    const characterColors = (scripts: ReturnType<typeof embeddedScripts>) =>
      colorsOf(code, scripts).flatMap(([content, color]) => [...content!].map(() => color));
    expect(characterColors([{ ...script!, language: "unknown" }])).toEqual(characterColors([]));
  });
});
