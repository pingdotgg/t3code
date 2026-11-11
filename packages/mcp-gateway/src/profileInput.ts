import { AGENT_ICON_IDS, type AgentIconId } from "@t3tools/shared/agentIcons";
import { z } from "zod";

export const profileFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(280).optional(),
  providerLabel: z.string().trim().min(1),
  modelLabel: z.string().trim().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z
    .enum(["orb", "bot", "code", "pen", "search", "shield", "sparkles", "terminal"])
    .optional()
    .describe("Legacy icon older T3 builds show. Set from iconId when omitted."),
  iconId: z
    .enum(AGENT_ICON_IDS as [AgentIconId, ...AgentIconId[]])
    .optional()
    .describe("The agent's icon."),
  tags: z
    .array(z.string().trim().min(1).max(32))
    .max(8)
    .optional()
    .describe(
      "Role tags such as Dev, Product, Research, Social, Ops or Art; an agent may have several. Organizes the Agents board only.",
    ),
  skillIds: z.array(z.string().trim().min(1)).optional(),
  systemPrompt: z.string().max(32_000).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
  runtimeMode: z.enum([
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
    "read-only",
  ]),
  interactionMode: z.enum(["default", "plan"]),
  environmentIds: z.array(z.string().trim().min(1)).optional(),
};
