import { assert, describe, it } from "@effect/vitest";
import {
  redactSensitiveText,
  truncateKeepingHead,
  truncateKeepingTail,
} from "./redactSensitiveText.ts";

describe("redactSensitiveText", () => {
  describe("GitHub tokens", () => {
    it("redacts ghp_ tokens", () => {
      assert.equal(
        redactSensitiveText("token: ghp_" + "abcdefghijklmnopqrstu1234567890"),
        "token: [redacted]",
      );
    });

    it("redacts gho_ tokens via the gh prefix pattern (not high-entropy)", () => {
      // All lowercase+digits, no uppercase: HIGH_ENTROPY's uppercase lookahead
      // cannot fire, so redaction here proves the gh[pousr]_ pattern matched.
      assert.equal(redactSensitiveText("auth gho_" + "abcdefghij1234567890ab"), "auth [redacted]");
    });

    it("does not redact a too-short gho_ token", () => {
      const text = "gho_abc";
      assert.equal(redactSensitiveText(text), text);
    });

    it("redacts github_pat_ tokens", () => {
      assert.equal(
        redactSensitiveText("github_pat_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabc1234567890"),
        "[redacted]",
      );
    });
  });

  describe("OpenAI tokens", () => {
    it("redacts sk- tokens", () => {
      assert.equal(
        redactSensitiveText("key=sk-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabc123"),
        "key=[redacted]",
      );
    });
  });

  describe("Stripe-style keys", () => {
    it("redacts an all-lowercase sk_live_ key the high-entropy sweep misses", () => {
      // No uppercase + underscore prefix: neither the OpenAI `sk-` rule nor the
      // uppercase-requiring high-entropy sweep would catch this.
      assert.equal(
        redactSensitiveText("key=sk_live_" + "4ec39hqlyjwdarjtt1zdp7dc"),
        "key=[redacted]",
      );
    });

    it("redacts restricted rk_live_ keys", () => {
      assert.equal(redactSensitiveText("rk_live_" + "abcdefghijklmnop1234567890"), "[redacted]");
    });

    it("redacts sk_test_ keys", () => {
      assert.equal(
        redactSensitiveText("STRIPE=sk_test_" + "abcdefghijklmnopqrstuvwx"),
        "STRIPE=[redacted]",
      );
    });
  });

  describe("Bearer tokens", () => {
    it("redacts Bearer header values", () => {
      assert.equal(
        redactSensitiveText("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
        "Authorization: [redacted]",
      );
    });

    it("does not redact very short Bearer values", () => {
      const text = "Bearer short";
      // "short" is only 5 chars, well below 16
      assert.equal(redactSensitiveText(text), text);
    });
  });

  describe("AWS keys", () => {
    it("redacts AKIA keys", () => {
      assert.equal(redactSensitiveText("key: AKIA" + "IOSFODNN7EXAMPLE"), "key: [redacted]");
    });

    it("does not redact AKIA with wrong length", () => {
      // Only 15 chars after AKIA (needs 16)
      const text = "AKIAIOSFODNN7EXA";
      assert.equal(redactSensitiveText(text), text);
    });
  });

  describe("NAME=value / NAME: value lines", () => {
    it("redacts TOKEN= assignments", () => {
      assert.equal(redactSensitiveText("MY_TOKEN=supersecretvalue123"), "MY_TOKEN=[redacted]");
    });

    it("redacts SECRET: assignments", () => {
      assert.equal(redactSensitiveText("APP_SECRET: mysecretvalue"), "APP_SECRET=[redacted]");
    });

    it("redacts PASSWORD= assignments", () => {
      assert.equal(redactSensitiveText("DB_PASSWORD=hunter2"), "DB_PASSWORD=[redacted]");
    });

    it("redacts KEY= assignments", () => {
      assert.equal(redactSensitiveText("API_KEY=abcdef123456"), "API_KEY=[redacted]");
    });

    it("redacts CREDENTIAL= assignments", () => {
      assert.equal(
        redactSensitiveText("AWS_CREDENTIAL=some_cred_value"),
        "AWS_CREDENTIAL=[redacted]",
      );
    });

    it("redacts case-insensitively (lowercase token)", () => {
      assert.equal(redactSensitiveText("access_token=abc123xyz"), "access_token=[redacted]");
    });

    it("handles multiline input, only redacts matching lines", () => {
      const input = `HOST=localhost\nAPI_KEY=supersecret\nPORT=3000`;
      const output = redactSensitiveText(input);
      assert.include(output, "HOST=localhost");
      assert.include(output, "API_KEY=[redacted]");
      assert.include(output, "PORT=3000");
    });

    it("does not redact KEYBOARD= (no matching sensitive word)", () => {
      const text = "KEYBOARD=qwerty";
      assert.equal(redactSensitiveText(text), text);
    });

    it("does not trip on ordinary sentence with KEYBOARD word not followed by =", () => {
      const text = "the KEYBOARD shortcut is ctrl+c";
      assert.equal(redactSensitiveText(text), text);
    });
  });

  describe("high-entropy strings", () => {
    it("redacts high-entropy 32+ char strings", () => {
      // 32-char string with upper, lower, digit
      const secret = "aBcDeFgH1234567890ABCDEFGHIJKLMN";
      assert.equal(redactSensitiveText(secret), "[redacted]");
    });

    it("does not redact short strings even if mixed-case", () => {
      const text = "Hello World 123";
      assert.equal(redactSensitiveText(text), text);
    });

    it("does not redact long all-lowercase strings (no uppercase)", () => {
      const text = "abcdefghijklmnopqrstuvwxyz1234567890abc";
      assert.equal(redactSensitiveText(text), text);
    });

    it("does not redact long all-uppercase strings (no lowercase)", () => {
      const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABC";
      assert.equal(redactSensitiveText(text), text);
    });

    it("does not redact long strings with no digit", () => {
      const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
      assert.equal(redactSensitiveText(text), text);
    });
  });

  describe("leaves ordinary prose untouched", () => {
    it("does not redact build failure message", () => {
      const text = "the build failed at line 42";
      assert.equal(redactSensitiveText(text), text);
    });

    it("does not redact import statement", () => {
      const text = "import { foo } from 'bar'";
      assert.equal(redactSensitiveText(text), text);
    });

    it("does not redact normal sentence", () => {
      const text = "Error: could not find module at path /home/user/app";
      assert.equal(redactSensitiveText(text), text);
    });
  });
});

describe("truncateKeepingTail", () => {
  it("returns text unchanged when length <= max", () => {
    assert.equal(truncateKeepingTail("hello", 10), "hello");
    assert.equal(truncateKeepingTail("hello", 5), "hello");
  });

  it("truncates with the marker INCLUDED in the budget (result length <= max)", () => {
    const marker = "…[truncated]\n";
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = truncateKeepingTail(text, 20);
    // The result must fit within max — the marker is part of the budget.
    assert.isTrue(result.length <= 20);
    assert.isTrue(result.startsWith(marker));
    // Tail is the last (max - markerLength) chars of the source.
    assert.equal(result.slice(marker.length), text.slice(text.length - (20 - marker.length)));
  });

  it("never exceeds max for a large body capped at the ticket body limit", () => {
    const text = "y".repeat(20_000);
    const max = 8_000;
    const result = truncateKeepingTail(text, max);
    assert.isTrue(result.length <= max);
    assert.isTrue(result.startsWith("…[truncated]\n"));
  });

  it("handles empty string", () => {
    assert.equal(truncateKeepingTail("", 10), "");
  });

  it("handles max smaller than the marker without exceeding max", () => {
    // text longer than max forces truncation; max < marker length (13).
    const result = truncateKeepingTail("hello world", 5);
    assert.isTrue(result.length <= 5);
  });
});

describe("truncateKeepingHead", () => {
  it("returns text unchanged when length <= max", () => {
    assert.equal(truncateKeepingHead("hello", 10), "hello");
    assert.equal(truncateKeepingHead("hello", 5), "hello");
  });

  it("keeps the START and appends the marker within the budget", () => {
    const marker = "…[truncated]";
    const text = "actionable summary first, then trailing log noise goes here";
    const result = truncateKeepingHead(text, 30);
    assert.isTrue(result.length <= 30);
    assert.isTrue(result.endsWith(marker));
    // The kept prefix is the first (max - markerLength) chars of the source.
    assert.equal(result.slice(0, result.length - marker.length), text.slice(0, 30 - marker.length));
  });

  it("never exceeds max for a large body", () => {
    const text = "y".repeat(20_000);
    const result = truncateKeepingHead(text, 240);
    assert.isTrue(result.length <= 240);
    assert.isTrue(result.endsWith("…[truncated]"));
  });

  it("handles empty string", () => {
    assert.equal(truncateKeepingHead("", 10), "");
  });

  it("handles max smaller than the marker without exceeding max", () => {
    const result = truncateKeepingHead("hello world", 5);
    assert.isTrue(result.length <= 5);
  });
});
