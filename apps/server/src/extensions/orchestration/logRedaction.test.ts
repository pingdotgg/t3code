import { expect, it } from "@effect/vitest";
import {
  keyStateAfter,
  LOG_REDACTED as R,
  measureLogRedaction,
  redactLogSecrets,
} from "./logRedaction.ts";

it("scrubs env assignments, credential fields, headers, and token shapes", () => {
  const cases: [string, string][] = [
    ["OPENAI_API_KEY=abc123", `OPENAI_API_KEY=${R}`],
    ['export GH_TOKEN="two words"', `export GH_TOKEN="${R}"`],
    ["DB_PASSWORD='hunter2' next", `DB_PASSWORD='${R}' next`],
    ['{"apiKey": "k-1", "accessToken":"t-2"}', `{"apiKey": "${R}", "accessToken":"${R}"}`],
    ['"{\\"client_secret\\":\\"s-3\\"}"', `"{\\"client_secret\\":\\"${R}\\"}"`],
    ["Authorization: Bearer abc.def", `Authorization: Bearer ${R}`],
    ["cookie: a=1; b=2", `cookie: ${R}`],
    ["token Bearer abcdefghijkl", `token Bearer ${R}`],
    ["use ghp_" + "a".repeat(36) + " now", `use ${R} now`],
    ["AKIAABCDEFGHIJKLMNOP", R],
    ["https://user:pass@example.com/x", `https://${R}@example.com/x`],
  ];
  for (const [input, output] of cases) expect(redactLogSecrets(input), input).toBe(output);
});

it("keeps ordinary content and line structure", () => {
  const plain = '{"input_tokens": 12, "author": "Ada", "tokens": "many"}\nPWD=/work\nbasic idea\n';
  expect(redactLogSecrets(plain)).toBe(plain);
  const pem = "a\n-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\nb";
  expect(redactLogSecrets(pem)).toBe(`a\n${R}\n${R}\n${R}\n${R}\nb`);
  // A key whose BEGIN line was cut away before the read.
  expect(redactLogSecrets("CCCC\n-----END RSA PRIVATE KEY-----\nz")).toBe(`${R}\n${R}\nz`);
});

it("consumes escaped quotes inside credential values", () => {
  const json = String.raw`{"password":"first\"remaining-secret-123"}`;
  expect(redactLogSecrets(json)).toBe(`{"password":"${R}"}`);
  // The same JSON escaped inside a transcript record's content field.
  const record = JSON.stringify({ type: "tool_result", content: json });
  const redacted = redactLogSecrets(record);
  expect(redacted).not.toContain("remaining");
  expect(JSON.parse(redacted)).toEqual({ type: "tool_result", content: `{"password":"${R}"}` });
  // An escaped trailing backslash closes the value; the next field survives.
  const trailing = JSON.stringify({ content: String.raw`{"token":"a\\"}`, next: "keep" });
  expect(JSON.parse(redactLogSecrets(trailing))).toEqual({
    content: `{"token":"${R}"}`,
    next: "keep",
  });
  expect(redactLogSecrets(String.raw`PASSWORD="first\"remaining-secret-123" next`)).toBe(
    `PASSWORD="${R}" next`,
  );
});

it("redacts from any BEGIN marker through END, or to the end, even in prose", () => {
  // Prose that mentions BEGIN cannot be told from command output mid-key, so
  // it loses the rest of the text (accepted over-redaction).
  const prose =
    "The test checks the literal -----BEGIN PRIVATE KEY----- marker.\nBuild passed.\nCommitted the fix.\n";
  expect(redactLogSecrets(prose)).toBe(`The test checks the literal ${R}\n${R}\n${R}\n`);
  expect(redactLogSecrets("See -----END PRIVATE KEY----- too")).toBe(
    "See -----END PRIVATE KEY----- too",
  );
  expect(redactLogSecrets("-----BEGIN PRIVATE KEY-----\nBuild passed.\n")).toBe(`${R}\n${R}\n`);
  // Interleaved non-key lines do not end an unfinished key.
  expect(
    redactLogSecrets("ok\n-----BEGIN PRIVATE KEY-----\nAAAA\n[progress]\nUNIQUESECRET\n"),
  ).toBe(`ok\n${R}\n${R}\n${R}\n${R}\n`);
  expect(
    redactLogSecrets(
      "-----BEGIN PRIVATE KEY-----\nAAAA\n[progress]\nUNIQUESECRET\n-----END PRIVATE KEY-----\nafter\n",
    ),
  ).toBe(`${R}\n${R}\n${R}\n${R}\n${R}\nafter\n`);
  // A key escaped inside a transcript record, with headers and a blank line.
  const key =
    "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nMIIEowIBAAKC\nQQQQ==\n-----END RSA PRIVATE KEY-----\n";
  const record = JSON.stringify({ content: key });
  expect(JSON.parse(redactLogSecrets(`${record}`))).toEqual({ content: `${R}\n` });
  expect(redactLogSecrets(`${record}\n{"content":"Build passed."}`)).toContain("Build passed.");
  // An escaped key tail whose BEGIN line fell before the read.
  expect(
    JSON.parse(
      redactLogSecrets(JSON.stringify({ content: "CCCC\nDDDD\n-----END PRIVATE KEY-----\n" })),
    ),
  ).toEqual({ content: `${R}\n` });
  // A key cut off by the end of the read stays redacted through the end.
  expect(redactLogSecrets("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nBgkqhk")).toBe(
    `${R}\n${R}\n${R}`,
  );
});

it("redacts every line of a key whose lines carry spaces or tabs", () => {
  const blocks = [
    // Trailing whitespace, then spaces and a tab inside base64 lines.
    "-----BEGIN PRIVATE KEY-----\nAAAA \nBBBB \n-----END PRIVATE KEY-----\n",
    "-----BEGIN PRIVATE KEY-----\nAA AA\nBB\tBB \t\n  CC CC\n-----END PRIVATE KEY-----\n",
  ];
  for (const block of blocks) {
    const lines = block.split("\n").length - 1;
    const whole = `${R}\n`.repeat(lines);
    expect(redactLogSecrets(block), block).toBe(whole);
    expect(JSON.parse(redactLogSecrets(JSON.stringify({ content: block })))).toEqual({
      content: `${R}\n`,
    });
    // Truncated tail: the BEGIN line fell before the read.
    const tail = block.slice(block.indexOf("\n") + 1);
    expect(redactLogSecrets(tail), tail).toBe(`${R}\n`.repeat(lines - 1));
    const escaped = redactLogSecrets(JSON.stringify({ content: tail }));
    expect(JSON.parse(escaped)).toEqual({ content: `${R}\n` });
    // Truncated end: the read stops inside the key.
    const cut = block.slice(0, block.indexOf("-----END"));
    expect(redactLogSecrets(cut), cut).toBe(whole.slice(0, -`${R}\n`.length));
    // Unfinished inside a string, it runs to the end of the text.
    expect(redactLogSecrets(JSON.stringify({ content: cut }))).toBe(`{"content":"${R}`);
    // Truncated inside the last key line: no break before the end of the
    // read or the closing JSON quote.
    const open = cut.slice(0, -1);
    expect(redactLogSecrets(open), open).toBe(whole.slice(0, -`${R}\n`.length - 1));
    expect(redactLogSecrets(JSON.stringify({ content: open }))).toBe(`{"content":"${R}`);
  }
});

it("redacts a key cut off inside a JSON string, even on one spaced line", () => {
  // Regression: the closing quote ends the last base64 line.
  expect(
    redactLogSecrets(JSON.stringify({ content: "-----BEGIN PRIVATE KEY-----\nAAAA \nBBBB" })),
  ).toBe(`{"content":"${R}`);
  const line = Array.from({ length: 29 }, (_, i) => `${"MIIE".repeat(14)}${i}`).join(" ");
  const record = JSON.stringify({ content: `-----BEGIN RSA PRIVATE KEY-----\n${line}` });
  expect(redactLogSecrets(`${record}\n{"next":"line"}`)).toBe(`{"content":"${R}\n${R}`);
});

it("redacts every line after an unfinished BEGIN marker, whatever it holds", () => {
  // Whitespace-only lines are kept, so line structure still shows.
  expect(redactLogSecrets("-----BEGIN PRIVATE KEY-----\nBuild passed 42\n  \ndone.\n")).toBe(
    `${R}\n${R}\n  \n${R}\n`,
  );
});

// Wraps `text` as the content of a transcript record `depth` times, so each
// level escapes the one inside it again (`"` becomes `\"`, then `\\\"`).
const nest = (text: string, depth: number) => {
  let result = text;
  for (let level = 0; level < depth; level += 1) result = JSON.stringify({ content: result });
  return result;
};
const unnest = (text: string, depth: number) => {
  let result: unknown = text;
  for (let level = 0; level < depth; level += 1)
    result = (JSON.parse(result as string) as { content: string }).content;
  return result as string;
};

it("redacts credential fields and keys at every escaping depth", () => {
  const field = String.raw`{"api_key":"sk-live\"quoted\\tail","client_secret":"s-3\\","next":"keep"}`;
  const key =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\nQQQQ==\n-----END RSA PRIVATE KEY-----\n";
  for (const depth of [1, 2, 3]) {
    const redacted = redactLogSecrets(nest(field, depth));
    expect(redacted, `field depth ${depth}`).not.toMatch(/sk-live|quoted|tail|s-3/);
    expect(unnest(redacted, depth)).toBe(`{"api_key":"${R}","client_secret":"${R}","next":"keep"}`);
    expect(unnest(redactLogSecrets(nest(key, depth)), depth), `key depth ${depth}`).toBe(`${R}\n`);
    // A key tail whose BEGIN line fell before the read, and one cut off at END.
    const tail = key.slice(key.indexOf("\n") + 1);
    expect(unnest(redactLogSecrets(nest(tail, depth)), depth)).toBe(`${R}\n`);
    const cut = nest(key.slice(0, key.indexOf("-----END")), depth);
    expect(redactLogSecrets(cut)).toBe(`${cut.slice(0, cut.indexOf("-----BEGIN"))}${R}`);
    // Environment assignments quoted inside a nested string.
    expect(unnest(redactLogSecrets(nest('GH_TOKEN="gho-1 2"', depth)), depth)).toBe(
      `GH_TOKEN="${R}"`,
    );
  }
});

it("never leaks secrets when the read stops at any byte, or starts at any line", () => {
  // `shapeLogTail` drops a region's partial first line before redacting, so a
  // read starts at a line, raw or escaped; the file being written can stop
  // the read at any byte, including inside an escape.
  const key =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nBgkqhkiG9w0B\n-----END PRIVATE KEY-----\n";
  const secrets = ["MIIEvQIBADAN", "BgkqhkiG9w0B", "sk-nested-VALUE-42"];
  // Any five characters of a secret surviving redaction is a leak.
  const leaks = (redacted: string) =>
    secrets.some((secret) =>
      [...secret].some(
        (_, i) => i + 5 <= secret.length && redacted.includes(secret.slice(i, i + 5)),
      ),
    );
  for (const depth of [1, 2, 3]) {
    const record = nest(`${key}{"password":"sk-nested-VALUE-42"}`, depth);
    const lineBreak = "\\".repeat(2 ** (depth - 1)) + "n";
    for (let at = 0; at <= record.length; at += 1) {
      const part = record.slice(0, at);
      expect(leaks(redactLogSecrets(part)), `depth ${depth} stop ${at}`).toBe(false);
    }
    for (let at = record.indexOf(lineBreak); at !== -1; at = record.indexOf(lineBreak, at + 1)) {
      const part = record.slice(at + lineBreak.length);
      expect(leaks(redactLogSecrets(part)), `depth ${depth} start ${at}`).toBe(false);
    }
  }
});

it("keeps nested lookalikes that are not secrets", () => {
  const plain = String.raw`{"input_tokens":12,"author":"Ada","tokens":"many","note":"a \"token\" and \\ path"}`;
  const prose = "See -----END PRIVATE KEY----- too.\nbasic idea\nPWD=/work";
  for (const depth of [1, 2, 3]) {
    for (const text of [plain, prose]) {
      const nested = nest(text, depth);
      expect(redactLogSecrets(nested), `depth ${depth}`).toBe(nested);
    }
  }
});

it("reads names, delimiters, and key line breaks spelled as unicode escapes", () => {
  const cases = [
    // Quotes spelled \u0022 inside an escaped record.
    String.raw`{"content":"{\u0022password\u0022:\u0022UNIQUESECRET\u0022}"}`,
    // A name spelled with an escape, plain and escaped inside a record.
    String.raw`{"\u0070assword":"UNIQUESECRET"}`,
    JSON.stringify({ content: String.raw`{"\u0070assword":"UNIQUESECRET"}` }),
    // An escaped quote spelled \u0022 inside the value.
    JSON.stringify({ content: String.raw`{"password":"first\u0022UNIQUESECRET"}` }),
    // A mis-escaped quote inside a nested value.
    String.raw`{"content":"{\"password\":\"first\\"UNIQUESECRET\"}"}`,
    // Key line breaks spelled \u000a, with and without the BEGIN line.
    String.raw`{"content":"-----BEGIN PRIVATE KEY-----\u000aUNIQUESECRET\u000a-----END PRIVATE KEY-----"}`,
    String.raw`{"content":"UNIQUESECRET\u000a-----END PRIVATE KEY-----"}`,
  ];
  for (const input of cases) expect(redactLogSecrets(input), input).not.toContain("UNIQUESECRET");
  expect(JSON.parse(redactLogSecrets(cases[0]!))).toEqual({ content: `{"password":"${R}"}` });
});

it("redacts the whole JSON value after a secret-bearing name", () => {
  const cases: [string, string][] = [
    ['{"password":123456789}', `{"password":"${R}"}`],
    ['{"credentials":["UNIQUESECRET"],"next":"keep"}', `{"credentials":"${R}","next":"keep"}`],
    ['{"auth":{"user":"a","pass":"UNIQUESECRET"},"n":1}', `{"auth":"${R}","n":1}`],
    ['{"password":\r\n"UNIQUESECRET"}', `{"password":\r\n"${R}"}`],
    ['{"password" \t:\n 12}', `{"password" \t:\n "${R}"}`],
    // Names normalize case, camelCase, and `-`, `_`, `.` separators.
    ['{"api.key":"UNIQUESECRET"}', `{"api.key":"${R}"}`],
    ['{"API-Key":"UNIQUESECRET","Client.Secret":"x"}', `{"API-Key":"${R}","Client.Secret":"${R}"}`],
    [
      '{"GH_TOKEN_SCOPE":"repo","accessToken":true}',
      `{"GH_TOKEN_SCOPE":"${R}","accessToken":"${R}"}`,
    ],
  ];
  for (const [input, output] of cases) {
    expect(redactLogSecrets(input), input).toBe(output);
    for (const depth of [1, 2, 3])
      expect(unnest(redactLogSecrets(nest(input, depth)), depth), `${input} ${depth}`).toBe(output);
  }
  // A value spanning lines keeps the line count.
  const pretty = JSON.stringify({ credentials: ["UNIQUESECRET", "OTHER"], n: 1 }, null, 2);
  const redacted = redactLogSecrets(pretty);
  expect(redacted).not.toMatch(/UNIQUESECRET|OTHER/);
  expect(redacted.split("\n").length).toBe(pretty.split("\n").length);
  expect(redacted).toContain('"n": 1');
  // Lookalike names keep their values.
  const plain = '{"input_tokens":5,"inputTokens":6,"author":"Ada","tokenizer":"bpe"}';
  expect(redactLogSecrets(plain)).toBe(plain);
});

it("redacts tab-indented key tails at every depth, with LF or CRLF", () => {
  for (const lineBreak of ["\n", "\r\n"])
    for (const depth of [0, 1, 2, 3]) {
      const tail = `MIIEvQIBADAN${lineBreak}\t-----END RSA PRIVATE KEY-----${lineBreak}`;
      const redacted = unnest(redactLogSecrets(nest(tail, depth)), depth);
      expect(redacted, `${JSON.stringify(lineBreak)} depth ${depth}`).not.toContain("MIIEvQ");
    }
});

it("redacts an unfinished escaped key after any prefix, at every depth", () => {
  const echo = String.raw`echo -----BEGIN PRIVATE KEY-----\nUNIQUESECRET`;
  for (const prefix of ["", "ok\n", "tool output: ", "[12:34:56] "])
    for (const depth of [0, 1, 2, 3]) {
      const input = nest(prefix + echo, depth);
      const redacted = redactLogSecrets(input);
      expect(redacted, `${prefix} ${depth}`).not.toContain("UNIQUESECRET");
      expect(redacted).toBe(`${input.slice(0, input.indexOf("-----BEGIN"))}${R}`);
    }
});

it("redacts keys spelled with escaped line breaks anywhere in a line", () => {
  const encoded = String.raw`-----BEGIN PRIVATE KEY-----\nUNIQUESECRET\n-----END PRIVATE KEY-----`;
  const variants = [
    encoded,
    String.raw`-----BEGIN PRIVATE KEY-----\u000aUNIQUESECRET\u000a-----END PRIVATE KEY-----`,
    String.raw`-----BEGIN PRIVATE KEY-----\u000aUNIQUESECRET\n-----END PRIVATE KEY-----`,
  ];
  for (const variant of variants) {
    expect(redactLogSecrets(`ok\n${variant}`, { lineStart: true })).toBe(`ok\n${R}`);
    expect(redactLogSecrets(`ok\n${variant}`)).toBe(`ok\n${R}`);
    for (const depth of [1, 2, 3, 6, 12, 13, 14]) {
      const nested = nest(variant, depth);
      const redacted = redactLogSecrets(nested);
      expect(redacted, `${variant} depth ${depth}`).not.toContain("UNIQUESECRET");
      if (depth <= 12) expect(unnest(redacted, depth)).toBe(R);
    }
  }
  // Cut off before END, the key runs to the end of the text, after any word.
  expect(
    redactLogSecrets(String.raw`x -----BEGIN PRIVATE KEY-----\nUNIQUESECRET`, { lineStart: true }),
  ).toBe(`x ${R}`);
  expect(
    redactLogSecrets(`ok\nkey: ${String.raw`-----BEGIN PRIVATE KEY-----\nUNIQUESECRET`}`),
  ).toBe(`ok\nkey: ${R}`);
  expect(
    redactLogSecrets(
      `export SSH_KEY="${String.raw`-----BEGIN PRIVATE KEY-----\nUNIQUESECRET`}"\nnext`,
    ),
  ).toBe(`export SSH_KEY="${R}\n${R}`);
  const cut = JSON.stringify({
    content: String.raw`-----BEGIN PRIVATE KEY-----\nUNIQUESECRET`,
    n: 1,
  });
  expect(redactLogSecrets(cut)).toBe(`{"content":"${R}`);
  // Prose that mentions the marker is redacted too (accepted over-redaction).
  const prose = String.raw`The -----BEGIN PRIVATE KEY-----\nBuild passed\nLater ordinary content.`;
  expect(redactLogSecrets(prose, { lineStart: true })).toBe(`The ${R}`);
  expect(redactLogSecrets(`ok\n${prose}`, { lineStart: true })).toBe(`ok\nThe ${R}`);
});

it("reads delimiters spelled \\u0022 outside any string", () => {
  const fragment = String.raw`{"password":"UNIQUESECRET"}`;
  expect(redactLogSecrets(`ok\n${fragment}`)).toBe(`ok\n${String.raw`{"password":"${R}"}`}`);
  for (const depth of [0, 1, 2, 3, 6, 12, 13, 14])
    expect(redactLogSecrets(nest(fragment, depth)), `depth ${depth}`).not.toContain("UNIQUESECRET");
});

it("fails closed on a secret value whose closing quote is not followed by JSON", () => {
  const secret = "LEAKCHECKxyz42";
  const endings = [
    "",
    " ",
    "-",
    "/",
    "😀",
    "\uD800",
    "\t",
    ":",
    ",",
    "}",
    "[",
    String.raw`\uZZZZ`,
    String.raw` `,
    String.raw`😀`,
  ];
  for (const ending of endings)
    for (const depth of [0, 1, 2, 3]) {
      const input = nest(`{"password":"first"${ending}${secret}"}`, depth);
      const redacted = redactLogSecrets(input);
      expect(redacted, `${JSON.stringify(ending)} depth ${depth}`).not.toContain(secret);
      expect(unnest(redacted, depth)).toBe(`{"password":"${R}"}`);
    }
  // Escaped quotes before the secret, and a value closed by valid JSON.
  for (const input of [
    String.raw`{"content":"{\"password\":\"first\\" UNIQUESECRET\"}"}`,
    String.raw`{"content":"{\"password\":\"first\\"-UNIQUESECRET\"}"}`,
    String.raw`{"password":"foo"/UNIQUESECRET"}`,
  ])
    expect(redactLogSecrets(input), input).not.toContain("UNIQUESECRET");
  const valid = '{"a":[{"password":"x"}],"password":"y" ,\n"b":"keep"}';
  expect(redactLogSecrets(valid)).toBe(
    `{"a":[{"password":"${R}"}],"password":"${R}" ,\n"b":"keep"}`,
  );
});

it("closes a secret value only where JSON validly continues", () => {
  // After a comma, the same object needs a member; past a closing bracket any
  // value may follow. Anything else keeps the rest of the line in the value.
  for (const fragment of [
    '{"password":"first",{UNIQUESECRET}',
    '{"password":"first",[UNIQUESECRET}',
    '{"password":"first","UNIQUESECRET"}',
    '{"password":"first"},{UNIQUESECRET}',
    '{"password":"first"},[UNIQUESECRET]',
    '{"password":"first"},tru UNIQUESECRET',
  ])
    for (const depth of [0, 1, 2, 3])
      expect(redactLogSecrets(nest(fragment, depth)), `${fragment} ${depth}`).not.toContain(
        "UNIQUESECRET",
      );
  // Valid JSON keeps its structure and every sibling.
  for (const sibling of [
    "1",
    "true",
    "false",
    "null",
    "-1",
    "1e3",
    '"kept"',
    "{}",
    "[]",
    '{"a":1}',
    "[[1]]",
  ])
    for (const depth of [0, 1, 2, 3]) {
      const input = nest(`[{"password":"UNIQUESECRET"},${sibling}]`, depth);
      const redacted = unnest(redactLogSecrets(input), depth);
      expect(JSON.parse(redacted), `${sibling} ${depth}`).toEqual(
        JSON.parse(`[{"password":"${R}"},${sibling}]`),
      );
    }
});

it("validates what follows a secret value through its enclosing containers", () => {
  // Invalid wherever the enclosing container's grammar is broken.
  for (const fragment of [
    '{"wrapper":{"password":"first"},"UNIQUESECRET"}',
    '{"wrapper":{"password":"first"},1UNIQUESECRET}',
    '[{"password":"first"},trueUNIQUESECRET]',
    '[{"password":"first"},nullUNIQUESECRET]',
    '[{"password":"first"},1UNIQUESECRET]',
    '[{"password":"first"},{"UNIQUESECRET"}]',
    '{"wrapper":{"password":"first"},[["UNIQUESECRET"]]}',
  ])
    for (const depth of [0, 1, 2, 3])
      expect(
        redactLogSecrets(nest(fragment, depth), { lineStart: true }),
        `${fragment} ${depth}`,
      ).not.toContain("UNIQUESECRET");
  // Valid JSON keeps its structure: siblings of any shape, and member names
  // of any length or escaping.
  const valid: [unknown, unknown][] = [];
  for (const sibling of [
    0,
    -1,
    1.3,
    1e21,
    null,
    true,
    false,
    "kept",
    {},
    [],
    { n: [false, { a: "kept" }] },
  ]) {
    const wraps = [
      (x: unknown) => [x, sibling],
      (x: unknown) => ({ x, next: sibling }),
      (x: unknown) => [[x], sibling],
      (x: unknown) => ({ x: { inner: x }, next: sibling }),
    ];
    for (const wrap of wraps)
      valid.push([wrap({ password: "UNIQUESECRET" }), wrap({ password: R })]);
  }
  for (const length of [128, 130, 131, 300]) {
    const name = "x".repeat(length);
    valid.push([
      { password: "UNIQUESECRET", [name]: 1 },
      { password: R, [name]: 1 },
    ]);
  }
  const cases = valid.map(([input, output]) => [JSON.stringify(input), JSON.stringify(output)]);
  const escapedName = String.raw`a`.repeat(24);
  cases.push([
    `{"password":"UNIQUESECRET","${escapedName}":1}`,
    `{"password":"${R}","${escapedName}":1}`,
  ]);
  for (const [input, output] of cases)
    for (const depth of [0, 1, 2, 3]) {
      const redacted = unnest(redactLogSecrets(nest(input!, depth), { lineStart: true }), depth);
      expect(JSON.parse(redacted), `${input} ${depth}`).toEqual(JSON.parse(output!));
    }
});

it("validates a secret value against the containers opened before it", () => {
  // The text shows the enclosing object, or no container at all: nothing may
  // close as an array. The rest of the line stays in the value.
  for (const fragment of [
    '{"wrapper":{"password":"first"},"UNIQUESECRET"]',
    '{"password":"first"},"UNIQUESECRET"]',
    '[{"wrapper":{"password":"first"},"UNIQUESECRET"]}',
  ])
    for (const depth of [0, 1, 2, 3]) {
      const redacted = redactLogSecrets(nest(`${fragment}\nkept`, depth), { lineStart: true });
      expect(redacted, `${fragment} ${depth}`).not.toContain("UNIQUESECRET");
      expect(unnest(redacted, depth), `${fragment} ${depth}`).toMatch(/"\[REDACTED\]\nkept$/);
    }
  // A known enclosing array still closes, at any depth.
  for (const input of [
    '[{"wrapper":{"password":"first"}},"kept"]',
    '[{"password":"first"},"kept"]',
  ])
    for (const depth of [0, 1, 2, 3]) {
      const redacted = unnest(redactLogSecrets(nest(input, depth), { lineStart: true }), depth);
      expect(redacted, `${input} ${depth}`).toBe(input.replace('"first"', `"${R}"`));
    }
  // So do containers opened before a cut: a text that may begin inside them.
  for (const input of ['{"password":"first"},"kept"]', 'x"}\n{"password":"first"},"kept"]'])
    expect(redactLogSecrets(input), input).toBe(input.replace('"first"', `"${R}"`));
});

it("opens a key of unknown type at a possible marker left encoded when decoding runs out", () => {
  // Each `\u005c` decodes to the backslash of the next escape: the BEGIN needs
  // one decoding pass per level, past the last pass beyond 13.
  const record = (passes: number) =>
    JSON.stringify({
      content: `-----\\${"u005c".repeat(passes - 2)}u0042EGIN PRIVATE KEY-----`,
    });
  for (const passes of [12, 13, 14, 20]) {
    const text = `${record(passes)}\n[progress]\nUNIQUESECRET\n`;
    expect(redactLogSecrets(text, { lineStart: true }), `${passes}`).not.toContain("UNIQUESECRET");
    expect(keyStateAfter(`${record(passes)}\n`, "outside"), `${passes}`).toEqual({
      inside: passes > 13 ? "?" : "",
    });
    // Only a decoded BEGIN is closed by its END.
    const closed = `${text}-----END PRIVATE KEY-----\nafter\n`;
    expect(
      redactLogSecrets(closed, { lineStart: true }).endsWith(`${R}\nafter\n`),
      `${passes}`,
    ).toBe(passes <= 13);
  }
  // Conventional wrappers past the last pass, whichever marker character is escaped.
  const begin = "-----BEGIN RSA PRIVATE KEY-----";
  for (const depth of [12, 13, 14, 20])
    for (let at = 0; at < begin.length; at++) {
      const marker = `${begin.slice(0, at)}\\u${begin.charCodeAt(at).toString(16).padStart(4, "0")}${begin.slice(at + 1)}`;
      const text = `${nest(marker, depth)}\n[progress]\nUNIQUESECRET\n`;
      expect(redactLogSecrets(text, { lineStart: true }), `${depth} ${at}`).not.toContain(
        "UNIQUESECRET",
      );
    }
  // Escapes left without a possible marker keep the strings they are in redacted.
  const deep = nest('{"password":"UNIQUESECRET"}', 16);
  expect(keyStateAfter(deep, "outside")).toBe("outside");
  expect(redactLogSecrets(`${deep}\nafter`, { lineStart: true })).toMatch(/^[^U]*\nafter$/);
});

it("opens a key at a BEGIN spelled with escapes, and closes it only at its own END", () => {
  const unicode = String.raw`{"content":"-----BEGIN PRIVATE KEY-----"}`;
  const literal = JSON.stringify({ content: "-----BEGIN PRIVATE KEY-----" });
  const mismatched = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----";
  for (const lead of [unicode, literal, mismatched])
    for (const depth of [0, 1, 2, 3]) {
      const input = nest(`${lead}\n[progress]\nUNIQUESECRET\n`, depth);
      expect(redactLogSecrets(input, { lineStart: true }), `${lead} ${depth}`).not.toContain(
        "UNIQUESECRET",
      );
    }
  // A matching END closes it; what follows is kept.
  const closed = `${mismatched}\nsecret\n-----END RSA PRIVATE KEY-----\nafter\n`;
  expect(redactLogSecrets(closed, { lineStart: true })).toBe(
    `${R}\n${R}\n${R}\n${R}\n${R}\nafter\n`,
  );
  expect(
    redactLogSecrets("AAAA\n-----END EC PRIVATE KEY-----\nstill\n", {
      lineStart: true,
      key: { inside: "RSA" },
    }),
  ).toBe(`${R}\n${R}\n${R}\n`);
});

it("redacts passphrases, sessions, and quoted header values", () => {
  for (const name of [
    "passphrase",
    "session",
    "sessionToken",
    "session_id",
    "SESSION_ID",
    "sessionId",
  ])
    expect(redactLogSecrets(JSON.stringify({ [name]: "UNIQUESECRET" })), name).toBe(
      `{"${name}":"${R}"}`,
    );
  expect(redactLogSecrets('Authorization: "UNIQUESECRET"')).toBe(`Authorization: "${R}"`);
  const plain = '{"sessions":3,"secretary":"Ada","inputTokens":1}';
  expect(redactLogSecrets(plain)).toBe(plain);
});

it("redacts a key with a malformed body line through its END, at every depth", () => {
  const key = `-----BEGIN PRIVATE KEY-----\n${String.raw`UNIQUESECRET\uZZZZ`}\n-----END PRIVATE KEY-----\n`;
  for (const depth of [0, 1, 2, 3, 6, 12, 13, 14]) {
    const redacted = redactLogSecrets(nest(key, depth));
    expect(redacted, `depth ${depth}`).not.toContain("UNIQUESECRET");
  }
  expect(redactLogSecrets(`a\n${key}b`)).toBe(`a\n${R}\n${R}\n${R}\nb`);
  // Every cut of an escaped record still redacts the body. (A raw block with
  // no END yet ends at its first line that is not key material.)
  for (const depth of [1, 2, 3]) {
    const nested = nest(key, depth);
    for (let end = 0; end <= nested.length; end++)
      expect(redactLogSecrets(nested.slice(0, end)), `${depth} ${end}`).not.toContain(
        "UNIQUESECRET",
      );
  }
});

it("redacts from the start through END a text that begins inside a key", () => {
  const text = "AAAA BBBB\n\nCCCC\n-----END PRIVATE KEY-----\nafter\n";
  expect(redactLogSecrets(text, { lineStart: true, key: { inside: "" } })).toBe(
    `${R}\n\n${R}\n${R}\nafter\n`,
  );
  expect(redactLogSecrets("AAAA\nnot key.\n", { lineStart: true, key: { inside: "" } })).toBe(
    `${R}\n${R}\n`,
  );
  // Unknown: leading lines of possible key material, then the first other line.
  expect(
    redactLogSecrets("Proc-Type: 4,ENCRYPTED\nAA AA\n\nBB\ndone.\nCCCC\n", {
      lineStart: true,
      key: "unknown",
    }),
  ).toBe(`${R}\n${R}\n\n${R}\ndone.\nCCCC\n`);
  expect(
    redactLogSecrets("AAAA\n-----END PRIVATE KEY-----\nz", { lineStart: true, key: "unknown" }),
  ).toBe(`${R}\n${R}\nz`);
});

it("bounds scanning work linearly on 1 MiB adversarial inputs", { timeout: 60_000 }, () => {
  // The review's benchmark shapes, measured by visits rather than time.
  const fill = (pattern: string, n: number) =>
    pattern.repeat(Math.ceil(n / pattern.length)).slice(0, n);
  const shapes: Record<string, (n: number) => string> = {
    bare: (n) => "A".repeat(n),
    beginBlocks: (n) => fill("-----BEGIN PRIVATE KEY-----\nAAAA", n),
    escapedBlocks: (n) => fill(String.raw`-----BEGIN PRIVATE KEY-----\nAAAA`, n),
    escapedProse: (n) => fill(String.raw`x -----BEGIN PRIVATE KEY-----\n`, n),
    endMarkers: (n) => fill("x-----END PRIVATE KEY-----", n),
    urlCandidates: (n) => fill("a.", n),
    spacedKey: (n) => `-----BEGIN PRIVATE KEY-----\n${fill("A ", n - 27)}.`,
    tailSpaces: (n) => `${fill("A \t", n - 25)}-----END PRIVATE KEY-----`,
    slashRun: (n) => `"token":"${"\\".repeat(n - 9)}`,
    escapeSoup: (n) => fill('\\"a"b"', n),
    brokenQuotes: (n) => `{"password":"${fill('" x', n)}`,
    closerRuns: (n) => `{"password":"${fill('"}}}}}}}}}}}}x', n)}`,
    unicodeQuotes: (n) => fill(String.raw`"a":`, n),
    unclosedArrays: (n) => fill('"password":[', n),
    unclosedObjects: (n) => fill('{"auth":{"auth":{"auth":', n),
    depth12: (n) => nest("A".repeat(Math.max(0, n - nest("", 12).length)), 12),
    depth14: (n) => nest("A".repeat(Math.max(0, n - nest("", 14).length)), 14),
    denseSpans: (n) => fill('token=foo cookie=bar\n{"password":"z","apiKey":1}\n', n),
    mixedSpans: (n) =>
      fill(
        'token=foo\n{"password":"x"}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
        n,
      ),
    unicode: (n) => fill('{"content":"{\\u0022password\\u0022:\\u0022SECRET\\u0022}"}\n', n),
  };
  const size = 1024 * 1024;
  for (const [name, shape] of Object.entries(shapes)) {
    const input = shape(size).slice(0, size);
    for (const start of [
      {},
      { lineStart: true, key: { inside: "" } },
      { lineStart: true, key: "unknown" as const },
    ]) {
      const { visits } = measureLogRedaction(input, start);
      expect(visits, `${name} ${JSON.stringify(start)}`).toBeLessThanOrEqual(160 * input.length);
    }
  }
});

it("bounds scanning work linearly in the input length", () => {
  // Every loop of the scanner counts its character visits; regex passes count
  // one visit per character scanned. A pattern that rescans suffixes grows
  // quadratically and blows through the bound at the larger sizes.
  const shapes: ((size: number) => string)[] = [
    (n) => "A".repeat(n),
    (n) => "AAAA\n".repeat(n / 5),
    (n) => "-----BEGIN PRIVATE KEY-----\nAAAA".repeat(n / 32),
    (n) => "x-----END PRIVATE KEY-----".repeat(n / 26),
    (n) => "a.".repeat(n / 2),
    (n) => `-----BEGIN PRIVATE KEY-----\n${"A ".repeat(n / 2)}.`,
    (n) => `${"A \t".repeat(n / 3)}-----END PRIVATE KEY-----`,
    (n) => `"token":"${"\\".repeat(n)}`,
    (n) => `-----BEGIN PRIVATE KEY-----\\n${"A\\".repeat(n / 2)}`,
    (n) => `${`${"\\".repeat(63)}n`.repeat(n / 64)}-----END PRIVATE KEY-----`,
    // Quote and escape soup: flips, mis-escapes, and unterminated strings.
    (n) => '\\"a"b"'.repeat(n / 7),
    (n) => '"password":['.repeat(n / 13),
    (n) => '{"auth":{"auth":{"auth":'.repeat(n / 24),
    (n) => nest("A".repeat(n), 6),
    // Deeper than the scanner decodes: the innermost string is redacted whole.
    (n) => nest("A".repeat(n), 14),
    (n) => nest(`{"password":"${"\\".repeat(n / 4)}"}`, 4),
  ];
  for (const shape of shapes)
    for (const size of [1024, 4096, 16384, 65536]) {
      const input = shape(size);
      const { visits } = measureLogRedaction(input);
      expect(visits, `${input.slice(0, 24)} ${size}`).toBeLessThanOrEqual(
        160 * input.length + 4096,
      );
    }
});
