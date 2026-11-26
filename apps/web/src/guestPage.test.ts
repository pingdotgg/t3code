import { describe, expect, it } from "vite-plus/test";

import { isGuestPage, normalizeRoutePathname } from "./guestPage";

describe("guestPage", () => {
  it("normalizes trailing slashes without collapsing root", () => {
    expect(normalizeRoutePathname("/")).toBe("/");
    expect(normalizeRoutePathname("///")).toBe("/");
    expect(normalizeRoutePathname("/guest")).toBe("/guest");
    expect(normalizeRoutePathname("/guest/")).toBe("/guest");
    expect(normalizeRoutePathname("/guest///")).toBe("/guest");
    expect(normalizeRoutePathname("/pair/")).toBe("/pair");
    expect(normalizeRoutePathname("/connect/")).toBe("/connect");
    expect(normalizeRoutePathname("/connect-agent/")).toBe("/connect-agent");
    expect(normalizeRoutePathname("/approve-agent/")).toBe("/approve-agent");
  });

  it("treats /guest and trailing-slash variants as guest pages", () => {
    expect(isGuestPage("/guest")).toBe(true);
    expect(isGuestPage("/guest/")).toBe(true);
    expect(isGuestPage("/guest///")).toBe(true);
    expect(isGuestPage("/guest/thread")).toBe(false);
    expect(isGuestPage("/")).toBe(false);
    expect(isGuestPage("/pair")).toBe(false);
  });
});
