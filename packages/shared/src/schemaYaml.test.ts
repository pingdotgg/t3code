import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { fromYaml, fromYamlString } from "./schemaYaml.ts";

const ProjectConfig = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  tags: Schema.Array(Schema.String),
});

describe("schemaYaml helpers", () => {
  it("decodes YAML through a schema", () => {
    const decodeConfig = Schema.decodeUnknownSync(fromYaml(ProjectConfig));

    expect(
      decodeConfig(`name: t3code
enabled: true
tags:
  - codex
  - effect
`),
    ).toEqual({
      name: "t3code",
      enabled: true,
      tags: ["codex", "effect"],
    });
  });

  it("encodes values as YAML text", () => {
    const encodeConfig = Schema.encodeSync(fromYaml(ProjectConfig));

    expect(
      encodeConfig({
        name: "t3code",
        enabled: true,
        tags: ["codex"],
      }),
    ).toBe(`name: t3code
enabled: true
tags:
  - codex
`);
  });

  it("can be used as a schema transformation directly", () => {
    const schema = Schema.String.pipe(Schema.decodeTo(Schema.Unknown, fromYamlString));
    const decodeYaml = Schema.decodeUnknownSync(schema);

    expect(decodeYaml("answer: 42\n")).toEqual({ answer: 42 });
  });

  it("reports malformed YAML with safe structural diagnostics", () => {
    const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
    const secret = "credential=secret-value";
    let error: unknown;

    try {
      decodeYaml(`name: ${secret}\n  bad-indent: nope\n`);
    } catch (cause) {
      error = cause;
    }

    expect(Schema.isSchemaError(error)).toBe(true);
    if (!Schema.isSchemaError(error)) {
      throw new Error("Expected a schema error");
    }
    expect(error.message).toBe("Invalid YAML (code=BLOCK_AS_IMPLICIT_KEY, line=1, column=7).");
    expect(error.message).not.toContain(secret);
  });

  it("does not expose stringify failure details", () => {
    const encodeYaml = Schema.encodeSync(fromYaml(Schema.Unknown));
    const secret = "credential=secret-value";
    let error: unknown;

    try {
      encodeYaml({
        toJSON() {
          throw new Error(secret);
        },
      });
    } catch (cause) {
      error = cause;
    }

    expect(Schema.isSchemaError(error)).toBe(true);
    if (!Schema.isSchemaError(error)) {
      throw new Error("Expected a schema error");
    }
    expect(error.message).toBe("Failed to stringify YAML.");
    expect(error.message).not.toContain(secret);
  });
});
