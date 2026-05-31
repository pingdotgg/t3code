import * as Schema from "effect/Schema";

export const Inputs = Schema.Struct({
  owner: Schema.String,
});

export const Outputs = Schema.Struct({
  merged: Schema.Boolean,
});

export const meta = {
  name: "fixtures.valid-workflow",
  description: "Fixture workflow used by workflow-sdk tests.",
  inputs: Inputs,
  outputs: Outputs,
} as const;
