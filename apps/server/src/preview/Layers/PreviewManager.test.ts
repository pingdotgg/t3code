import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { waitForRuntimeReady } from "./PreviewManager.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

async function startReadinessServer(statusByPath: Readonly<Record<string, number>>) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const status = statusByPath[requestUrl.pathname] ?? 404;
    response.statusCode = status;
    response.end(status === 200 ? "ok" : "failed");
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  cleanupTasks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );

  return baseUrl;
}

describe("waitForRuntimeReady", () => {
  it("waits for every readiness path", async () => {
    const baseUrl = await startReadinessServer({
      "/preview.html": 200,
      "/src/main.tsx": 200,
      "/@fs/repo/src/Button.preview.tsx": 200,
    });

    await expect(
      waitForRuntimeReady(baseUrl, 250, [
        "/preview.html",
        "/src/main.tsx",
        "/@fs/repo/src/Button.preview.tsx?import",
      ]),
    ).resolves.toBeUndefined();
  });

  it("fails when a readiness module never responds successfully", async () => {
    const baseUrl = await startReadinessServer({
      "/preview.html": 200,
      "/src/main.tsx": 200,
      "/@fs/repo/src/Button.preview.tsx": 500,
    });

    await expect(
      waitForRuntimeReady(baseUrl, 250, [
        "/preview.html",
        "/src/main.tsx",
        "/@fs/repo/src/Button.preview.tsx?import",
      ]),
    ).rejects.toThrow("/@fs/repo/src/Button.preview.tsx?import returned 500");
  });
});
