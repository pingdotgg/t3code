// Drives the MacBook web client to the environments map and freezes beats into <out>/beats.
// Needs serve.mjs running. Usage: drive.mjs <out-dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { saveBeat } from "../../scripts/snapshot.mjs";
import { openBrowser } from "../../scripts/stage-env.mjs";

const out = NodePath.resolve(process.argv[2] ?? "");
const stage = JSON.parse(NodeFS.readFileSync(NodePath.join(out, "stage.json"), "utf8"));
NodeFS.rmSync(NodePath.join(out, "beats"), { recursive: true, force: true });
NodeFS.mkdirSync(NodePath.join(out, "shots"), { recursive: true });

// Fictional tailnet names resolve to this machine in the browser only.
const { browser, context, page } = await openBrowser({
  width: 1600,
  height: 1300,
  args: ["--host-resolver-rules=MAP *.tail-demo.ts.net 127.0.0.1"],
});
// T3 Connect account machines this client isn't saved to, through the dev-only fake account.
await context.addInitScript(
  (value) => localStorage.setItem("t3code:dev:fake-t3-connect", value),
  JSON.stringify({
    account: { email: "demo@example.com" },
    environments: [
      {
        environmentId: "connect-mac-mini",
        label: "mac-mini",
        online: true,
        machine: "mac-mini",
        os: "darwin",
        arch: "arm64",
      },
      { environmentId: "connect-office", label: "office-pc", online: true, machine: "desktop" },
      {
        environmentId: "connect-thinkpad",
        label: "old-thinkpad",
        online: false,
        machine: "laptop",
      },
    ],
  }),
);
const started = Date.now();
const beat = async (name) => {
  await page.mouse.move(1439, 719);
  await page.waitForTimeout(250);
  await saveBeat(page, out, name);
  await page.screenshot({ path: NodePath.join(out, "shots", `${name}.png`) });
  console.log(`beat ${name} at ${((Date.now() - started) / 1000).toFixed(1)}s`);
};

// The client's saved environments: one target per route, in order of preference.
const { machines, tailnetName } = stage;
const route = (machine, url, token = machine.token) => {
  const origin = new URL(url).origin;
  const connectionId = `bearer:${machine.environmentId}:${origin}`;
  return {
    target: {
      _tag: "BearerConnectionTarget",
      environmentId: machine.environmentId,
      label: machine.label,
      connectionId,
    },
    profile: {
      _tag: "BearerConnectionProfile",
      connectionId,
      environmentId: machine.environmentId,
      label: machine.label,
      httpBaseUrl: `${origin}/`,
      wsBaseUrl: `${origin.replace(/^http/, "ws")}/`,
    },
    credential: { connectionId, credential: { _tag: "BearerConnectionCredential", token } },
  };
};
const relay = (machine) => ({
  target: {
    _tag: "RelayConnectionTarget",
    environmentId: machine.environmentId,
    label: machine.label,
  },
});
const routes = [
  // studio: a LAN route whose sign-in is refused, Tailscale in use, a LAN and T3 Connect standby.
  route(machines.studio, `http://studio.localhost:${machines.studio.port}`, "not-a-valid-token"),
  route(machines.studio, `http://studio.tail-demo.ts.net:${machines.studio.port}`),
  route(machines.studio, `http://10.0.0.24:${machines.studio.port}`),
  relay(machines.studio),
  route(machines.devbox, `http://devbox.tail-demo.ts.net:${machines.devbox.port}`),
  relay(machines.devbox),
  route(machines.nas, `http://nas.localhost:${machines.nas.port}`),
  route(machines.nas, `http://nas.tail-demo.ts.net:${machines.nas.port}`),
  route(machines.gpu1, `http://${tailnetName}:${machines.gpu1.port}`),
  route(machines.gpu2, `http://${tailnetName}:${machines.gpu2.port}`),
  route(machines.gpu3, `http://${tailnetName}:${machines.gpu3.port}`),
];
const catalog = JSON.stringify({
  schemaVersion: 1,
  targets: routes.map((r) => r.target),
  profiles: routes.flatMap((r) => (r.profile ? [r.profile] : [])),
  credentials: routes.flatMap((r) => (r.credential ? [r.credential] : [])),
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

try {
  await page.goto(stage.macbook.pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 120_000 });
  await page.waitForTimeout(3000);
  await page.evaluate(
    (document) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("t3code:connection-runtime", 5);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("catalog", "readwrite");
          tx.objectStore("catalog").put(document, "document");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    catalog,
  );
  await page.reload();
  await page.waitForTimeout(4000);
  // nas has been seen (its config is cached); now it goes offline.
  NodeFS.writeFileSync(NodePath.join(out, "stop-nas"), "");
  await page.goto(new URL("/settings/connections", stage.macbook.webOrigin).href);
  await page.getByText("fs-44", { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.getByText("Reconnecting…", { exact: false }).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2000);
  await beat("map");

  // Drags a node's plus handle onto `target`, freezing a beat halfway and one over the target.
  const center = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const node = (label) => page.locator(`button[data-fleet-item][aria-label^="${label},"]`);
  const dragLink = async (from, target, name) => {
    const plus = page.getByRole("button", { name: `Link ${from} to another machine` });
    await plus.scrollIntoViewIfNeeded();
    const start = await center(plus);
    const end = await center(node(target));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(
        start.x + ((end.x - start.x) * i) / 12,
        start.y + ((end.y - start.y) * i) / 12,
      );
      await page.waitForTimeout(30);
      if (i === 6) await saveBeat(page, out, `${name}-mid`);
    }
    await page.waitForTimeout(300);
    await saveBeat(page, out, `${name}-over`);
    await page.screenshot({ path: NodePath.join(out, "shots", `${name}-over.png`) });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };

  // One machine: drag MacBook's plus onto gpu-1.
  await dragLink("MacBook", "gpu-1", "drag1");
  await beat("single-open");
  const single = page.getByRole("dialog", { name: /Link MacBook to gpu-1/ });
  await single.getByRole("button", { name: "Link", exact: true }).click();
  await single.waitFor({ state: "hidden", timeout: 60_000 });
  await page.getByText("1 link out", { exact: false }).last().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await beat("single-linked");

  // Several: Shift-click gpu-2 and gpu-3, then drag MacBook's plus onto the selection.
  await node("gpu-2").click({ modifiers: ["Shift"] });
  await page.waitForTimeout(250);
  await beat("select-1");
  await node("gpu-3").click({ modifiers: ["Shift"] });
  await page.waitForTimeout(250);
  await beat("select-2");
  await dragLink("MacBook", "gpu-3", "drag2");
  const batch = page.getByRole("dialog", { name: /Link several machines from MacBook/ });
  await batch.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await beat("batch-open");
  await batch.getByRole("button", { name: /^Link 2 machines/ }).click();
  await batch.getByText("Linked 2 machines", { exact: false }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(400);
  await beat("batch-done");
  await batch.getByRole("button", { name: "Done" }).click();
  await batch.waitFor({ state: "hidden", timeout: 10_000 });
  await page.getByText("3 links out", { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await beat("linked");
} catch (error) {
  await page.screenshot({ path: NodePath.join(out, "shots", "failure.png") });
  throw error;
} finally {
  await browser.close();
}
