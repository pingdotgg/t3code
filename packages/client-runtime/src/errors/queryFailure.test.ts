import { PullRequestListInput, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./queryFailure.ts";

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
};

const tooManyProjects = () => {
  const projectIds = Array.from({ length: 101 }, (_, index) => ProjectId.make(`p-${index}`));
  return thrownBy(() => PullRequestListInput.make({ state: "open", projectIds }));
};

const defectCodec = Schema.toCodecJson(Schema.Defect());
const overTheWire = (defect: unknown): unknown =>
  Schema.decodeUnknownSync(defectCodec)(
    JSON.parse(JSON.stringify(Schema.encodeUnknownSync(defectCodec)(defect))),
  );

describe("formatEnvironmentQueryError", () => {
  it("names the field and the rule when a request fails schema validation", () => {
    expect(formatEnvironmentQueryError(Cause.die(tooManyProjects()))).toBe(
      'Schema validation failed: An environment can list pull requests for at most 100 projects at ["projectIds"].',
    );
  });

  it.each([
    [new Error("The host is unreachable."), "The host is unreachable."],
    [new Error("  "), "The environment request failed."],
    ["not an error", "The environment request failed."],
    [overTheWire(thrownBy(() => ProjectId.make("   "))), "Schema validation failed"],
  ])("keeps the existing text for %s", (error, message) => {
    expect(formatEnvironmentQueryError(Cause.die(error))).toBe(message);
  });
});
