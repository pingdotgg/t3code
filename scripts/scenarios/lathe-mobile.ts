// `test` for iOS scenarios: e2e's mobile test plus `lathe`, which seeds state like the web one and
// opens the dev client paired with the scenario's server.
import { test as base } from "@e2e-dev/mobile";
import * as HostProcess from "@lathe/shared/HostProcess";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { APP_DIR, MOBILE, MOBILE_LATHE_HOME } from "../e2e.config.ts";
import { run, ScenarioError } from "./shell.ts";
import { makeState, runPromise, type LatheState } from "./lathe.ts";

const APP_ID = "com.t3tools.t3code.dev";
const SCHEME = "t3code-dev";

export interface MobileLathe extends LatheState {
  /** Installs the dev client if the device lacks it, loads it from Metro, and pairs it. */
  readonly open: () => Promise<void>;
}

const decodePrepared = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ fingerprint: Schema.String })),
);

/** The dev client built for this checkout's native code, from the shared cache. */
const devClientPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const prepared = yield* run(
    yield* HostProcess.ExecutablePath,
    ["scripts/mobile-native-client.ts", "ensure", "ios", "--prepare"],
    { cwd: APP_DIR },
  );
  const { fingerprint } = yield* decodePrepared(prepared.stdout.trim().split("\n").at(-1) ?? "");
  return path.join(
    yield* HostProcess.HomeDirectory,
    ".cache/t3code/native-clients/artifacts/ios/development",
    fingerprint,
    "LatheDev.app",
  );
});

// A leased device is wiped when it returns to the pool, so one install and pairing last the run.
let installed = false;
let paired = false;

export const test = base.extend<{ lathe: MobileLathe }>({
  lathe: async ({ device, screen }, use) => {
    const { state, cli, cleanup } = makeState(MOBILE_LATHE_HOME, {
      LATHE_PORT: String(MOBILE.serverPort),
    });
    const pairingUrl = Effect.gen(function* () {
      const origin = `http://${MOBILE.host}:${MOBILE.serverPort}`;
      const pairing = ["auth", "pairing", "create", "--ttl", "15m", "--label", "scenario"];
      const created = yield* cli([...pairing, "--base-url", origin]);
      const url = /Pair URL:\s*(\S+)/.exec(`${created.stdout}\n${created.stderr}`)?.[1];
      return url ?? (yield* new ScenarioError({ message: "The server printed no pairing URL." }));
    });
    await use({
      ...state,
      open: async () => {
        if (!installed) {
          await device.installApp(await runPromise(devClientPath));
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
        const query = new URLSearchParams({
          pairingUrl: await runPromise(pairingUrl),
          autoConnect: "1",
        });
        await openLink(`${SCHEME}://connections/new?${query.toString()}`);
        paired = true;
      },
    });
    await runPromise(cleanup);
  },
});

/** Test option for an iOS scenario: the web target skips it, and no device is leased for it. */
export const IOS = { platforms: ["ios"] } as const;
