import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("vscode", () => ({}));

import { routeFromUri } from "./extension.ts";

describe("routeFromUri", () => {
  it("opens the chat index for new thread resources", () => {
    expect(routeFromUri({ path: "/local/new" } as never)).toBe("/_chat/");
  });

  it("opens a specific thread route when the URI includes environment and thread ids", () => {
    expect(routeFromUri({ path: "/local/thread with spaces" } as never)).toBe(
      "/_chat/local/thread%20with%20spaces",
    );
  });
});
