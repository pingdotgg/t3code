/**
 * Dev v2 ("hmr" mode) spec: spawns `scripts/hmr-server.mjs` — the Framework
 * service driving the real `next dev` (Turbopack) with proxied Cloudflare
 * bindings — in a CHILD Node process (next's require hooks collide with
 * playwright's in-worker transform, and a separate process is how the dev
 * server runs in real life), then exercises over HTTP:
 *
 * - the page serves through the real `next dev` (Turbopack) server
 * - `getCloudflareContext().env` sees a binding value in SSR output —
 *   without `initOpenNextCloudflareForDev()` and without wrangler
 * - the same binding read from an API route
 * - an edit to a page file is reflected on a subsequent request (bounded
 *   retry; the file is restored in a finally)
 */
import { expect, test } from "@playwright/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const probePage = NodePath.join(root, "app", "hmr-probe", "page.jsx");

let child: NodeChildProcess.ChildProcess;
let url: URL;

/** GET `path` until `predicate(body)` holds — bounded polling. */
const pollText = async (
  path: string,
  predicate: (body: string) => boolean,
  { times = 60 }: { times?: number } = {},
): Promise<string> => {
  let last = "";
  for (let i = 0; i < times; i++) {
    try {
      const response = await fetch(new URL(path, url));
      const body = await response.text();
      last = `status ${response.status}: ${body.slice(0, 500).replace(/\n/g, " ")}`;
      if (response.status === 200 && predicate(body)) return body;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`not ready after ${times} attempts: ${last}`);
};

test.beforeAll(async () => {
  // Cold `next dev` prepare + first Turbopack compile can be slow.
  test.setTimeout(300_000);
  child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(root, "scripts", "hmr-server.mjs")],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
  );
  url = await new Promise<URL>((resolve, reject) => {
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/DEV_URL (\S+)/);
      if (match !== null) resolve(new URL(match[1]!));
    });
    child.once("exit", (code) =>
      reject(new Error(`hmr-server exited before reporting a URL (code ${code}): ${buffer}`)),
    );
  });
});

test.afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    // The driver closes the Next app + binding proxy on SIGTERM; escalate
    // if it wedges so the suite never hangs on teardown.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timeout);
  }
});

test.describe("hmr dev mode", () => {
  test("serves the SSR page through next dev", async () => {
    const body = await pollText("/", (b) => b.includes("fixtures-nextjs SSR page"));
    expect(body).toContain("rendered-at:");
  });

  test("getCloudflareContext().env binding is visible in SSR output", async () => {
    const body = await pollText("/hmr-probe", (b) => b.includes("hmr-binding:"));
    // React may render an empty comment between adjacent text nodes.
    expect(body).toMatch(/hmr-binding:(?:<!-- -->)?hello-from-binding/);
    expect(body).toContain("marker:v1");
  });

  test("reads a Text binding through getCloudflareContext in an API route", async () => {
    const response = await fetch(new URL("/api/binding", url));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { value: string | null };
    expect(json.value).toBe("hello-from-binding");
  });

  test("reflects a page edit on a subsequent request", async () => {
    test.setTimeout(180_000);
    // Warm the page first so the edit is an incremental recompile.
    await pollText("/hmr-probe", (b) => b.includes("marker:v1"));
    const original = await NodeFs.readFile(probePage, "utf8");
    try {
      await NodeFs.writeFile(probePage, original.replace("marker:v1", "marker:v2"), "utf8");
      const body = await pollText("/hmr-probe", (b) => b.includes("marker:v2"), { times: 120 });
      expect(body).toContain("marker:v2");
    } finally {
      await NodeFs.writeFile(probePage, original, "utf8");
    }
  });
});
