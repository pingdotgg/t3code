import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import {
  BROWSER_OPERATE,
  BROWSER_SESSIONS,
  browserSessionsApi,
} from "@t3tools/extension-sdk/catalogue";

const anyObject = { type: "object" } as const;
const closedObject = { type: "object", additionalProperties: false } as const;
const read = (name: string) => ({
  name,
  effect: "read" as const,
  requiredGrants: [BROWSER_SESSIONS],
  inputSchema: closedObject,
  outputSchema: anyObject,
});
const write = (name: string) => ({
  name,
  effect: "write" as const,
  requiredGrants: [BROWSER_SESSIONS, BROWSER_OPERATE],
  inputSchema: anyObject,
  outputSchema: anyObject,
});

export default defineExtension({
  id: "example.browser-sessions",
  version: "1.0.0",
  requires: [requireApi(browserSessionsApi)],
  provides: [
    {
      id: "example.browser-sessions/mirror",
      version: "1.0.0",
      methods: [
        read("getCapabilities"),
        read("list"),
        write("open"),
        write("navigate"),
        write("close"),
        write("back"),
      ],
      streams: [
        {
          name: "events",
          requiredGrants: [BROWSER_SESSIONS],
          inputSchema: closedObject,
          eventSchema: anyObject,
        },
      ],
    },
  ],
  serverEntry: "server.ts",
});
