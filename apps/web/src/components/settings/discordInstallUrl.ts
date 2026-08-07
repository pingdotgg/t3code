const DISCORD_CHANNEL_PERMISSIONS = "309237713920";

export function buildDiscordInstallUrl(applicationId: string, guildId: string): string | null {
  const clientId = applicationId.trim();
  if (!/^\d+$/.test(clientId)) return null;

  const searchParams = new URLSearchParams({
    client_id: clientId,
    integration_type: "0",
    permissions: DISCORD_CHANNEL_PERMISSIONS,
    scope: "bot applications.commands",
  });
  const serverId = guildId.trim();
  if (/^\d+$/.test(serverId)) searchParams.set("guild_id", serverId);

  return `https://discord.com/oauth2/authorize?${searchParams.toString()}`;
}
