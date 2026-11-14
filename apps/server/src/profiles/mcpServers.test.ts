import { assert, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveProfileMcpServers } from "./mcpServers.ts";

const token = { provider: SecretProviderId.make("personal"), reference: "op://Vault/Docs/token" };
const servers = {
  docs: {
    type: "http" as const,
    url: "https://docs.example/mcp",
    headers: { Authorization: token, "X-Plain": "plain" },
  },
  local: { command: "npx", args: ["-y", "local-mcp"], env: { TOKEN: token } },
};
const resolver = (value: string | undefined) =>
  Option.some({
    read: (references: ReadonlyArray<unknown>) => Effect.succeed(references.map(() => value)),
    invalidate: () => Effect.void,
    label: () => Effect.succeed("1Password"),
  });

it.effect("reads secrets, and refuses commands this machine has not allowed", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* resolveProfileMcpServers({
        servers,
        allowCommands: true,
        resolver: resolver("secret"),
      }),
      {
        docs: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { Authorization: "secret", "X-Plain": "plain" },
        },
        local: {
          type: "stdio",
          command: "npx",
          args: ["-y", "local-mcp"],
          env: { TOKEN: "secret" },
        },
      },
    );
    assert.include(
      yield* resolveProfileMcpServers({
        servers,
        allowCommands: false,
        resolver: resolver("secret"),
      }).pipe(Effect.flip),
      "Allow MCP commands",
    );
    for (const unreadable of [resolver(undefined), resolver(" "), Option.none()])
      assert.include(
        yield* resolveProfileMcpServers({
          servers: { docs: servers.docs },
          allowCommands: false,
          resolver: unreadable,
        }).pipe(Effect.flip),
        "MCP server docs could not read its credential",
      );
  }),
);
