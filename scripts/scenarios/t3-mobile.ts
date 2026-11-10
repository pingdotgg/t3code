// @effect-diagnostics nodeBuiltinImport:off
// `test` for iOS scenarios: e2e's mobile test plus `t3`, which seeds state like the web one and
// opens the dev client paired with the scenario's server.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { test as base } from "@e2e-dev/mobile";
import { expect } from "e2e";

import { APP_DIR, MOBILE, MOBILE_T3_HOME } from "../e2e.config.ts";
import { makeState, type T3State } from "./t3.ts";

const APP_ID = "com.t3tools.t3code.dev";
const SCHEME = "t3code-dev";

export interface MobileT3 extends T3State {
  /** Installs the dev client if the device lacks it, loads it from Metro, and pairs it. */
  readonly open: () => Promise<void>;
}

/** The dev client built for this checkout's native code, from the shared cache. */
function devClientPath(): string {
  const stdout = NodeChildProcess.execFileSync(
    process.execPath,
    ["scripts/mobile-native-client.ts", "ensure", "ios", "--prepare"],
    { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const { fingerprint } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
    fingerprint?: string;
  };
  if (fingerprint === undefined) throw new Error("mobile-native-client printed no fingerprint");
  return NodePath.join(
    NodeOS.homedir(),
    ".cache/t3code/native-clients/artifacts/ios/development",
    fingerprint,
    "T3CodeDev.app",
  );
}

// A leased device is wiped when it returns to the pool, so one install and pairing last the run.
let installed = false;
let paired = false;

export const test = base.extend<{ t3: MobileT3 }>({
  t3: async ({ device, screen }, use) => {
    const { state, cli, cleanup } = makeState(MOBILE_T3_HOME, {
      T3CODE_PORT: String(MOBILE.serverPort),
    });
    await use({
      ...state,
      open: async () => {
        if (!installed) {
          await device.installApp(devClientPath());
          installed = true;
        }
        // iOS asks before a link opens another app.
        const openLink = async (url: string) => {
          await device.openLink(url, { app: APP_ID });
          await device.alert("accept").catch(() => {});
        };
        const metro = encodeURIComponent(`http://${MOBILE.host}:${MOBILE.metroPort}`);
        await openLink(
          `${SCHEME}://expo-development-client/?url=${metro}&disableOnboarding=1&disableFab=1&disableAutoLaunch=1`,
        );
        // The first load bundles the app; the pairing link only works once it is on screen.
        if (paired) return;
        await expect(screen.getByRole("button", "Add environment")).toBeVisible({
          timeout: 240_000,
        });
        const origin = `http://${MOBILE.host}:${MOBILE.serverPort}`;
        const pairing = ["auth", "pairing", "create", "--ttl", "15m", "--label", "scenario"];
        const created = await cli([...pairing, "--base-url", origin]);
        const pairingUrl = /Pair URL:\s*(\S+)/.exec(`${created.stdout}\n${created.stderr}`)?.[1];
        if (pairingUrl === undefined) throw new Error("The server printed no pairing URL");
        const query = new URLSearchParams({ pairingUrl, autoConnect: "1" });
        await openLink(`${SCHEME}://connections/new?${query.toString()}`);
        paired = true;
      },
    });
    await cleanup();
  },
});

/** Test option for an iOS scenario: the web target skips it, and no device is leased for it. */
export const IOS = { platforms: ["ios"] } as const;
