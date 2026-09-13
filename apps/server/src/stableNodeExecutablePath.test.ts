import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { stableNodeExecutablePath } from "./stableNodeExecutablePath.ts";

it("rewrites a Homebrew Cellar keg to the prefix shim", () => {
  expect(stableNodeExecutablePath("/opt/homebrew/Cellar/node/26.8.1/bin/node")).toBe(
    "/opt/homebrew/bin/node",
  );
  expect(stableNodeExecutablePath("/usr/local/Cellar/node/22.14.0/bin/node")).toBe(
    "/usr/local/bin/node",
  );
  expect(stableNodeExecutablePath("/home/linuxbrew/.linuxbrew/Cellar/node/24.4.0/bin/node")).toBe(
    "/home/linuxbrew/.linuxbrew/bin/node",
  );
});

it("rewrites a keg-only node@ formula to the Homebrew opt path", () => {
  expect(stableNodeExecutablePath("/opt/homebrew/Cellar/node@22/22.14.0/bin/node", "node")).toBe(
    "/opt/homebrew/opt/node@22/bin/node",
  );
});

it("keeps an unversioned Cellar rewrite when argv0 is bare node", () => {
  expect(stableNodeExecutablePath("/opt/homebrew/Cellar/node/26.8.1/bin/node", "node")).toBe(
    "/opt/homebrew/bin/node",
  );
});

it("keeps an already durable absolute path", () => {
  expect(stableNodeExecutablePath("/opt/homebrew/bin/node")).toBe("/opt/homebrew/bin/node");
  expect(stableNodeExecutablePath("/usr/bin/node")).toBe("/usr/bin/node");
  expect(stableNodeExecutablePath("/Users/theo/.nvm/versions/node/v22.16.0/bin/node")).toBe(
    "/Users/theo/.nvm/versions/node/v22.16.0/bin/node",
  );
});

it("ignores a relative or keg argv0 and still rewrites a Cellar execPath", () => {
  expect(stableNodeExecutablePath("/opt/homebrew/Cellar/node/26.8.1/bin/node", "node")).toBe(
    "/opt/homebrew/bin/node",
  );
  expect(
    stableNodeExecutablePath(
      "/opt/homebrew/Cellar/node/26.8.1/bin/node",
      "/opt/homebrew/Cellar/node/26.8.1/bin/node",
    ),
  ).toBe("/opt/homebrew/bin/node");
});

it("ignores an absolute argv0 that does not resolve to execPath", () => {
  expect(
    stableNodeExecutablePath("/opt/homebrew/Cellar/node/26.8.1/bin/node", "/tmp/not-node"),
  ).toBe("/opt/homebrew/bin/node");
});

it("prefers argv0 when it is a non-keg absolute that resolves to execPath", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stable-node-"));
  try {
    const cellar = NodePath.join(root, "Cellar", "node", "26.8.1", "bin", "node");
    const shim = NodePath.join(root, "bin", "node");
    NodeFS.mkdirSync(NodePath.dirname(cellar), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(shim), { recursive: true });
    NodeFS.writeFileSync(cellar, "");
    NodeFS.chmodSync(cellar, 0o755);
    NodeFS.symlinkSync(cellar, shim);

    expect(stableNodeExecutablePath(cellar, shim)).toBe(shim);
    expect(stableNodeExecutablePath(cellar, "/tmp/not-node")).toBe(shim);
    expect(stableNodeExecutablePath(cellar, "/bin/sh")).toBe(shim);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
