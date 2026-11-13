// A plain async Lambda handler exported only as `handler` (no default
// export), so the deploy works only if the `handler` prop is honored.
export const handler = async () => ({ statusCode: 200, body: "named" });
