// @effect-diagnostics nodeBuiltinImport:off - Real browsers keep their saved profile in a real folder.
import { chromium, type BrowserContext } from "playwright-core";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "../preview/ServerBrowserContexts.ts";

// localhost is a secure context, so WebAuthn runs there.
const ORIGIN = "http://localhost";
const PUBLIC_KEY = `{ challenge: new Uint8Array(32), rp: { name: "t" },
  user: { id: new Uint8Array(8), name: "u", displayName: "u" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }] }`;
const settled = (request: string) => `${request}.then(() => "resolved", (error) => error.name)`;
const GET = settled(`navigator.credentials.get({ publicKey: ${PUBLIC_KEY} })`);

// Playwright launches its own headless shell in place of the path T3 would pass.
const original = {
  launch: chromium.launch.bind(chromium),
  persistent: chromium.launchPersistentContext.bind(chromium),
};
const withoutPath = <Options extends { readonly executablePath?: string }>(options?: Options) => {
  const { executablePath: _path, ...rest } = options ?? ({} as Options);
  return rest;
};
vi.spyOn(chromium, "launch").mockImplementation((options) => original.launch(withoutPath(options)));
vi.spyOn(chromium, "launchPersistentContext").mockImplementation((directory, options) =>
  original.persistent(directory, withoutPath(options)),
);

describe.each([
  ["a shared browser", "incognito"],
  ["a saved profile", "default"],
])("passkey requests in %s", (_owner, profileId) => {
  let profilesDir: string;
  let contexts: ServerBrowserContexts;
  let context: BrowserContext;

  beforeAll(async () => {
    profilesDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preview-prompts-"));
    // Like other browser tests, run without Chrome's sandbox, which some CI hosts lack.
    const env = { T3CODE_SERVER_BROWSER_SANDBOX: "0" };
    contexts = new ServerBrowserContexts({
      profilesDir,
      executable: async () => "chrome",
      env,
      chrome: { version: "157.0.8103.78", platform: "linux" },
    });
    context = await contexts.contextFor(profileId);
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
  });
  afterAll(async () => {
    await contexts?.close();
    await NodeFSP.rm(profilesDir, { recursive: true, force: true });
  });

  const open = async () => {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    return page;
  };

  it("refuse at once in a tab", async () => {
    const page = await open();
    expect(await page.evaluate(GET)).toBe("NotAllowedError");
  });

  it("refuse at once in a popup the page opens", async () => {
    const page = await open();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(`void open("/popup")`),
    ]);
    expect(await popup.evaluate(GET)).toBe("NotAllowedError");
  });

  it("never register a passkey", async () => {
    const page = await open();
    const create = settled(`navigator.credentials.create({ publicKey: { ...${PUBLIC_KEY},
      authenticatorSelection: { userVerification: "discouraged" } } })`);
    expect(await page.evaluate(create)).toBe("NotAllowedError");
  });

  it("still refuse after another session on the page detaches", async () => {
    const page = await open();
    await (await context.newCDPSession(page)).detach();
    expect(await page.evaluate(GET)).toBe("NotAllowedError");
  });
});
