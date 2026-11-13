import { describe, expect, it } from "@effect/vitest";

import { scrubFeedback } from "./scrubFeedback.ts";

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
  ])("scrubs %s", (_, text, sensitive, expected) => {
    expect(scrubFeedback(text, sensitive)).toBe(expected);
  });

  it("scrubs before capping at 300 characters", () => {
    expect(scrubFeedback(`${"a ".repeat(140)}ops@acme.dev`, [])).toBe(
      `${"a ".repeat(140)}[redacted]`,
    );
    expect(Array.from(scrubFeedback("😀".repeat(400), []))).toHaveLength(300);
  });
});
