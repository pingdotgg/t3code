import { expect } from "e2e";

import { MOBILE, MOBILE_T3_HOME } from "../e2e.config.ts";
import { environmentId, makeState, runPromise } from "./t3.ts";
import { IOS, test } from "./t3-mobile.ts";

const APP_ID = "com.t3tools.t3code.dev";
const SCHEME = "t3code-dev";
const TARGET_BYTES = 1_048_320;
const BYTES_PER_CHAR = 2;
const TURN_OVERHEAD = 10_590;
const DRIFT_BYTES = 32;

function parseClearSize(label: string): { readonly lo: number; readonly hi: number } {
  const match = /^Clear (\d+(?:\.\d+)?) (B|KB|MB)$/.exec(label.trim());
  if (match === null) throw new Error(`Unexpected Client Storage button label: ${label}`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "B") return { lo: value, hi: value + 1 };
  const scale = unit === "MB" ? 1024 * 1024 : 1024;
  const halfStep = match[1]?.includes(".") ? 0.05 : 0.5;
  return { lo: (value - halfStep) * scale, hi: (value + halfStep) * scale };
}

test(
  'Client storage sizes just under 1 MB read "1.0 MB" instead of "1024 KB"',
  IOS,
  async ({ t3, app, screen, device }) => {
    const project = await t3.project("demo");
    const pad = await t3.thread({
      project,
      title: "Calibration",
      messages: ["seed"],
    });
    const { cli } = makeState(MOBILE_T3_HOME, { T3CODE_PORT: String(MOBILE.serverPort) });

    // Start from an empty cache so repeated local simulator runs match a fresh device.
    await app.clearState().catch(() => {});
    const [, bulk] = await Promise.all([
      t3.open(),
      t3.thread({
        project,
        title: "Bulk cache",
        messages: Array.from({ length: 4 }, (_, index) => `bulk-${index} ${"a".repeat(104_000)}`),
      }),
    ]);
    await screen.getByText("Bulk cache", { exact: false }).first().waitFor({ timeout: 120_000 });

    const environment = await runPromise(
      environmentId(`http://${MOBILE.host}:${MOBILE.serverPort}`),
    );
    const openLink = async (url: string) => {
      await device.openLink(url, { app: APP_ID });
    };
    const openThreadAndFlush = async (threadId: string, marker: string) => {
      await openLink(`${SCHEME}://threads/${environment}/${threadId}`);
      await screen.getByText(marker, { exact: false }).first().waitFor({ timeout: 60_000 });
      await screen.getByTestId("BackButton").tap();
      await screen.getByRole("tablist", "Tab Bar").waitFor({ timeout: 30_000 });
    };
    const readClientStorage = async () => {
      await openLink(`${SCHEME}://settings/client-storage`);
      const clearButton = screen.getByRole("button", /^Clear \d/);
      await clearButton.waitFor({ timeout: 30_000 });
      const label = (await clearButton.textContent()) ?? "";
      await screen.getByTestId("BackButton").tap();
      await screen.getByRole("tablist", "Tab Bar").waitFor({ timeout: 30_000 });
      return parseClearSize(label);
    };

    await openThreadAndFlush(bulk.threadId, "first fixture turn complete");
    await openThreadAndFlush(pad.threadId, "first fixture turn complete");
    let { lo, hi } = await readClientStorage();

    // Narrow the SQLite cache total to ±128 B via half-KB rounding steps, then land inside
    // [1,048,064, 1,048,575] where base renders "1024 KB" and head renders "1.0 MB".
    for (let step = 1; step <= 6; step += 1) {
      const width = hi - lo;
      const mid = (lo + hi) / 2;
      const done = width <= 320;
      const minNext = mid + TURN_OVERHEAD + 100;
      const nextHalfKb = Math.ceil((minNext - 512) / 1024) * 1024 + 512;
      const target = done ? TARGET_BYTES : Math.max(nextHalfKb, 980.5 * 1024);
      const padChars = Math.max(16, Math.round((target - mid - TURN_OVERHEAD) / BYTES_PER_CHAR));
      const expectedGrowth = TURN_OVERHEAD + padChars * BYTES_PER_CHAR;
      const tag = `pad-${step}`;
      const body = `${tag} ${"a".repeat(Math.max(1, padChars - tag.length - 1))}`;

      await runPromise(cli(["thread", "send", pad.threadId, body, "--wait", "--json"], [0, 2]));
      await openThreadAndFlush(pad.threadId, tag);
      if (done) break;

      const observed = await readClientStorage();
      const predLo = lo + expectedGrowth - DRIFT_BYTES;
      const predHi = hi + expectedGrowth + DRIFT_BYTES;
      if (Math.max(predLo, observed.lo) < Math.min(predHi, observed.hi)) {
        lo = Math.max(predLo, observed.lo);
        hi = Math.min(predHi, observed.hi);
      } else {
        lo = observed.lo;
        hi = observed.hi;
      }
    }

    await openLink(`${SCHEME}://settings/client-storage`);
    await screen.getByRole("button", /^Clear \d/).waitFor({ timeout: 30_000 });
    await app.screenshot("client-storage");
    await expect(screen.getByRole("button", "Clear 1.0 MB")).toBeVisible();
    await expect(screen.getByRole("button", /1024 KB/)).not.toBeVisible();
  },
);
