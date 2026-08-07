import { describe, expect, it } from "vite-plus/test";

import { buildDiscordInstallUrl } from "./discordInstallUrl";

describe("buildDiscordInstallUrl", () => {
  it("requests only the scopes and permissions needed by the Discord channel", () => {
    const result = buildDiscordInstallUrl("1535085613399933028", "");
    expect(result).not.toBeNull();

    const url = new URL(result!);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1535085613399933028",
      integration_type: "0",
      permissions: "309237713920",
      scope: "bot applications.commands",
    });
  });

  it("prefills a valid server ID and rejects an invalid application ID", () => {
    const result = buildDiscordInstallUrl(" 1535085613399933028 ", " 123456789012345678 ");
    expect(new URL(result!).searchParams.get("guild_id")).toBe("123456789012345678");
    expect(buildDiscordInstallUrl("not-an-id", "123456789012345678")).toBeNull();
  });
});
