// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  cleanupDesktopBackendAdvertisements,
  createDesktopBackendAdvertisement,
  readDesktopBackendAdvertisements,
  resolveDesktopBackendAdvertisementDir,
  writeDesktopBackendAdvertisement,
} from "./desktopBackendAdvertisement.ts";

describe("desktop backend advertisements", () => {
  let t3Home: string;

  beforeEach(() => {
    t3Home = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-desktop-backend-advertisements-"),
    );
  });

  afterEach(() => {
    NodeFS.rmSync(t3Home, { force: true, recursive: true });
  });

  it("writes and reads live desktop backend advertisements", () => {
    writeDesktopBackendAdvertisement({
      t3Home,
      advertisement: createDesktopBackendAdvertisement({
        backendId: "desktop-backend-1",
        httpBaseUrl: "http://127.0.0.1:3773/",
        nowMs: 1_000,
      }),
    });

    expect(readDesktopBackendAdvertisements({ t3Home, nowMs: 2_000 })).toEqual({
      advertisements: [
        expect.objectContaining({
          backendId: "desktop-backend-1",
          httpBaseUrl: "http://127.0.0.1:3773/",
        }),
      ],
      malformed: 0,
    });
  });

  it("ignores expired and malformed advertisements", () => {
    writeDesktopBackendAdvertisement({
      t3Home,
      advertisement: createDesktopBackendAdvertisement({
        backendId: "expired",
        httpBaseUrl: "http://127.0.0.1:3773/",
        nowMs: 1_000,
        ttlMs: 100,
      }),
    });
    NodeFS.writeFileSync(
      NodePath.join(resolveDesktopBackendAdvertisementDir(t3Home), "bad.json"),
      "{",
    );

    expect(readDesktopBackendAdvertisements({ t3Home, nowMs: 2_000 })).toEqual({
      advertisements: [],
      malformed: 1,
    });
  });

  it("cleans advertisements after the expiry grace period", () => {
    writeDesktopBackendAdvertisement({
      t3Home,
      advertisement: createDesktopBackendAdvertisement({
        backendId: "expired",
        httpBaseUrl: "http://127.0.0.1:3773/",
        nowMs: 1_000,
        ttlMs: 100,
      }),
    });

    expect(cleanupDesktopBackendAdvertisements({ t3Home, nowMs: 2_000, graceMs: 0 })).toEqual({
      deleted: 1,
      errors: 0,
    });
    expect(readDesktopBackendAdvertisements({ t3Home, nowMs: 2_000 })).toEqual({
      advertisements: [],
      malformed: 0,
    });
  });
});
