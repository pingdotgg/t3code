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

  it("rejects malformed YAML", () => {
    const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));

    expect(() => decodeYaml("name: ok\n  bad-indent: nope\n")).toThrow();
  });
});
