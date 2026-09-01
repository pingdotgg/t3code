import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  isValidDesktopUpdateRepository,
  normalizeDesktopUpdateRepository,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("desktop update repository", () => {
  it("normalizes GitHub URLs to owner/repository", () => {
    expect(normalizeDesktopUpdateRepository(" https://github.com/acme/t3code.git ")).toBe(
      "acme/t3code",
    );
  });

  it.each(["", "acme", "acme/t3code/releases", "https://example.com/acme/t3code"])(
    "rejects non-GitHub repository %j",
    (repository) => {
      expect(normalizeDesktopUpdateRepository(repository)).toBeNull();
      expect(isValidDesktopUpdateRepository(repository)).toBe(false);
    },
  );
});
