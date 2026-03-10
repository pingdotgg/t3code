import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decodeJsonString, formatJsonDecodeFailure } from "./schemaJson";

const ExampleSchema = Schema.Struct({
  channel: Schema.Literal("server.configUpdated"),
  data: Schema.String,
});

describe("schemaJson", () => {
  it("distinguishes JSON parse failures from schema failures", () => {
    const decode = decodeJsonString(ExampleSchema);

    const invalidJson = decode("{ invalid-json");
    expect(invalidJson._tag).toBe("Failure");
    if (invalidJson._tag !== "Failure") {
      throw new Error("Expected invalid JSON to fail decoding");
    }
    expect(invalidJson.failure.phase).toBe("json");
    expect(formatJsonDecodeFailure(invalidJson.failure)).toContain("Invalid JSON");

    const invalidShape = decode(
      JSON.stringify({
        channel: "server.welcome",
        data: 123,
      }),
    );
    expect(invalidShape._tag).toBe("Failure");
    if (invalidShape._tag !== "Failure") {
      throw new Error("Expected invalid shape to fail decoding");
    }
    expect(invalidShape.failure.phase).toBe("schema");
    expect(formatJsonDecodeFailure(invalidShape.failure)).toContain(
      "Schema validation failed",
    );
  });
});
