// Real web UI + Orchestrator + pinned Kilo CLI. All inference stays on this loopback fixture.
// KILO_BIN=/path/to/kilo KILO_EVIDENCE_DIR=/tmp/evidence node apps/desktop/scripts/kilo-ui-evidence.mjs
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { chromium } from "playwright-core";

if (!process.env.KILO_BIN) throw new Error("KILO_BIN must point to the pinned local CLI");
if (process.env.KILO_CLOUD_TEST_PROFILE && !process.env.KILO_CLOUD_TEST_REPOSITORY) {
  throw new Error(
    "KILO_CLOUD_TEST_REPOSITORY is required for an explicitly authorized live capture",
  );
}
const root = NodePath.resolve(import.meta.dirname, "../../..");
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-kilo-ui-"));
const evidence = process.env.KILO_EVIDENCE_DIR ?? NodePath.join(temporary, "evidence");
const state = NodePath.join(temporary, "state");
const workspace = NodePath.join(temporary, "kilo-ui-workspace");
await Promise.all([
  NodeFSP.mkdir(evidence, { recursive: true }),
  NodeFSP.mkdir(workspace),
  NodeFSP.mkdir(NodePath.join(state, "userdata"), { recursive: true }),
]);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "Local Kilo UI fixture\n");
for (const args of [
  ["init"],
  ["add", "."],
  [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ],
])
  await execFile("git", args, { cwd: workspace });
let requests = 0;
const answer =
  "Kilo local integration succeeded. This response came from the isolated local fixture.";
const model = NodeHttp.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    requests++;
    const data = JSON.parse(body);
    const prompt = JSON.stringify(data.messages ?? []);
    const text =
      prompt.includes("title") && prompt.includes("JSON")
        ? '{"title":"Kilo local verification"}'
        : answer;
    res.writeHead(200, { "Content-Type": data.stream ? "text/event-stream" : "application/json" });
    if (!data.stream) {
      res.end(
        JSON.stringify({
          id: "local",
          object: "chat.completion",
          created: 0,
          model: "test",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
        }),
      );
      return;
    }
    for (const chunk of text.match(/.{1,16}/g))
      res.write(
        `data: ${JSON.stringify({
          id: "local",
          object: "chat.completion.chunk",
          created: 0,
          model: "test",
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        })}\n\n`,
      );
    res.end(
      `data: ${JSON.stringify({
        id: "local",
        object: "chat.completion.chunk",
        created: 0,
        model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
      })}\n\ndata: [DONE]\n\n`,
    );
  });
});
model.listen(0, "127.0.0.1");
await NodeEvents.once(model, "listening");
const config = {
  model: "fixture/test",
  small_model: "fixture/test",
  plugin: [],
  enabled_providers: ["fixture"],
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local fixture",
      options: { baseURL: `http://127.0.0.1:${model.address().port}/v1` },
      models: { test: { name: "Local fixture", limit: { context: 10000, output: 1000 } } },
    },
  },
};
await NodeFSP.writeFile(
  NodePath.join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(
      ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "pi"].map((name) => [
        name,
        { enabled: false },
      ]),
    ),
    providerInstances: {
      kiloCloud: {
        driver: "kilo-cloud",
        displayName: "Kilo Cloud",
        enabled: !!process.env.KILO_CLOUD_TEST_PROFILE,
        config: {
          enabled: !!process.env.KILO_CLOUD_TEST_PROFILE,
          profileDirectory: process.env.KILO_CLOUD_TEST_PROFILE ?? "",
          repository: process.env.KILO_CLOUD_TEST_REPOSITORY ?? "synthetic/cloud-demo",
          branch: "main",
          model: "deepseek/deepseek-v4.1-flash",
          cloudConsent: !!process.env.KILO_CLOUD_TEST_PROFILE,
        },
      },
      kilo: {
        driver: "kilo",
        displayName: "Kilo",
        enabled: true,
        config: { binaryPath: process.env.KILO_BIN, accountId: "ui-fixture" },
        environment: [
          { name: "HOME", value: temporary },
          { name: "KILO_CONFIG_CONTENT", value: JSON.stringify(config) },
          ...[
            "KILO_DISABLE_MODELS_FETCH",
            "KILO_DISABLE_DEFAULT_PLUGINS",
            "KILO_DISABLE_EXTERNAL_SKILLS",
            "KILO_DISABLE_PROJECT_CONFIG",
          ].map((name) => ({ name, value: "1" })),
        ],
      },
    },
    textGenerationModelSelection: { instanceId: "kilo", model: "fixture/test", options: [] },
  }),
);
const child = NodeChildProcess.spawn("vp", ["run", "dev", "--home-dir", state], {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
let page;
try {
  const pair = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Isolated T3 did not become ready")), 120000);
    let output = "";
    const read = (chunk) => {
      output = (output + chunk).slice(-50000);
      // Startup output may contain ANSI color escapes immediately after the URL.
      // oxlint-disable-next-line no-control-regex
      const match = /pairingUrl:\s*(http[^\s\x1b]+)/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`T3 exited with ${code}`));
    });
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: evidence, size: { width: 1440, height: 1000 } },
  });
  page = await context.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(pair);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByText("Local folder", { exact: true }).click();
  await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").fill(workspace);
  await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").press("Enter");
  if (process.env.KILO_CLOUD_TEST_PROFILE) {
    await page.locator("[data-chat-provider-model-picker-label]").click();
    await page.getByPlaceholder("Search models...").fill("deepseek-v4.1-flash");
    await page.getByText("deepseek/deepseek-v4.1-flash", { exact: true }).last().click();
    await page
      .getByText("Closing T3 does not stop remote work or billing.", { exact: false })
      .waitFor();
    await page.getByRole("button", { name: "Unknown", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Low/ }).click();
    await page.getByRole("button", { name: "Low", exact: true }).waitFor();
    await page.screenshot({
      animations: "disabled",
      path: NodePath.join(evidence, "cloud-before-send.png"),
    });
  }
  await page.locator("[data-chat-provider-model-picker-label]").click();
  await page.getByPlaceholder("Search models...").fill("Local fixture");
  await page.getByText("Local fixture", { exact: true }).last().click();
  await page.getByRole("button", { name: "Local fixture", exact: true }).waitFor();
  await page.locator("[contenteditable=true]").fill("Kilo local integration: say hello.");
  await page.screenshot({
    animations: "disabled",
    path: NodePath.join(evidence, "before-send.png"),
  });
  await page.getByRole("button", { name: "Submit message", exact: true }).click();
  await page.getByText(answer, { exact: true }).waitFor({ timeout: 60000 });
  await page.screenshot({
    animations: "disabled",
    path: NodePath.join(evidence, "streamed-answer.png"),
  });
  await page.getByRole("button", { name: "Submit message", exact: true }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: NodePath.join(evidence, "completed-answer.png"),
  });
  console.log("Local native answer rendered; opening provider settings.");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForURL("**/settings/general*");
  await page.getByText("Restore device defaults", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.waitForURL("**/settings/providers*");
  await page.getByRole("button", { name: "Add provider", exact: true }).waitFor();
  await page.getByRole("button", { name: "Select Kilo", exact: true }).click();
  await page
    .getByText("Native configuration and MCP servers are trusted", { exact: false })
    .first()
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: NodePath.join(evidence, "local-trust-settings.png"),
  });
  await page.getByRole("button", { name: "Select Kilo Cloud", exact: true }).click();
  if (process.env.KILO_CLOUD_TEST_PROFILE) {
    const consent = page.getByRole("switch", { name: "Allow paid cloud execution", exact: true });
    await consent.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Allow paid cloud execution"]')
          ?.getAttribute("aria-checked") === "false",
    );
    await consent.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Allow paid cloud execution"]')
          ?.getAttribute("aria-checked") === "true",
    );
  }
  await page.screenshot({
    animations: "disabled",
    path: NodePath.join(evidence, "provider-settings.png"),
  });
  await context.close();
  if (!requests) throw new Error("The real CLI did not contact the local inference fixture");
  await NodeFSP.writeFile(
    NodePath.join(evidence, "verification.json"),
    JSON.stringify(
      {
        commit: (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
        inferenceRequests: requests,
        nativeConfigurationTrusted: true,
        inference: "loopback fixture only",
        client: "Chromium web",
      },
      null,
      2,
    ),
  );
  console.log("Kilo UI verification passed; screenshots and video saved.");
} catch (error) {
  await page?.screenshot({ path: NodePath.join(evidence, "failure.png") }).catch(() => {});
  console.error(String(error).replace(/https?:\/\/[^\s)]+/g, "[local URL]"));
  process.exitCode = 1;
} finally {
  await browser?.close();
  // This is the process group captured at spawn, never a PID discovered by matching.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already exited */
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
}
