import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

async function withRouteServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (tryHandleProjectFaviconRequest(url, res)) {
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
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

async function requestProjectFavicon(baseUrl: string, cwd: string): Promise<HttpResponse> {
  return request(baseUrl, `/api/project-favicon?cwd=${encodeURIComponent(cwd)}`);
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
    writeFile(projectDir, "favicon.svg", "<svg>favicon</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>favicon</svg>");
    });
  });

  it("keeps the root fast path ahead of recursive app matches", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-root-priority-");
    writeFile(projectDir, "favicon.svg", "<svg>root</svg>");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>nested-app</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>root</svg>");
    });
  });

  it("resolves icon href from source files when no well-known favicon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-source-");
    writeFile(projectDir, "index.html", '<link rel="icon" href="/brand/logo.svg">');
    writeFile(projectDir, "public/brand/logo.svg", "<svg>brand</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand</svg>");
    });
  });

  it("keeps source-declared icons ahead of recursive app matches", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-source-priority-");
    writeFile(projectDir, "index.html", '<link rel="icon" href="/brand/logo.svg">');
    writeFile(projectDir, "public/brand/logo.svg", "<svg>brand</svg>");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>nested-app</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>brand</svg>");
    });
  });

  it("resolves icon link when href appears before rel in HTML", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-html-order-");
    writeFile(projectDir, "index.html", '<link href="/brand/logo.svg" rel="icon">');
    writeFile(projectDir, "public/brand/logo.svg", "<svg>brand-html-order</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand-html-order</svg>");
    });
  });

  it("resolves object-style icon metadata when href appears before rel", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-obj-order-");
    writeFile(
      projectDir,
      "src/root.tsx",
      'const links = [{ href: "/brand/obj.svg", rel: "icon" }];',
    );
    writeFile(projectDir, "public/brand/obj.svg", "<svg>brand-obj-order</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand-obj-order</svg>");
    });
  });

  it("finds a nested favicon under apps when fast paths miss", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-apps-scan-");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>apps-public</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>apps-public</svg>");
    });
  });

  it("prefers apps over non-app recursive matches", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-apps-priority-");
    writeFile(projectDir, "shared/logo.svg", "<svg>shared</svg>");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>app</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>app</svg>");
    });
  });

  it("prefers public and app roots over less-specific paths inside the same app", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-app-location-");
    writeFile(projectDir, "apps/web/assets/favicon.svg", "<svg>assets</svg>");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>public</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>public</svg>");
    });
  });

  it("prefers shallower same-priority recursive matches before alphabetical tie-breaks", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-depth-order-");
    writeFile(projectDir, "apps/web/alpha/favicon.svg", "<svg>alpha-deep</svg>");
    writeFile(projectDir, "apps/web/zeta/favicon.svg", "<svg>zeta-deep</svg>");
    writeFile(projectDir, "apps/web/favicon.svg", "<svg>root-shallow</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>root-shallow</svg>");
    });
  });

  it("uses alphabetical order for same-depth recursive ties", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-alpha-order-");
    writeFile(projectDir, "apps/web/alpha/favicon.svg", "<svg>alpha</svg>");
    writeFile(projectDir, "apps/web/zeta/favicon.svg", "<svg>zeta</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>alpha</svg>");
    });
  });

  it("excludes gitignored recursive favicon files", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-gitignore-");
    runGit(projectDir, ["init"]);
    writeFile(projectDir, ".gitignore", "apps/web/public/\n");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>ignored</svg>");
    writeFile(projectDir, "apps/docs/favicon.svg", "<svg>kept</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>kept</svg>");
    });
  });

  it("excludes tracked files that now match gitignore rules", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-gitignore-tracked-");
    runGit(projectDir, ["init"]);
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>tracked-ignored</svg>");
    writeFile(projectDir, "apps/docs/favicon.svg", "<svg>kept</svg>");
    runGit(projectDir, ["add", "apps/web/public/favicon.svg", "apps/docs/favicon.svg"]);
    writeFile(projectDir, ".gitignore", "apps/web/public/\n");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>kept</svg>");
    });
  });

  it("walks non-git workspaces recursively while skipping heavy directories", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-non-git-scan-");
    writeFile(projectDir, "node_modules/pkg/favicon.svg", "<svg>ignored-node-modules</svg>");
    writeFile(projectDir, ".cache/favicon.svg", "<svg>ignored-cache</svg>");
    writeFile(projectDir, "apps/web/public/favicon.svg", "<svg>kept</svg>");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.body).toBe("<svg>kept</svg>");
    });
  });

  it("serves a fallback favicon when no icon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-fallback-");

    await withRouteServer(async (baseUrl) => {
      const response = await requestProjectFavicon(baseUrl, projectDir);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });
});
