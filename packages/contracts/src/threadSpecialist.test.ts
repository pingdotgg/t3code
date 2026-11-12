import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadSpecialist, ThreadSpecialistKey } from "./threadSpecialist.ts";

const decodeKey = Schema.decodeUnknownSync(ThreadSpecialistKey);
const decodeSpecialist = Schema.decodeUnknownSync(ThreadSpecialist);

describe("ThreadSpecialistKey", () => {
  it("accepts lowercase slugs", () => {
    assert.equal(decodeKey("dev-ui"), "dev-ui");
    assert.equal(decodeKey("factory"), "factory");
    assert.equal(decodeKey("a"), "a");
  });

  it("rejects uppercase, spaces, and leading hyphens", () => {
    assert.throws(() => decodeKey("Dev-UI"));
    assert.throws(() => decodeKey("dev ui"));
    assert.throws(() => decodeKey("-dev"));
    assert.throws(() => decodeKey("1dev"));
  });
});

describe("ThreadSpecialist", () => {
  it("requires key and label", () => {
    assert.deepEqual(
      decodeSpecialist({
        key: "dev-ui",
        label: "Dev UI",
        instructions: "Owns the web client.",
      }),
      {
        key: "dev-ui",
        label: "Dev UI",
        instructions: "Owns the web client.",
      },
    );
    assert.deepEqual(decodeSpecialist({ key: "dev-ui", label: "Dev UI" }), {
      key: "dev-ui",
      label: "Dev UI",
    });
  });
});
