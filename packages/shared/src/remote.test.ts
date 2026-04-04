import { describe, expect, it } from "vitest";

import {
  buildAuthorizedRemoteUrl,
  buildRemoteAppConnectionUrl,
  parseRemoteAppConnectionUrl,
} from "./remote";

describe("buildAuthorizedRemoteUrl", () => {
  it("appends the auth token to a remote url", () => {
    expect(
      buildAuthorizedRemoteUrl({
        url: "http://192.168.1.42:3773/",
        token: "secret-token",
      }),
    ).toBe("http://192.168.1.42:3773/?token=secret-token");
  });

  it("preserves existing query params when adding the token", () => {
    expect(
      buildAuthorizedRemoteUrl({
        url: "https://tailnet.example.ts.net:3773/?view=mobile",
        token: "secret-token",
      }),
    ).toBe("https://tailnet.example.ts.net:3773/?view=mobile&token=secret-token");
  });

  it("removes an existing token query when no token is provided", () => {
    expect(
      buildAuthorizedRemoteUrl({
        url: "http://127.0.0.1:3773/?token=old-token&view=mobile",
        token: "   ",
      }),
    ).toBe("http://127.0.0.1:3773/?view=mobile");
  });
});

describe("buildRemoteAppConnectionUrl", () => {
  it("creates a t3remote deep link with server and auth token", () => {
    expect(
      buildRemoteAppConnectionUrl({
        serverUrl: "http://192.168.1.42:3773/",
        authToken: "secret-token",
      }),
    ).toBe(
      "t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773%2F&authToken=secret-token",
    );
  });

  it("omits the auth token when empty", () => {
    expect(
      buildRemoteAppConnectionUrl({
        serverUrl: "https://tailnet.example.ts.net:3773",
        authToken: " ",
      }),
    ).toBe("t3remote://connect?serverUrl=https%3A%2F%2Ftailnet.example.ts.net%3A3773");
  });

  it("uses the Expo dev scheme when requested", () => {
    expect(
      buildRemoteAppConnectionUrl({
        serverUrl: "http://192.168.1.42:3773/",
        authToken: "secret-token",
        useExpoDevScheme: true,
      }),
    ).toBe(
      "exp+t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773%2F&authToken=secret-token",
    );
  });
});

describe("parseRemoteAppConnectionUrl", () => {
  it("parses a valid deep link", () => {
    expect(
      parseRemoteAppConnectionUrl(
        "t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773%2F&authToken=secret-token",
      ),
    ).toEqual({
      serverUrl: "http://192.168.1.42:3773/",
      authToken: "secret-token",
    });
  });

  it("parses a valid Expo dev deep link", () => {
    expect(
      parseRemoteAppConnectionUrl(
        "exp+t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773%2F&authToken=secret-token",
      ),
    ).toEqual({
      serverUrl: "http://192.168.1.42:3773/",
      authToken: "secret-token",
    });
  });

  it("returns null for non-connection links", () => {
    expect(parseRemoteAppConnectionUrl("t3remote://other?serverUrl=http://127.0.0.1:3773")).toBe(
      null,
    );
    expect(parseRemoteAppConnectionUrl("https://example.com")).toBe(null);
  });

  it("returns authToken: null when the param is absent", () => {
    expect(
      parseRemoteAppConnectionUrl(
        "t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773%2F",
      ),
    ).toEqual({
      serverUrl: "http://192.168.1.42:3773/",
      authToken: null,
    });
  });

  it("returns authToken: null when the param is blank", () => {
    expect(
      parseRemoteAppConnectionUrl(
        "t3remote://connect?serverUrl=http%3A%2F%2F192.168.1.42%3A3773%2F&authToken=   ",
      ),
    ).toEqual({
      serverUrl: "http://192.168.1.42:3773/",
      authToken: null,
    });
  });

  it("returns null when serverUrl is missing", () => {
    expect(parseRemoteAppConnectionUrl("t3remote://connect?authToken=secret")).toBe(null);
  });
});
