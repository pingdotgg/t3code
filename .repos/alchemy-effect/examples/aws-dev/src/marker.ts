/**
 * The CLI dev test (test/dev.test.ts) rewrites this value in place — with
 * `alchemy dev` running — to prove the Lambda hot-swaps code without a
 * redeploy, then restores it. The checked-in value is always `v1`.
 */
export const MARKER = "aws-dev-marker-v1";
