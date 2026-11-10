// A plain async Lambda handler exported only as `default`, deployed without
// `handler`/`isExternal` set — the documented async-handler shape.
export default async () => ({ statusCode: 200, body: "ok" });
