import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withOrchestrationProtocolHeader } from "./environmentHttpAuth.ts";

describe("orchestration HTTP compatibility header", () => {
  it("announces the current protocol without replacing bearer or DPoP authentication", () => {
    expect(
      withOrchestrationProtocolHeader({
        authorization: "DPoP access-token",
        dpop: "signed-proof",
      }),
    ).toEqual({
      authorization: "DPoP access-token",
      dpop: "signed-proof",
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    });
  });
});
