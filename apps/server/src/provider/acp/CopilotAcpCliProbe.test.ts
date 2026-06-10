/**
 * Optional integration check against a real `copilot --acp` install.
 * Enable with: HERMES_COPILOT_ACP_PROBE=1 bun run test --filter CopilotAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import {
  COPILOT_AUTH_METHOD_ID,
  COPILOT_CLIENT_CAPABILITIES,
  COPILOT_CLIENT_INFO,
  buildCopilotAcpSpawnInput,
} from "./CopilotAcpSupport.ts";

describe.runIf(
  process.env.HERMES_COPILOT_ACP_PROBE === "1" || process.env.T3_COPILOT_ACP_PROBE === "1",
)("Copilot ACP CLI probe", () => {
  it.effect("reports config options for the default client capabilities", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      console.log(
        "copilot default session/new:",
        JSON.stringify(
          {
            sessionId: started.sessionId,
            modelConfigId: started.modelConfigId,
            configOptions: started.sessionSetupResult.configOptions ?? null,
          },
          null,
          2,
        ),
      );

      const setResult = yield* runtime.setConfigOption(started.modelConfigId ?? "model", "gpt-5.4");
      console.log(
        "copilot default set model:",
        JSON.stringify(setResult.configOptions ?? null, null, 2),
      );

      expect(typeof started.sessionId).toBe("string");
      expect(Array.isArray(started.sessionSetupResult.configOptions)).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: buildCopilotAcpSpawnInput(undefined, process.cwd(), "approval-required"),
          cwd: process.cwd(),
          auth: {
            methodId: COPILOT_AUTH_METHOD_ID,
            required: true,
          },
          clientCapabilities: COPILOT_CLIENT_CAPABILITIES,
          clientInfo: COPILOT_CLIENT_INFO,
          modeSwitchMethod: "set_mode",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports config options when parameterized model picker metadata is enabled", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      console.log(
        "copilot parameterized session/new:",
        JSON.stringify(
          {
            sessionId: started.sessionId,
            modelConfigId: started.modelConfigId,
            configOptions: started.sessionSetupResult.configOptions ?? null,
          },
          null,
          2,
        ),
      );

      const setResult = yield* runtime.setConfigOption(started.modelConfigId ?? "model", "gpt-5.4");
      console.log(
        "copilot parameterized set model:",
        JSON.stringify(setResult.configOptions ?? null, null, 2),
      );

      expect(typeof started.sessionId).toBe("string");
      expect(Array.isArray(started.sessionSetupResult.configOptions)).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: buildCopilotAcpSpawnInput(undefined, process.cwd(), "approval-required"),
          cwd: process.cwd(),
          auth: {
            methodId: COPILOT_AUTH_METHOD_ID,
            required: true,
          },
          clientCapabilities: {
            ...COPILOT_CLIENT_CAPABILITIES,
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: COPILOT_CLIENT_INFO,
          modeSwitchMethod: "set_mode",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
