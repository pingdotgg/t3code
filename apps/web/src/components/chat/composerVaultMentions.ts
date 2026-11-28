import { vaultMentionLabel, type LocalVaultEntry } from "@t3tools/contracts";

export function matchVaultMentions(
  entries: ReadonlyArray<Pick<LocalVaultEntry, "name" | "title">>,
  query: string,
) {
  const needle = query.normalize("NFC").trim().toLowerCase();
  return entries
    .flatMap(({ name, title }) => {
      const label = vaultMentionLabel(title);
      const folded = label.toLowerCase();
      if (label === "" || !folded.includes(needle)) return [];
      return [
        {
          id: `vault-credential:${name}`,
          label,
          rank: folded === needle ? 0 : folded.startsWith(needle) ? 1 : 2,
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .slice(0, 6)
    .map(({ id, label }) => ({ id, label, type: "vault-credential" as const }));
}

export const formatVaultMention = (label: string) => `vault:${JSON.stringify(label)}`;
