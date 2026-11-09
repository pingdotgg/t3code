import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceConfig, ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);
const decodeInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const encodeInstanceConfig = Schema.encodeSync(ProviderInstanceConfig);

describe("ProviderInstanceConfig icon", () => {
  const icon = {
    viewBox: "0 0 24 24",
    fill: { light: "#1c1c1c", dark: "#f5f5f5" },
    paths: [{ d: "M12 2 22 22 2 22Z", fillRule: "evenodd" }],
  };
  const instance = { driver: "pi", displayName: "Aside Code", accentColor: "#ff8800" };

  it("decodes a vector icon and round-trips it on encode", () => {
    const decoded = decodeInstanceConfig({ ...instance, icon });
    expect(decoded.icon).toEqual(icon);
    expect(encodeInstanceConfig(decoded)).toEqual({ ...instance, icon });
  });

  it.each([
    ["url() fill", { ...icon, fill: { ...icon.fill, light: "url(https://evil/x.svg#a)" } }],
    ["named fill", { ...icon, fill: { ...icon.fill, dark: "red" } }],
    ["three-number viewBox", { ...icon, viewBox: "0 0 24" }],
    ["markup in a path", { ...icon, paths: [{ d: "M0 0<script>" }] }],
    ["url() in a path", { ...icon, paths: [{ d: "url(#a)" }] }],
    ["no paths", { ...icon, paths: [] }],
    ["nine paths", { ...icon, paths: Array.from({ length: 9 }, () => ({ d: "M0 0Z" })) }],
    ["oversized path", { ...icon, paths: [{ d: "M0 0Z".padEnd(4097, "0") }] }],
  ])("drops an invalid icon (%s) and keeps the rest of the instance", (_label, invalid) => {
    expect(decodeInstanceConfig({ ...instance, icon: invalid })).toEqual(instance);
  });
});

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });
});
