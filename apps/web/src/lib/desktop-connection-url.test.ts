import { describe, expect, it } from "vitest";

import type { DesktopConnectionSettings } from "@t3tools/contracts";

import {
  buildDesktopConnectionUrlValue,
  resolveDesktopConnectionSettingsFromUrl,
} from "./desktop-connection-url";

const REMOTE_SETTINGS: DesktopConnectionSettings = {
  mode: "remote",
  remoteUrl: "http://100.64.0.10:3773/",
  remoteAuthToken: "abc123",
};

describe("desktop-connection-url", () => {
  it("builds a single remembered connection url from remote settings", () => {
    expect(buildDesktopConnectionUrlValue(REMOTE_SETTINGS)).toBe(
      "http://100.64.0.10:3773/?token=abc123",
    );
  });

  it("shows a blank field in local mode", () => {
    expect(
      buildDesktopConnectionUrlValue({
        ...REMOTE_SETTINGS,
        mode: "local",
      }),
    ).toBe("");
  });

  it("parses a pasted remote connection url into saved settings", () => {
    expect(
      resolveDesktopConnectionSettingsFromUrl(
        {
          mode: "local",
          remoteUrl: "",
          remoteAuthToken: "",
        },
        "http://100.64.0.10:3773/?token=abc123",
      ),
    ).toEqual(REMOTE_SETTINGS);
  });

  it("accepts websocket urls and normalizes them back to http transport", () => {
    expect(
      resolveDesktopConnectionSettingsFromUrl(
        {
          mode: "local",
          remoteUrl: "",
          remoteAuthToken: "",
        },
        "ws://100.64.0.10:3773/?token=abc123",
      ),
    ).toEqual(REMOTE_SETTINGS);
  });

  it("treats an empty field as local mode", () => {
    expect(resolveDesktopConnectionSettingsFromUrl(REMOTE_SETTINGS, "   ")).toEqual({
      ...REMOTE_SETTINGS,
      mode: "local",
    });
  });

  it("accepts pasted urls without a token", () => {
    expect(
      resolveDesktopConnectionSettingsFromUrl(
        {
          mode: "local",
          remoteUrl: "",
          remoteAuthToken: "",
        },
        "http://100.64.0.10:3773/",
      ),
    ).toEqual({
      mode: "remote",
      remoteUrl: "http://100.64.0.10:3773/",
      remoteAuthToken: "",
    });
  });
});
