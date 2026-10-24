import { describe, expect, it } from "vite-plus/test";

import { environmentReconnectActionLabel } from "./environmentReconnectAction";

describe("environmentReconnectActionLabel", () => {
  it("offers Retry now while an environment is waiting to reconnect", () => {
    expect(environmentReconnectActionLabel("reconnecting")).toBe("Retry now");
  });

  it("leaves the first connecting attempt alone", () => {
    expect(environmentReconnectActionLabel("connecting")).toBeNull();
  });

  it("keeps Reconnect for unavailable phases that are not already retrying", () => {
    expect(environmentReconnectActionLabel("offline")).toBe("Reconnect");
    expect(environmentReconnectActionLabel("error")).toBe("Reconnect");
    expect(environmentReconnectActionLabel("available")).toBe("Reconnect");
    expect(environmentReconnectActionLabel("unsupported")).toBe("Reconnect");
  });

  it("offers nothing once the environment is connected", () => {
    expect(environmentReconnectActionLabel("connected")).toBeNull();
  });
});
