import type { AuthConnectDevice } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { unseenConnectDevices } from "./connectDeviceNotices.ts";

const device = (proofKeyThumbprint: string, approvedAt: number): AuthConnectDevice => ({
  proofKeyThumbprint,
  verificationCode: "ABCD-EFGH",
  approvedAt: DateTime.makeUnsafe(approvedAt),
});

describe("unseenConnectDevices", () => {
  it("starts a new client at the newest key, then reports keys that arrive later", () => {
    const own = device("own", 1_000);
    const first = unseenConnectDevices([own], undefined);
    expect(first).toEqual({ unseen: [], newest: 1_000 });

    const stranger = device("stranger", 2_000);
    expect(unseenConnectDevices([own, stranger], first.newest)).toEqual({
      unseen: [stranger],
      newest: 2_000,
    });
  });

  it("reports the first key on a host that had none when this client looked", () => {
    const empty = unseenConnectDevices([], undefined);
    const stranger = device("stranger", 2_000);
    expect(unseenConnectDevices([stranger], empty.newest).unseen).toEqual([stranger]);
  });
});
