import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { FeedbackInput, FeedbackReport } from "./FeedbackReport.ts";
import { scrubFeedback } from "./scrubFeedback.ts";

const decodeInput = Schema.decodeUnknownSync(FeedbackInput);
const decodeReport = Schema.decodeUnknownSync(FeedbackReport);

describe("scrubFeedback", () => {
  it.each([
    [
      "known values, longest first",
      "Reading /home/alice/acme as alice on alice-laptop",
      ["/home/alice", "/home/alice/acme", "alice", "alice-laptop"],
      "Reading [redacted] as [redacted] on [redacted]",
    ],
    [
      "known values only as whole words",
      "t3_feedback failed for t3 and Bob, not bobcat",
      ["t3", "Bob", "x"],
      "t3_feedback failed for t3 and [redacted], not bobcat",
    ],
    [
      "URLs with credentials before emails inside them",
      "clone https://user:hunter2@git.acme.dev/app.git, mail ops@acme.dev",
      [],
      "clone [redacted] mail [redacted]",
    ],
    [
      "key prefixes and JWTs",
      "sk-ant-api03-abcdefghijkl ghp_abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln",
      [],
      "[redacted] [redacted] [redacted]",
    ],
    [
      "long random runs, not long identifiers or paths",
      "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW t3_environment_preferences_update apps/server/src/persistence/Migrations/088",
      [],
      "[redacted] t3_environment_preferences_update apps/server/src/persistence/Migrations/088",
    ],
    [
      "whole absolute paths",
      "/home/x/acme\n/tmp/a/b.ts\n~/acme/app\nfile:///srv/acme/x.ts\nC:\\Users\\x\\acme\\a.ts",
      [],
      "[redacted]\n[redacted]\n[redacted]\n[redacted]\n[redacted]",
    ],
    [
      "the tail of a known path",
      "Opened /home/alice/Develop/acme\nThen /Users/al/My Project/src/a.ts",
      ["/home/alice", "/Users/al/My Project"],
      "Opened [redacted]\nThen [redacted]",
    ],
    [
      "nothing that only looks like a path",
      "See https://github.com/org/repo for t3 thread send and t3_thread_read: 3/10 and/or a / b /mcp /compact /secret.env",
      [],
      "See https://github.com/org/repo for t3 thread send and t3_thread_read: 3/10 and/or a / b /mcp /compact /secret.env",
    ],
    [
      "quoted paths with spaces",
      `Read "/home/alice/My Project/secret.txt", 'C:\\Users\\My Name\\a.ts' and \`~/My Notes\` for '/compact'`,
      [],
      `Read "[redacted]", '[redacted]' and \`[redacted]\` for '/compact'`,
    ],
    [
      "unquoted paths with spaces",
      "Opened /home/alice/My Project/secret.txt then C:\\Users\\My Name\\a.ts today",
      [],
      "Opened [redacted]",
    ],
    [
      "a quoted path to its own closing quote",
      `Read "/home/alice/O'Brien/secret.txt" and \`/srv/it's here/a\``,
      [],
      'Read "[redacted]" and `[redacted]`',
    ],
    [
      "unquoted folders of several words, to the last separator on the line",
      "Read /home/alice/My Secret Project/secret.txt and C:\\Users\\My Big Folder\\a.ts. Then and/or stays",
      [],
      "Read [redacted]",
    ],
    [
      "a file name with a space at the end of a path",
      "Read /home/alice/Secret File.txt\nRead ~/Secret File.txt\nRead file:///srv/Secret File.txt\nRead C:\\Users\\Secret File.txt\nRead /home/alice/Secret File.txt",
      ["/home/alice"],
      "Read [redacted]\nRead [redacted]\nRead [redacted]\nRead [redacted]\nRead [redacted]",
    ],
    [
      "slash commands and spaced slashes, which a first segment with a space would swallow",
      "Ran /mcp /compact, then /goal, a / b / c",
      [],
      "Ran /mcp /compact, then /goal, a / b / c",
    ],
    [
      "a folder name holding a sentence break",
      "Read /home/alice/Secret. Project/secret.txt",
      [],
      "Read [redacted]",
    ],
    [
      "only the lines that hold a path",
      "Saw /home/a/b today\nand/or https://github.com/org/repo stays\nthen ~/x/y. Done",
      [],
      "Saw [redacted]\nand/or https://github.com/org/repo stays\nthen [redacted]",
    ],
    [
      "secrets before the known values inside them",
      "Mail alice@privatecompany.com with sk-proj-abcdefghij1234567890 from git@github.com:acme/app.git",
      ["alice", "proj", "git@github.com:acme/app.git"],
      "Mail [redacted] with [redacted] from [redacted]",
    ],
    [
      "UNC paths",
      `Opened \\\\fileserver\\finance\\payroll.xlsx\nand "\\\\fs\\My Share\\a.txt" then`,
      [],
      'Opened [redacted]\nand "[redacted]" then',
    ],
    [
      "a two-letter username such as t3",
      "t3 thread send failed for t3",
      ["t3"],
      "t3 thread send failed for t3",
    ],
    ["a 1,200-character adversarial path", `/a/b${" x/".repeat(398)}`, [], "[redacted]"],
  ])("scrubs %s", (_, text, sensitive, expected) => {
    expect(scrubFeedback(text, sensitive)).toBe(expected);
  });

  it("keeps a valid input a valid report when redaction lengthens it", () => {
    const input = decodeInput({
      kind: "bug",
      subject: "",
      expected: "",
      actual: `${"😀".repeat(100)}${" bob".repeat(15)}`,
      workaround: "",
    });
    const actual = scrubFeedback(input.actual, ["bob"]);
    const report = { ...input, actual, id: "r", threadId: null, createdAt: "", source: "mcp" };
    expect(decodeReport({ ...report, sent: true }).actual).toBe(actual);
    expect(Array.from(actual)).toHaveLength(265);
  });

  it("scrubs before capping at 300 characters", () => {
    expect(scrubFeedback(`${"a ".repeat(140)}ops@acme.dev`, [])).toBe(
      `${"a ".repeat(140)}[redacted]`,
    );
    expect(Array.from(scrubFeedback("😀".repeat(400), []))).toHaveLength(300);
    expect(scrubFeedback(`${"a@".repeat(20_000)}`, [])).toBe("a@".repeat(150));
  });
});
