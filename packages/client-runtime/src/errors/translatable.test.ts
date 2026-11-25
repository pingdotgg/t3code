import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import { squashAtomCommandFailure } from "../state/runtime.ts";
import { thrownErrorMessage } from "./translatable.ts";

const decodeDefect = Schema.decodeUnknownSync(Schema.Defect());

describe("thrownErrorMessage", () => {
  it("shows the text of a string defect that came back over RPC", () => {
    const defect = decodeDefect(
      "RPC contract is registered but unavailable in the control plane: projectClone.start",
    );
    const error = squashAtomCommandFailure({ cause: Cause.die(defect) });

    expect(thrownErrorMessage(error)).toBe(
      "RPC contract is registered but unavailable in the control plane: projectClone.start",
    );
  });
});
