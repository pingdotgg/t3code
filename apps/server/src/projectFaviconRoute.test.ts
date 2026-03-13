import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";

interface HttpResponse {
  statusCode: number;
  contentType: string | null;
  body: string;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function makeUnreadable(filePath: string): void {
  fs.chmodSync(filePath, 0o000);
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function withRouteServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void Effect.runPromise(
      Effect.gen(function* () {
        if (yield* tryHandleProjectFaviconRequest(url, res)) {
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }).pipe(Effect.provide(NodeServices.layer)),
    ).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      if (!res.writableEnded) {
        res.end(error instanceof Error ? error.message : "Unhandled error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected server address to be an object");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function request(baseUrl: string, pathname: string): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

function requestProjectFavicon(baseUrl: string, projectDir: string): Promise<HttpResponse> {
  return request(baseUrl, `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`);
}

function expectSvgResponse(response: HttpResponse, expectedBody: string): void {
  expect(response.statusCode).toBe(200);
  expect(response.contentType).toContain("image/svg+xml");
  expect(response.body).toBe(expectedBody);
}

function expectFallbackSvgResponse(response: HttpResponse): void {
  expect(response.statusCode).toBe(200);
  expect(response.contentType).toContain("image/svg+xml");
  expect(response.body).toContain('data-fallback="project-favicon"');
}

describe("tryHandleProjectFaviconRequest", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 when cwd is missing", async () => {
    await withRouteServer(async (baseUrl) => {
      const response = await request(baseUrl, "/api/project-favicon");
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe("Missing cwd parameter");
    });
  });

  it("serves a well-known favicon file from the project root", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-root-");
    writeFile(path.join(projectDir, "favicon.svg"), "<svg>favicon</svg>");

    await withRouteServer(async (baseUrl) => {
      expectSvgResponse(await requestProjectFavicon(baseUrl, projectDir), "<svg>favicon</svg>");
    });
  });

  it.each([
    {
      name: "resolves icon link when href appears before rel in HTML",
      prefix: "t3code-favicon-route-html-order-",
      sourcePath: ["index.html"],
      sourceContents: '<link href="/brand/logo.svg" rel="icon">',
      iconPath: ["public", "brand", "logo.svg"],
      expectedBody: "<svg>brand-html-order</svg>",
    },
    {
      name: "resolves object-style icon metadata when href appears before rel",
      prefix: "t3code-favicon-route-obj-order-",
      sourcePath: ["src", "root.tsx"],
      sourceContents: 'const links = [{ href: "/brand/obj.svg", rel: "icon" }];',
      iconPath: ["public", "brand", "obj.svg"],
      expectedBody: "<svg>brand-obj-order</svg>",
    },
  ])("$name", async ({ prefix, sourcePath, sourceContents, iconPath, expectedBody }) => {
    const projectDir = makeTempDir(prefix);
    writeFile(path.join(projectDir, ...sourcePath), sourceContents);
    writeFile(path.join(projectDir, ...iconPath), expectedBody);

    await withRouteServer(async (baseUrl) => {
      expectSvgResponse(await requestProjectFavicon(baseUrl, projectDir), expectedBody);
    });
  });

  it("serves a fallback favicon when no icon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-fallback-");

    await withRouteServer(async (baseUrl) => {
      expectFallbackSvgResponse(await requestProjectFavicon(baseUrl, projectDir));
    });
  });

  it("treats unreadable favicon probes as misses and continues searching", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-unreadable-probes-");
    const unreadableFaviconPath = path.join(projectDir, "favicon.svg");
    writeFile(unreadableFaviconPath, "<svg>blocked-root</svg>");
    makeUnreadable(unreadableFaviconPath);
    const unreadableSourcePath = path.join(projectDir, "index.html");
    writeFile(unreadableSourcePath, '<link rel="icon" href="/brand/blocked.svg">');
    makeUnreadable(unreadableSourcePath);
    writeFile(
      path.join(projectDir, "src", "root.tsx"),
      'const links = [{ rel: "icon", href: "/brand/readable.svg" }];',
    );
    writeFile(
      path.join(projectDir, "public", "brand", "readable.svg"),
      "<svg>readable-from-source</svg>",
    );

    await withRouteServer(async (baseUrl) => {
      expectSvgResponse(
        await requestProjectFavicon(baseUrl, projectDir),
        "<svg>readable-from-source</svg>",
      );
    });
  });

  it("finds a nested app favicon from source metadata when cwd is a monorepo root", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-monorepo-source-");
    writeFile(
      path.join(projectDir, "apps", "frontend", "index.html"),
      '<link rel="icon" href="/brand/logo.svg">',
    );
    writeFile(
      path.join(projectDir, "apps", "frontend", "public", "brand", "logo.svg"),
      "<svg>nested-app</svg>",
    );

    await withRouteServer(async (baseUrl) => {
      expectSvgResponse(await requestProjectFavicon(baseUrl, projectDir), "<svg>nested-app</svg>");
    });
  });

  it("skips nested search roots that workspace entries ignore", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-ignored-search-root-");
    writeFile(path.join(projectDir, ".next", "public", "favicon.svg"), "<svg>ignored-next</svg>");

    await withRouteServer(async (baseUrl) => {
      expectFallbackSvgResponse(await requestProjectFavicon(baseUrl, projectDir));
    });
  });

  it("prefers a root favicon over nested workspace matches", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-root-priority-");
    writeFile(path.join(projectDir, "favicon.svg"), "<svg>root-first</svg>");
    writeFile(path.join(projectDir, "apps", "frontend", "public", "favicon.ico"), "nested-ico");

    await withRouteServer(async (baseUrl) => {
      expectSvgResponse(await requestProjectFavicon(baseUrl, projectDir), "<svg>root-first</svg>");
    });
  });

  it("skips a gitignored nested app directory", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-gitignored-app-");
    runGit(projectDir, ["init"]);
    writeFile(path.join(projectDir, ".gitignore"), "apps/frontend/\n");
    writeFile(
      path.join(projectDir, "apps", "frontend", "public", "favicon.svg"),
      "<svg>ignored-app</svg>",
    );

    await withRouteServer(async (baseUrl) => {
      expectFallbackSvgResponse(await requestProjectFavicon(baseUrl, projectDir));
    });
  });

  it("skips a gitignored root favicon and falls through to a nested app", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-gitignored-root-");
    runGit(projectDir, ["init"]);
    writeFile(path.join(projectDir, ".gitignore"), "/favicon.svg\n");
    writeFile(path.join(projectDir, "favicon.svg"), "<svg>ignored-root</svg>");
    writeFile(
      path.join(projectDir, "apps", "frontend", "public", "favicon.svg"),
      "<svg>nested-kept</svg>",
    );

    await withRouteServer(async (baseUrl) => {
      expectSvgResponse(await requestProjectFavicon(baseUrl, projectDir), "<svg>nested-kept</svg>");
    });
  });

  it("skips a gitignored source file when resolving icon metadata", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-gitignored-source-");
    runGit(projectDir, ["init"]);
    writeFile(path.join(projectDir, ".gitignore"), "index.html\n");
    writeFile(path.join(projectDir, "index.html"), '<link rel="icon" href="/brand/logo.svg">');
    writeFile(path.join(projectDir, "public", "brand", "logo.svg"), "<svg>ignored-source</svg>");

    await withRouteServer(async (baseUrl) => {
      expectFallbackSvgResponse(await requestProjectFavicon(baseUrl, projectDir));
    });
  });
});
