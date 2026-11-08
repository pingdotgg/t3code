import type { LinearMutationInput, LinearMutationResult } from "@t3tools/contracts";
export type LinearMutate = (
  input: LinearMutationInput,
) => Promise<typeof LinearMutationResult.Type | null>;
