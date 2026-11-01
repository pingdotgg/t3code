/**
 * Hot-reload fixture for the floci dev provider test
 * ([Function.local.test.ts](../../Function.local.test.ts)). The test clones
 * this directory and rewrites `MARKER` in the CLONE, so the checked-in
 * value is always `marker-v1`.
 */
const MARKER = "marker-v1";

const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "text/plain" },
  body: `${MARKER}:${process.env.DEV_MARKER ?? ""}`,
});

export { handler };
