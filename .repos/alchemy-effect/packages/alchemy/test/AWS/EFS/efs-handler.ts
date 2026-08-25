// Plain async Lambda handler (deployed with `isExternal: true` — no Effect
// runtime in the bundle) that exercises an EFS mount at /mnt/test.
import { promises as fs } from "node:fs";

const FILE = "/mnt/test/persist.txt";

export const handler = async (event: {
  rawPath?: string;
  requestContext?: { http?: { path?: string } };
  queryStringParameters?: Record<string, string>;
}) => {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  try {
    if (path === "/write") {
      const content = event.queryStringParameters?.content ?? "hello-from-efs";
      await fs.writeFile(FILE, content, "utf8");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ written: content }),
      };
    }
    if (path === "/read") {
      const content = await fs.readFile(FILE, "utf8");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          marker: process.env.DEPLOY_MARKER ?? "unset",
        }),
      };
    }
    if (path === "/mount") {
      const entries = await fs.readdir("/mnt/test");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mounted: true, entries }),
      };
    }
    return { statusCode: 200, body: "ok" };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: String(error) }),
    };
  }
};

export default handler;
