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
const { browser, page } = await openBrowser({
  width: 1600,
  height: 800,
  args: ["--host-resolver-rules=MAP *.tail-demo.ts.net 127.0.0.1"],
});
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

  const linkSeveral = page.getByRole("button", { name: "Link several…" });
  await linkSeveral.click();
  await page.getByRole("menuitem", { name: "From MacBook" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await beat("link-menu");
  await page.getByRole("menuitem", { name: "From MacBook" }).click();
  const dialog = page.getByRole("dialog", { name: /Link several machines from MacBook/ });
  await dialog.getByText("gpu-1", { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await beat("link-open");
  await dialog.getByText("gpu-1", { exact: true }).click();
  await dialog.getByText("gpu-2", { exact: true }).click();
  await page.waitForTimeout(300);
  await beat("link-picked");
  await dialog.getByRole("button", { name: /^Link 2 machines/ }).click();
  await page.waitForTimeout(500);
  await beat("linking");
  await dialog.getByText("Linked 2 machines", { exact: false }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(400);
  await beat("link-done");
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  await page.getByText("2 links out", { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await beat("linked");
} catch (error) {
  await page.screenshot({ path: NodePath.join(out, "shots", "failure.png") });
  throw error;
} finally {
  await browser.close();
}
