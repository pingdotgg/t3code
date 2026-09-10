import { expect, it } from "@effect/vitest";

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

it("keeps an already durable absolute path", () => {
  expect(stableNodeExecutablePath("/opt/homebrew/bin/node")).toBe("/opt/homebrew/bin/node");
  expect(stableNodeExecutablePath("/usr/bin/node")).toBe("/usr/bin/node");
  expect(stableNodeExecutablePath("/Users/theo/.nvm/versions/node/v22.16.0/bin/node")).toBe(
    "/Users/theo/.nvm/versions/node/v22.16.0/bin/node",
  );
});

it("prefers argv0 when it is already a non-keg absolute", () => {
  expect(
    stableNodeExecutablePath("/opt/homebrew/Cellar/node/26.8.1/bin/node", "/opt/homebrew/bin/node"),
  ).toBe("/opt/homebrew/bin/node");
  expect(
    stableNodeExecutablePath(
      "/opt/homebrew/Cellar/node@22/22.14.0/bin/node",
      "/opt/homebrew/opt/node@22/bin/node",
    ),
  ).toBe("/opt/homebrew/opt/node@22/bin/node");
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
