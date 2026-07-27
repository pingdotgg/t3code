import * as AWS from "alchemy/AWS";

/**
 * Build role shared by every MicroVM image (effectful bun/node, bun/node
 * baselines, external Python). Kept in its own module so the effectful image
 * entrypoints can import it without pulling each other's server bundle in.
 */
export const MicrovmBuildRole = AWS.IAM.Role("MicrovmBuildRole");
