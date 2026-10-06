import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-mcp-registration");
const testFile = createOxlintRuleHarness("t3code/no-raw-mcp-registration", {
  filename: "server.test.ts",
});

describe("t3code/no-raw-mcp-registration", () => {
  rule.valid(
    "allows the rest of effect/ai and type-only McpServer imports",
    `
      import { McpSchema, Tool, Toolkit } from "effect/ai";
      import type { McpServer } from "effect/ai";
      import { type McpServer as Server } from "effect/ai";
      export type Service = McpServer.McpServer | Server.McpServer;
      export const used = [McpSchema, Tool, Toolkit];
    `,
  );

  rule.invalid(
    "reports importing McpServer from effect/ai",
    `
      import { McpServer } from "effect/ai";
      export const server = McpServer.McpServer;
    `,
    (output) => {
      assert.match(output, /Only McpHttpServer may use Effect's McpServer/);
    },
  );

  rule.invalid(
    "reports importing McpServer under another name",
    `
      import { McpServer as Server } from "effect/ai";
      export const registration = Server.toolkit(SomeToolkit);
    `,
  );

  rule.invalid(
    "reports a namespace import of effect/ai",
    `
      import * as Ai from "effect/ai";
      export const registration = Ai.McpServer.toolkit(SomeToolkit);
    `,
  );

  rule.invalid(
    "reports importing the McpServer module directly",
    `
      import { toolkit } from "effect/ai/McpServer";
      export const registration = toolkit(SomeToolkit);
    `,
  );

  rule.invalid(
    "reports re-exporting McpServer",
    `
      export { McpServer as Server } from "effect/ai";
    `,
  );

  rule.invalid(
    "reports re-exporting all of effect/ai",
    `
      export * from "effect/ai";
    `,
  );

  rule.invalid(
    "reports a dynamic import of the McpServer module",
    `
      export const load = () => import("effect/ai/McpServer");
    `,
  );

  rule.invalid(
    "reports a dynamic import written as a template",
    `
      export const load = () => import(\`effect/ai/McpServer\`);
    `,
  );

  rule.invalid(
    "reports McpServer.toolkit",
    `
      export const registration = McpServer.toolkit(SomeToolkit);
    `,
    (output) => {
      assert.match(output, /McpServer\.toolkit registers on \/mcp/);
    },
  );

  rule.invalid(
    "reports McpServer.resource and McpServer.prompt",
    `
      export const resource = McpServer.resource({ uri: "t3://x", name: "x", content: "x" });
      export const prompt = McpServer.prompt({ name: "x", content: () => "x" });
    `,
  );

  rule.invalid(
    "reports addTool on the McpServer service",
    `
      import * as Effect from "effect/Effect";
      export const register = Effect.gen(function* () {
        const server = yield* Service;
        yield* server.addTool({ tool, annotations, handle: () => Effect.die("unchecked") });
      });
    `,
    (output) => {
      assert.match(output, /\.addTool registers on \/mcp/);
    },
  );

  rule.invalid(
    "reports a registration method read without calling it",
    `
      export const add = server.addTool;
    `,
  );

  rule.invalid(
    "reports a registration function taken by destructuring",
    `
      const { toolkit } = McpServer;
      export const registration = toolkit(SomeToolkit);
    `,
  );

  rule.invalid(
    "reports a registration method taken by destructuring",
    `
      import * as Effect from "effect/Effect";
      export const register = Effect.gen(function* () {
        const { addTool } = yield* Service;
        yield* addTool({ tool, annotations, handle: () => Effect.die("unchecked") });
      });
    `,
  );

  testFile.valid(
    "lets tests import McpServer to build a server",
    `
      import { McpServer } from "effect/ai";
      export const layer = McpServer.McpServer.layer;
    `,
  );

  testFile.invalid(
    "reports a registration in a test",
    `
      import { McpServer } from "effect/ai";
      export const registration = McpServer.toolkit(SomeToolkit);
    `,
  );

  testFile.invalid(
    "reports a test importing McpServer under another name",
    `
      import { McpServer as Server } from "effect/ai";
      export const registration = Server.toolkit(SomeToolkit);
    `,
    (output) => {
      assert.match(output, /Tests import McpServer only as/);
    },
  );

  testFile.invalid(
    "reports a test importing effect/ai as a namespace",
    `
      import * as Ai from "effect/ai";
      export const registration = Ai.McpServer.toolkit(SomeToolkit);
    `,
  );

  testFile.invalid(
    "reports a test importing the McpServer module directly",
    `
      import { toolkit } from "effect/ai/McpServer";
      export const registration = toolkit(SomeToolkit);
    `,
  );
});
