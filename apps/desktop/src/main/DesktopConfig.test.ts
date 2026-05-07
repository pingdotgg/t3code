import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "./DesktopConfig.ts";

describe("DesktopConfig", () => {
  it.effect("loads typed desktop config from the effect ConfigProvider", () =>
    Effect.gen(function* () {
      const config = yield* DesktopConfig.DesktopConfig;

      assert.deepEqual(config.home, Option.some("/Users/alice"));
      assert.deepEqual(config.t3Home, Option.some("/tmp/t3"));
      assert.deepEqual(
        Option.map(config.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(config.configuredBackendPort, Option.some(4949));
      assert.deepEqual(config.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(config.desktopLanHostOverride, Option.some("192.168.1.50"));
      assert.deepEqual(config.desktopHttpsEndpointUrls, [
        "https://t3.example.test",
        "https://tailnet.example.test",
      ]);
      assert.equal(config.disableAutoUpdate, true);
      assert.deepEqual(config.desktopUpdateGithubToken, Option.some("desktop-token"));
      assert.equal(config.mockUpdates, true);
      assert.equal(config.mockUpdateServerPort, 4141);
    }).pipe(
      Effect.provide(
        DesktopConfig.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  HOME: " /Users/alice ",
                  T3CODE_HOME: " /tmp/t3 ",
                  VITE_DEV_SERVER_URL: "http://localhost:5173",
                  T3CODE_PORT: "4949",
                  T3CODE_COMMIT_HASH: " 0123456789abcdef ",
                  T3CODE_DESKTOP_LAN_HOST: " 192.168.1.50 ",
                  T3CODE_DESKTOP_HTTPS_ENDPOINTS:
                    " https://t3.example.test, https://tailnet.example.test ",
                  T3CODE_DISABLE_AUTO_UPDATE: "1",
                  T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN: " desktop-token ",
                  GH_TOKEN: "ignored-token",
                  T3CODE_DESKTOP_MOCK_UPDATES: "true",
                  T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
