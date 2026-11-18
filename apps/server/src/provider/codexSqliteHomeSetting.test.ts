import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexConfigSetsSqliteHome } from "./codexSqliteHomeSetting.ts";

// Each row was run through Codex 0.170.0, which opened its databases in the named directory for
// the first table and in CODEX_HOME for the second.
describe("codexConfigSetsSqliteHome", () => {
  it.each([
    ["a root key", 'model = "gpt"\nsqlite_home = "C:\\\\shadow"\n'],
    ["a root key without a final newline", "sqlite_home='/shadow'"],
    ["a quoted key", '"sqlite_home" = "/shadow"\n'],
    ["a literal-quoted key", "'sqlite_home' = '/shadow'\n"],
    ["an escaped key", '"sqlite\\u005fhome" = "/shadow"\n'],
    ["a key with a long escape", '"sqlite\\U0000005Fhome" = "/shadow"\n'],
    ["a key with a hex escape", '"sqlite\\x5fhome" = "/shadow"\n'],
    ["a byte order mark, tabs and CRLF", '\uFEFF\t sqlite_home\t =\t"/shadow"\r\n'],
    [
      "a key after arrays whose lines open with a bracket",
      'notify = [\n  "a", # ]\n]\nmatrix = [\n[1, 2],\n[3, 4],\n]\nsqlite_home = "/shadow"\n',
    ],
    ["a key after a string that ends in a quote", 'note = """a""""\nsqlite_home = "/shadow"\n'],
    [
      "a key after a literal string holding a table header",
      "note = '''\n[fake]\n'''\nsqlite_home = '/shadow'\n",
    ],
    [
      "a key after a comment and a value that hold string and table syntax",
      '# """\nnote = "a # [b]" # [not.a.table]\nsqlite_home = "/shadow"\n',
    ],
    ["a key before the first table", 'sqlite_home = "/shadow"\n[features]\nx = true\n'],
  ])("finds %s", (_name, config) => {
    NodeAssert.equal(codexConfigSetsSqliteHome(config), true);
  });

  // regression: #24486 every line that looked like the key counted, whatever table or string
  // held it.
  it.each([
    ["no config", ""],
    ["a comment", '# sqlite_home = "/shadow"\nmodel = "gpt"\n'],
    [
      "an MCP server's variable",
      '[mcp_servers.example]\ncommand = "echo"\n[mcp_servers.example.env]\nsqlite_home = "an MCP-only value"\n',
    ],
    ["a table's key", "[features]\nx = true\n  \"sqlite_home\"='/shadow'\n"],
    ["an array table's key", '[[skills.config]]\npath = "x"\nsqlite_home = "/shadow"\n'],
    [
      "text in a multi-line string",
      'developer_instructions = """\nKeep this text.\nsqlite_home = "somewhere"\n"""\nmodel = "gpt"\n',
    ],
    [
      "text in a multi-line literal string",
      "developer_instructions = '''\nsqlite_home = 'somewhere'\n'''\n",
    ],
    ["a key of a multi-line inline table", 'unused = {\n  sqlite_home = "/shadow"\n}\n'],
    ["a key of another root table", 'tools.sqlite_home = "/shadow"\n'],
    // Codex reads neither of these as a path and falls back to its defaults.
    ["a table named sqlite_home", "sqlite_home.x = 1\n"],
    ["a table header named sqlite_home", "[sqlite_home]\nx = 1\n"],
    ["a quoted key that spells out the escape", '"sqlite\\\\u005fhome" = "/shadow"\n'],
    ["a longer key", 'codex_sqlite_home = "/shadow"\nsqlite_home_dir = "/shadow"\n'],
  ])("ignores %s", (_name, config) => {
    NodeAssert.equal(codexConfigSetsSqliteHome(config), false);
  });

  // Codex 0.170.0 drops a config it cannot parse, but where the string or array was meant to
  // end is a guess.
  it.each([
    ["an unclosed multi-line string", 'note = """\nsqlite_home = "/shadow"\n'],
    ["an unclosed array", 'notify = [\n"a",\nsqlite_home = "/shadow"\n'],
    ["an unclosed string", 'note = "a\nsqlite_home = "/shadow"\n'],
  ])("finds the key after %s", (_name, config) => {
    NodeAssert.equal(codexConfigSetsSqliteHome(config), true);
  });
});
