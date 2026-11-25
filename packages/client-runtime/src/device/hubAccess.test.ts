import { afterEach, assert, describe, it, vi } from "@effect/vitest";

import { openDeviceHubSocket, type DeviceHubAccess } from "./hubAccess.ts";

const access: DeviceHubAccess = {
  httpBase: "https://env.test/api/device-hub",
  wsBase: "wss://env.test/api/device-hub",
  query: { wsTicket: "ticket" },
  credentials: false,
};

describe("openDeviceHubSocket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds a signed proof only to the socket path it was signed for", () => {
    const WebSocketStub = vi.fn(function () {});
    vi.stubGlobal("WebSocket", WebSocketStub);
    const signed = {
      ...access,
      socketProofs: { "/api/device-hub/vendor/serve-sim/helper/ws": "proof" },
    };
    openDeviceHubSocket(signed, `${access.wsBase}/vendor/serve-sim/helper/ws?wsTicket=ticket`);
    openDeviceHubSocket(signed, `${access.wsBase}/vendor/serve-emu/ws?wsTicket=ticket`);
    openDeviceHubSocket(access, `${access.wsBase}/vendor/serve-emu/ws?wsTicket=ticket`);
    assert.deepStrictEqual(WebSocketStub.mock.calls.flat(), [
      `${access.wsBase}/vendor/serve-sim/helper/ws?wsTicket=ticket&dpop=proof`,
      `${access.wsBase}/vendor/serve-emu/ws?wsTicket=ticket`,
      `${access.wsBase}/vendor/serve-emu/ws?wsTicket=ticket`,
    ]);
  });

  it("hands the socket to the opener when the access has one", () => {
    const opened: Array<string> = [];
    const socket = {} as WebSocket;
    const result = openDeviceHubSocket(
      {
        ...access,
        openSocket: (url) => {
          opened.push(url);
          return socket;
        },
      },
      `${access.wsBase}/vendor/serve-emu/ws`,
    );
    assert.strictEqual(result, socket);
    assert.deepStrictEqual(opened, [`${access.wsBase}/vendor/serve-emu/ws`]);
  });
});
