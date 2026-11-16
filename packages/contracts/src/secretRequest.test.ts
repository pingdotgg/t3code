import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SecretRequestAnswerInput, secretRequestPageUrl } from "./secretRequest.ts";

describe("secretRequestPageUrl", () => {
  it("opens only http and https pages", () => {
    expect(secretRequestPageUrl("https://accounts.google.com/o/oauth2/auth?x=1")?.host).toBe(
      "accounts.google.com",
    );
    expect(secretRequestPageUrl("javascript:alert(1)")).toBeNull();
    expect(secretRequestPageUrl("https://?state=x")).toBeNull();
    expect(secretRequestPageUrl("not a url")).toBeNull();
  });
});

describe("SecretRequestAnswerInput", () => {
  it("keeps a saved secret's exact whitespace and refuses only an empty one", () => {
    const decode = Schema.decodeUnknownSync(SecretRequestAnswerInput);
    const save = (secret: string) => ({
      threadId: "thread-1",
      turnItemId: "item-1",
      answer: { type: "save", secret },
    });
    for (const secret of ["    ", " pa ss "]) {
      expect(decode(save(secret)).answer).toEqual({ type: "save", secret });
    }
    expect(() => decode(save(""))).toThrow();
  });
});
