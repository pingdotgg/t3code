import { z } from "zod";

export const environmentTiersSchema = z.union([z.literal(2), z.literal(3)]);

export type EnvironmentTiers = z.infer<typeof environmentTiersSchema>;

export type ProjectEnvironmentTiersParseResult =
  | { ok: true; tiers: EnvironmentTiers }
  | { ok: false; reason: "missing" | "invalid"; raw?: string };

export const parseEnvironmentTiers = (markdown: string): ProjectEnvironmentTiersParseResult => {
  const match = /^\s*-\s+\*\*Environment tiers\*\*:\s*(.+)$/m.exec(markdown);
  const raw = match?.[1]?.trim();

  if (raw === undefined || raw === "") {
    return { ok: false, reason: "missing" };
  }

  const numeric = Number.parseInt(raw, 10);
  const parsed = environmentTiersSchema.safeParse(numeric);

  if (!parsed.success) {
    return { ok: false, reason: "invalid", raw };
  }

  return { ok: true, tiers: parsed.data };
};
