import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  formatSpecialistRoleLoadout,
  resolveSpecialistBinding,
  specialistBindingsEqual,
  specialistMcpServerEntries,
  ThreadSpecialist,
  ThreadSpecialistKey,
} from "./threadSpecialist.ts";

const decodeKey = Schema.decodeUnknownSync(ThreadSpecialistKey);
const decodeSpecialist = Schema.decodeUnknownSync(ThreadSpecialist);

describe("ThreadSpecialistKey", () => {
  it("accepts lowercase slugs", () => {
    assert.equal(decodeKey("dev-ui"), "dev-ui");
    assert.equal(decodeKey("factory"), "factory");
    assert.equal(decodeKey("a"), "a");
  });

  it("rejects uppercase, spaces, and leading hyphens", () => {
    assert.throws(() => decodeKey("Dev-UI"));
    assert.throws(() => decodeKey("dev ui"));
    assert.throws(() => decodeKey("-dev"));
    assert.throws(() => decodeKey("1dev"));
  });
});

describe("ThreadSpecialist", () => {
  it("requires key and label", () => {
    assert.deepEqual(
      decodeSpecialist({
        key: "dev-ui",
        label: "Dev UI",
        instructions: "Owns the web client.",
      }),
      {
        key: "dev-ui",
        label: "Dev UI",
        instructions: "Owns the web client.",
      },
    );
    assert.deepEqual(decodeSpecialist({ key: "dev-ui", label: "Dev UI" }), {
      key: "dev-ui",
      label: "Dev UI",
    });
  });

  it("accepts role-scoped skills and MCP servers", () => {
    assert.deepEqual(
      decodeSpecialist({
        key: "vault",
        label: "Vault",
        skills: ["vault-user", "systematic-debugging"],
        mcpServers: {
          vault: {
            type: "stdio",
            command: "vault-mcp",
            args: ["serve"],
            env: { VAULT_ADDR: "https://vault.example" },
          },
          docs: {
            type: "http",
            url: "https://docs.example/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      }),
      {
        key: "vault",
        label: "Vault",
        skills: ["vault-user", "systematic-debugging"],
        mcpServers: {
          vault: {
            type: "stdio",
            command: "vault-mcp",
            args: ["serve"],
            env: { VAULT_ADDR: "https://vault.example" },
          },
          docs: {
            type: "http",
            url: "https://docs.example/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      },
    );
  });

  it("rejects reserved t3-code MCP server names", () => {
    assert.throws(() =>
      decodeSpecialist({
        key: "vault",
        label: "Vault",
        mcpServers: {
          "t3-code": { type: "http", url: "http://127.0.0.1/mcp" },
        },
      }),
    );
  });
});

describe("resolveSpecialistBinding", () => {
  it("keeps prior skills and MCP when rebind omits them", () => {
    const prior = decodeSpecialist({
      key: "vault",
      label: "Vault",
      instructions: "old",
      skills: ["vault-user"],
      mcpServers: { vault: { type: "stdio", command: "vault-mcp" } },
    });
    assert.deepEqual(
      resolveSpecialistBinding({
        key: "vault",
        label: "Vault Ops",
        prior,
      }),
      {
        key: "vault",
        label: "Vault Ops",
        instructions: "old",
        skills: ["vault-user"],
        mcpServers: { vault: { type: "stdio", command: "vault-mcp" } },
      },
    );
  });

  it("replaces skills and MCP when provided", () => {
    const prior = decodeSpecialist({
      key: "vault",
      label: "Vault",
      skills: ["vault-user"],
      mcpServers: { vault: { type: "stdio", command: "vault-mcp" } },
    });
    assert.deepEqual(
      resolveSpecialistBinding({
        key: "vault",
        skills: ["new-skill"],
        mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } },
        prior,
      }),
      {
        key: "vault",
        label: "Vault",
        skills: ["new-skill"],
        mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } },
      },
    );
  });
});

describe("specialistBindingsEqual", () => {
  it("treats skill order as insignificant", () => {
    const left = decodeSpecialist({
      key: "vault",
      label: "Vault",
      skills: ["b", "a"],
    });
    const right = decodeSpecialist({
      key: "vault",
      label: "Vault",
      skills: ["a", "b"],
    });
    assert.isTrue(specialistBindingsEqual(left, right));
  });
});

describe("formatSpecialistRoleLoadout", () => {
  it("returns undefined without brief or skills", () => {
    assert.isUndefined(
      formatSpecialistRoleLoadout(decodeSpecialist({ key: "vault", label: "Vault" })),
    );
  });

  it("formats brief and skills for prompt injection", () => {
    const text = formatSpecialistRoleLoadout(
      decodeSpecialist({
        key: "vault",
        label: "Vault",
        instructions: "Own Vault ops.",
        skills: ["vault-user"],
      }),
    );
    assert.isTrue(text?.includes("Vault (`vault`)"));
    assert.isTrue(text?.includes("Own Vault ops."));
    assert.isTrue(text?.includes("`vault-user`"));
  });
});

describe("specialistMcpServerEntries", () => {
  it("returns sorted entries", () => {
    assert.deepEqual(
      specialistMcpServerEntries(
        decodeSpecialist({
          key: "vault",
          label: "Vault",
          mcpServers: {
            zebra: { type: "http", url: "https://z.example/mcp" },
            alpha: { type: "stdio", command: "alpha-mcp" },
          },
        }),
      ),
      [
        ["alpha", { type: "stdio", command: "alpha-mcp" }],
        ["zebra", { type: "http", url: "https://z.example/mcp" }],
      ],
    );
  });
});
