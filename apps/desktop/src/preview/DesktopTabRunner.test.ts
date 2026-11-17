// @effect-diagnostics nodeBuiltinImport:off - Exercises uploads with a local fixture file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  PreviewTabId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import {
  CREDENTIAL_INSERT_FUNCTION,
  credentialFieldExpression,
  redactSensitiveValues,
} from "@t3tools/shared/credentialFill";
import { DesktopTabRunner } from "./DesktopTabRunner.ts";

const binding = {
  environmentId: EnvironmentId.make("fixture-environment"),
  threadId: ThreadId.make("fixture-thread"),
  tabId: PreviewTabId.make("fixture-tab"),
  deviceName: "Fixture desktop",
  snapshot: {
    threadId: ThreadId.make("fixture-thread"),
    tabId: PreviewTabId.make("fixture-tab"),
    runtime: "desktop" as const,
    navStatus: { _tag: "Idle" as const },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};
const request = (
  operation: PreviewAutomationRequest["operation"],
  input: unknown = {},
): PreviewAutomationRequest => ({
  requestId: "request-1",
  threadId: binding.threadId,
  tabId: binding.tabId,
  operation,
  input,
  timeoutMs: 1_000,
});

describe("desktop tab runner", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let runner: DesktopTabRunner;
  let reports: boolean[];
  let remembered: string[];
  let commands: string[];
  let focusEmulation: boolean[];
  let stallScreenshot = false;
  let nativeCapture: ((scale: number) => Promise<string>) | undefined;
  let attachRunner: () => Promise<void>;
  let screenshotStarted: (() => void) | undefined;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    // The native debugger has no second Playwright client auto-dismissing dialogs.
    page.on("dialog", () => {});
    await page.setContent(
      '<input id="password" type="password"><input id="name"><button onclick="this.textContent=\'Done\'">Send</button>',
    );
    reports = [];
    remembered = [];
    commands = [];
    focusEmulation = [];
    stallScreenshot = false;
    nativeCapture = undefined;
    screenshotStarted = undefined;
    runner = new DesktopTabRunner(
      binding,
      "connection-1",
      (report) => reports.push(report),
      (value) => redactSensitiveValues(value, remembered),
    );
    const cdp = await context.newCDPSession(page);
    // Electron's manager retains an already-enabled debugger across connections.
    await cdp.send("Runtime.enable");
    attachRunner = () =>
      runner.attach(
        {
          send: (method, params) => {
            commands.push(method);
            if (method === "Emulation.setFocusEmulationEnabled")
              focusEmulation.push(params["enabled"] as boolean);
            if (stallScreenshot && method === "Page.captureScreenshot") {
              screenshotStarted?.();
              return new Promise(() => {});
            }
            return cdp.send(method as Parameters<typeof cdp.send>[0], params as never);
          },
          receivesScreencast: () => true,
          ackScreencastFrame: () => {},
          targetId: async () => (await cdp.send("Target.getTargetInfo")).targetInfo.targetId,
          url: () => page.url(),
          title: () => "Fixture",
          userAgent: () => "Fixture",
          setDownloadDirectory: () => {},
          ...(nativeCapture ? { captureScreenshot: nativeCapture } : {}),
        },
        {
          on: (listener) => {
            const forward = (event: { method: string; params: unknown }) =>
              listener(event.method, event.params, "");
            // The native debugger emits the same page events the CDP client receives.
            const methods = [
              "Page.frameNavigated",
              "Page.lifecycleEvent",
              "Page.frameStartedLoading",
              "Page.frameStoppedLoading",
              "Runtime.executionContextCreated",
              "Runtime.executionContextDestroyed",
              "Runtime.executionContextsCleared",
              "Page.javascriptDialogOpening",
              "Page.javascriptDialogClosed",
              "Page.fileChooserOpened",
              "Input.dragIntercepted",
            ];
            const removers = methods.map((method) => {
              const handler = (params: unknown) => forward({ method, params });
              cdp.on(method as Parameters<typeof cdp.on>[0], handler);
              return () => cdp.off(method as Parameters<typeof cdp.off>[0], handler);
            });
            return () => {
              for (const remove of removers) remove();
            };
          },
        },
      );
    await attachRunner();
  });
  afterEach(async () => {
    await runner?.close();
    await context?.close();
  });

  it("uses shared snapshot text, refs, and a screenshot of the attached page", async () => {
    expect(focusEmulation).toEqual([true]);
    const result = await runner.respond(request("snapshot"));
    expect(result.ok).toBe(true);
    const snapshot = result.result as { accessibilityTree: string; screenshot: { data: string } };
    expect(Buffer.from(snapshot.screenshot.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(snapshot).toMatchObject({ visibleText: "Send" });
    const ref = snapshot.accessibilityTree.match(/button "Send" \[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeTruthy();
    expect((await runner.respond(request("click", { locator: `aria-ref=${ref}` }))).ok).toBe(true);
    expect(await page.locator("button").textContent()).toBe("Done");
    expect((await runner.respond(request("type", { locator: "#name", text: "Fixture" }))).ok).toBe(
      true,
    );
    expect(await page.locator("#name").inputValue()).toBe("Fixture");
    expect((await runner.respond(request("press", { key: "!" }))).ok).toBe(true);
    expect(await page.locator("#name").inputValue()).toBe("Fixture!");
    expect(await runner.respond(request("evaluate", { expression: "1+1" }))).toMatchObject({
      ok: true,
      result: 2,
    });
    await runner.close();
    expect(focusEmulation).toEqual([true, false]);
  });

  it("captures snapshots through the native adapter when the guest's CDP capture stalls", async () => {
    await runner.close();
    await page.setViewportSize({ width: 1600, height: 900 });
    nativeCapture = vi.fn(async (scale: number) => {
      // A separate capture source models Electron's native surface, which
      // still works when the guest debugger's screenshot command stalls.
      const native = await context.newCDPSession(page);
      try {
        // Electron's capturePage scales on its own; a clipped CDP capture stands in for it.
        const { data } = await native.send("Page.captureScreenshot", {
          format: "png",
          clip: { x: 0, y: 0, width: 1600, height: 900, scale },
        });
        return data;
      } finally {
        await native.detach();
      }
    });
    runner = new DesktopTabRunner(binding, "connection-native", () => {});
    await attachRunner();
    commands = [];
    stallScreenshot = true;

    const response = await runner.respond(request("snapshot"));
    expect(response.ok).toBe(true);
    const snapshot = response.result as {
      visibleText: string;
      screenshot: { data: string; width: number; height: number };
    };
    expect(snapshot.visibleText).toBe("Send");
    expect(nativeCapture).toHaveBeenCalledWith(0.8);
    expect(commands).not.toContain("Page.captureScreenshot");
    expect(snapshot.screenshot).toMatchObject({ width: 1280, height: 720 });
    const png = Buffer.from(snapshot.screenshot.data, "base64");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 720]);

    await page.evaluate(() => {
      Object.defineProperty(window, "__t3codeCredentialLocked", { value: true });
    });
    expect(await runner.respond(request("snapshot"))).toMatchObject({
      ok: true,
      result: { screenshot: { data: "", width: 0, height: 0 } },
    });
    expect(nativeCapture).toHaveBeenCalledTimes(1);
  });

  it("scrolls, hovers, selects, presses, drags and waits on the attached page", async () => {
    await page.setContent(`<style>body{min-height:3000px}#hover:hover{color:rgb(255,0,0)}#drop{width:200px;height:100px}</style>
      <input id="name"><div id="hover">Hover me</div><select id="select"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <div id="drag" draggable="true">Drag me</div><div id="drop" ondragover="event.preventDefault()" ondrop="this.textContent='Dropped'">Drop here</div>`);
    expect((await runner.respond(request("scroll", { deltaY: 700 }))).ok).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect((await runner.respond(request("hover", { locator: "#hover" }))).ok).toBe(true);
    expect(await page.locator("#hover").evaluate((e) => getComputedStyle(e).color)).toBe(
      "rgb(255, 0, 0)",
    );
    expect(
      await runner.respond(request("select", { locator: "#select", values: ["Beta"] })),
    ).toMatchObject({ ok: true, result: { selected: ["b"] } });
    await runner.respond(request("click", { locator: "#name" }));
    expect((await runner.respond(request("press", { key: "A" }))).ok).toBe(true);
    expect(await page.locator("#name").inputValue()).toBe("A");
    expect((await runner.respond(request("drag", { source: "#drag", target: "#drop" }))).ok).toBe(
      true,
    );
    expect(
      (await runner.respond(request("waitFor", { locator: "#drop", text: "Dropped" }))).ok,
    ).toBe(true);
    expect((await runner.respond(request("waitFor", { text: "Missing", timeoutMs: 10 }))).ok).toBe(
      false,
    );
  });

  it("reports and resolves a prompt without queueing behind the click", async () => {
    await page.setContent(
      `<button onclick="document.querySelector('p').textContent=prompt('Name?', 'Default')">Prompt</button><p></p>`,
    );
    expect((await runner.respond(request("click", { locator: "button" }))).ok).toBe(true);
    expect(await runner.respond(request("status"))).toMatchObject({
      ok: true,
      result: { dialog: { type: "prompt", message: "Name?", defaultValue: "Default" } },
    });
    expect((await runner.respond(request("dialog", { accept: true, promptText: "Nick" }))).ok).toBe(
      true,
    );
    expect(await page.locator("p").textContent()).toBe("Nick");
    await runner.respond(request("click", { locator: "button" }));
    expect((await runner.respond(request("dialog", { accept: false }))).ok).toBe(true);
    expect(await page.locator("p").textContent()).toBe("");
  });

  it("uploads directly and through the page's intercepted file picker", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-desktop-upload-test-"),
    );
    const path = NodePath.join(directory, "fixture.txt");
    try {
      await NodeFSP.writeFile(path, "Desktop upload fixture");
      await page.setContent('<input id="file" type="file">');
      expect(
        (await runner.respond(request("upload", { locator: "#file", paths: [path] }))).ok,
      ).toBe(true);
      expect(
        await page.locator("#file").evaluate((e: HTMLInputElement) => e.files?.[0]?.name),
      ).toBe("fixture.txt");
      await runner.respond(request("click", { locator: "#file" }));
      expect(await runner.respond(request("status"))).toMatchObject({
        ok: true,
        result: { fileChooser: { multiple: false } },
      });
      expect((await runner.respond(request("upload", { paths: [] }))).ok).toBe(true);
      expect(await page.locator("#file").evaluate((e: HTMLInputElement) => e.files?.length)).toBe(
        0,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("resizes CSS layout and emulates page appearance", async () => {
    expect(
      await runner.respond(request("resize", { mode: "preset", preset: "iphone-12-pro" })),
    ).toMatchObject({ ok: true, result: { viewport: { width: 390, height: 844 } } });
    expect(await page.evaluate(() => innerWidth)).toBe(390);
    expect((await runner.respond(request("setColorScheme", { colorScheme: "dark" }))).ok).toBe(
      true,
    );
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
      true,
    );
    expect((await runner.respond(request("setColorScheme", { colorScheme: "system" }))).ok).toBe(
      true,
    );
    expect((await runner.respond(request("resize", { mode: "fill" }))).ok).toBe(true);
    expect(await page.evaluate(() => innerWidth)).toBe(1280);
    expect((await runner.respond(request("snapshot"))).result).toMatchObject({
      screenshot: { width: 1280, height: 720 },
    });
  });

  it("opens fresh tab-only endpoints, drives the same page, and closes clients on host disconnect", async () => {
    const getEndpoint = async () => {
      const result = await runner.respond(request("cdpEndpoint"));
      expect(result.ok).toBe(true);
      return (result.result as { endpoint: string }).endpoint;
    };
    expect(
      (
        await runner.respond({
          ...request("cdpEndpoint"),
          threadId: ThreadId.make("another-thread"),
        })
      ).ok,
    ).toBe(false);
    const first = await getEndpoint();
    const second = await getEndpoint();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[\w-]{32}$/);
    const endpointUrl = new URL(first);
    await expect(
      chromium.connectOverCDP(`${endpointUrl.origin.replace("http", "ws")}/wrong-secret`, {
        timeout: 500,
      }),
    ).rejects.toThrow();
    const script = await chromium.connectOverCDP(first, { timeout: 2_000 });
    const scriptPage = script.contexts()[0]!.pages()[0]!;
    expect(script.contexts().flatMap((c) => c.pages())).toHaveLength(1);
    await scriptPage.locator("#name").fill("Playwright script");
    expect(await page.locator("#name").inputValue()).toBe("Playwright script");
    expect((await runner.respond(request("snapshot"))).ok).toBe(true);
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Script navigation arrived</p>" }),
    );
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "http://fixture.test/destination";
      link.textContent = "Script destination";
      document.body.append(link);
    });
    await scriptPage.getByText("Script destination", { exact: true }).click();
    await scriptPage.waitForURL("http://fixture.test/destination");
    expect(await page.locator("p").textContent()).toBe("Script navigation arrived");
    expect((await runner.respond(request("snapshot"))).ok).toBe(true);
    await expect(script.contexts()[0]!.newPage()).rejects.toThrow();
    const disconnected = new Promise<void>((resolve) =>
      script.once("disconnected", () => resolve()),
    );
    await runner.close();
    await disconnected;
    await expect(chromium.connectOverCDP(second, { timeout: 500 })).rejects.toThrow();
    expect(page.isClosed()).toBe(false);
  });

  it("keeps agent automation working after a public Playwright browser closes", async () => {
    const endpoint = ((await runner.respond(request("cdpEndpoint"))).result as { endpoint: string })
      .endpoint;
    const script = await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
    const scriptPage = script.contexts()[0]!.pages()[0]!;
    await scriptPage.locator("#name").fill("Public script");
    await script.close();
    expect(page.isClosed()).toBe(false);
    expect(await runner.respond(request("snapshot"))).toMatchObject({ ok: true });
    expect(
      await runner.respond(request("type", { locator: "#name", text: "Agent recovered" })),
    ).toMatchObject({ ok: true });
    expect(await page.locator("#name").inputValue()).toBe("Public scriptAgent recovered");
    await expect(chromium.connectOverCDP(endpoint, { timeout: 1_000 })).rejects.not.toThrow(
      /Timeout/,
    );
  });

  it("can close a runner with a stalled capture and rehost the same guest", async () => {
    const endpoint = ((await runner.respond(request("cdpEndpoint"))).result as { endpoint: string })
      .endpoint;
    const script = await chromium.connectOverCDP(endpoint);
    stallScreenshot = true;
    const capturing = new Promise<void>((resolve) => {
      screenshotStarted = resolve;
    });
    const snapshot = runner.respond(request("snapshot"));
    await capturing;
    expect(await runner.respond(request("status"))).toMatchObject({ ok: true });
    await runner.close();
    expect((await snapshot).ok).toBe(false);
    expect(script.isConnected()).toBe(false);
    expect(page.isClosed()).toBe(false);
    stallScreenshot = false;
    runner = new DesktopTabRunner(binding, "connection-2", (report) => reports.push(report));
    await attachRunner();
    expect(await runner.respond(request("snapshot"))).toMatchObject({ ok: true });
  });

  it("revokes public endpoints before a Vault fill and refuses scripts and new endpoints", async () => {
    const first = ((await runner.respond(request("cdpEndpoint"))).result as { endpoint: string })
      .endpoint;
    const unopened = ((await runner.respond(request("cdpEndpoint"))).result as { endpoint: string })
      .endpoint;
    const script = await chromium.connectOverCDP(first);
    let disconnected = false;
    const closed = new Promise<void>((resolve) =>
      script.once("disconnected", () => {
        disconnected = true;
        resolve();
      }),
    );
    let queuedEndpoint: Promise<unknown> | undefined;
    let queuedEvaluation: Promise<unknown> | undefined;
    await runner.fillCredential(async () => {
      await closed;
      expect(disconnected).toBe(true);
      queuedEndpoint = runner.respond(request("cdpEndpoint"));
      queuedEvaluation = runner.respond(
        request("evaluate", { expression: "document.body.innerText" }),
      );
      expect(await page.locator("#password").inputValue()).toBe("");
      await expect(chromium.connectOverCDP(unopened, { timeout: 500 })).rejects.toThrow();
      // Use the native insertion function with a simulated Vault value, never real Vault data.
      const cdp = await context.newCDPSession(page);
      const field = await cdp.send("Runtime.evaluate", {
        expression: credentialFieldExpression("password"),
      });
      const result = await cdp.send("Runtime.callFunctionOn", {
        objectId: field.result.objectId!,
        functionDeclaration: CREDENTIAL_INSERT_FUNCTION,
        arguments: ["password", "simulated-vault-password", "null", true].map((value) => ({
          value,
        })),
        returnByValue: true,
      });
      expect(result.result.value).toBe("filled");
      await cdp.detach();
    });
    for (const queued of [queuedEndpoint, queuedEvaluation])
      expect(await queued).toMatchObject({
        ok: false,
        error: { _tag: "PreviewAutomationCredentialLockError" },
      });
    expect(await page.locator("#password").inputValue()).toBe("simulated-vault-password");
    expect(await page.locator("#password").getAttribute("type")).toBe("password");
    expect(await runner.respond(request("credentialLock"))).toMatchObject({
      ok: true,
      result: { tabId: binding.tabId, locked: true },
    });
    for (const operation of ["evaluate", "cdpEndpoint"] as const) {
      expect(
        await runner.respond(request(operation, { expression: "document.body.innerText" })),
      ).toMatchObject({ ok: false, error: { _tag: "PreviewAutomationCredentialLockError" } });
    }
    const captures = commands.filter((method) => method === "Page.captureScreenshot").length;
    expect(await runner.respond(request("snapshot"))).toMatchObject({
      ok: true,
      result: { screenshot: { data: "", width: 0, height: 0 } },
    });
    expect(JSON.stringify(await runner.respond(request("snapshot")))).not.toContain(
      "simulated-vault-password",
    );
    expect(commands.filter((method) => method === "Page.captureScreenshot")).toHaveLength(captures);
  });

  it("revokes issued endpoints when the tab closes", async () => {
    const endpoint = ((await runner.respond(request("cdpEndpoint"))).result as { endpoint: string })
      .endpoint;
    const script = await chromium.connectOverCDP(endpoint);
    // The manager closes the runner on the guest's destroyed event.
    page.once("close", () => {
      void runner.close();
    });
    const disconnected = new Promise<void>((resolve) =>
      script.once("disconnected", () => resolve()),
    );
    await page.close();
    await disconnected;
    await expect(chromium.connectOverCDP(endpoint, { timeout: 500 })).rejects.toThrow();
  });

  it("redacts every text read, including evaluation and selected values", async () => {
    await page.setContent(
      '<input id="password" type="password" value="hidden-secret"><select><option>hidden-secret</option></select><p>hidden-secret</p>',
    );
    for (const [operation, input] of [
      ["snapshot", {}],
      ["status", {}],
      ["evaluate", { expression: '"hidden-secret"' }],
      ["select", { locator: "select", values: ["hidden-secret"] }],
    ] as const) {
      const response = await runner.respond(request(operation, input));
      expect(response.ok).toBe(true);
      expect(JSON.stringify(response)).not.toContain("hidden-secret");
    }
  });

  it("redacts filled credentials from text and aria snapshots and fails closed on a lock check error", async () => {
    const secret = "fixture-secret-value";
    expect(
      await runner.respond(
        request("credentialFill", {
          initiator: "agent",
          field: "password",
          expectedOrigin: "null",
          fieldExpression: credentialFieldExpression("password"),
          value: secret,
        }),
      ),
    ).toMatchObject({ ok: true, result: { status: "filled" } });
    expect(await runner.respond(request("credentialLock"))).toMatchObject({
      ok: true,
      result: { locked: false },
    });
    expect(await runner.respond(request("evaluate", { expression: "1 + 1" }))).toMatchObject({
      ok: true,
      result: 2,
    });
    await page.evaluate(() => {
      document.body.append("fixture-secret-value");
      document.title = "fixture-secret-value";
      document.querySelector("#password")?.remove();
    });
    const response = await runner.respond(request("snapshot"));
    expect(response.ok).toBe(true);
    expect(JSON.stringify(response)).not.toContain(secret);

    expect(JSON.stringify(await runner.respond(request("status")))).not.toContain(secret);
    await page
      .evaluate(() => {
        Object.defineProperty(window, "__t3codeCredentialLocked", {
          get() {
            throw new Error("Cannot check");
          },
        });
      })
      .catch(() => undefined);
    // A page that will not execute the lock expression must not produce a snapshot.
    await page.addInitScript(() => {
      Object.defineProperty(window, "__t3codeCredentialLocked", {
        get() {
          throw new Error("Cannot check");
        },
      });
    });
    await page.goto("about:blank");
    expect((await runner.respond(request("snapshot"))).ok).toBe(false);
  });

  it("withholds pixels from a credential-locked desktop document", async () => {
    await page.evaluate(() => {
      Object.defineProperty(window, "__t3codeCredentialLocked", { value: true });
    });
    expect(await runner.respond(request("snapshot"))).toMatchObject({
      ok: true,
      result: { screenshot: { data: "", width: 0, height: 0 } },
    });
  });

  it("navigates the attached tab and snapshots its new document", async () => {
    await page.route("https://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Destination</title><p>Arrived</p>",
      }),
    );
    const navigation = await runner.respond(
      request("navigate", { url: "https://fixture.test/destination" }),
    );
    expect(navigation.ok).toBe(true);
    expect(navigation.result).toMatchObject({
      url: "https://fixture.test/destination",
      title: "Destination",
    });
    const snapshot = await runner.respond(request("snapshot"));
    expect(snapshot.ok).toBe(true);
    expect(snapshot.result).toMatchObject({ visibleText: "Arrived" });
  });

  it("serializes queued actions and closes the relay without closing the page", async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocker = runner.control.agent("agent", () => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await running;
    const queued = runner.respond(request("type", { locator: "#name", text: "queued" }));
    expect(await page.locator("#name").inputValue()).toBe("");
    release();
    await blocker;
    expect((await queued).ok).toBe(true);
    expect(await page.locator("#name").inputValue()).toBe("queued");
    expect(reports.at(-1)).toBe(false);
    await runner.close();
    expect(page.isClosed()).toBe(false);
    expect((await runner.respond(request("type", { locator: "#name", text: "late" }))).ok).toBe(
      false,
    );
  });
});
