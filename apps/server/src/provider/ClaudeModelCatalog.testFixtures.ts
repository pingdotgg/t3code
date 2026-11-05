import type { ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";

// Transport tests must stay independent of bundled or remote manifest contents.
// Keep every model, alias, capability, and runtime mapping in this fixture synthetic.
export const SYNTHETIC_CLAUDE_CAPABLE_MODEL = "claude-synthetic-capable";
export const SYNTHETIC_CLAUDE_COLLIDING_ALIAS = "synthetic-collision";
export const SYNTHETIC_CLAUDE_STANDARD_MODEL = "claude-synthetic-standard";
export const SYNTHETIC_CLAUDE_THINKING_MODEL = "claude-synthetic-thinking";

const effort = {
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};

const contextWindow = {
  id: "contextWindow",
  label: "Context Window",
  type: "select" as const,
  options: [
    { id: "standard", label: "Standard" },
    { id: "expanded", label: "Expanded", isDefault: true },
  ],
};

const runtime = {
  effortMap: { ultrathink: null },
  modelSuffixes: { contextWindow: { expanded: "[expanded]" } },
  contextWindowTokens: { standard: 200_000, expanded: 1_000_000 },
};

export const SYNTHETIC_CLAUDE_MODEL_CATALOG: ClaudeModelCatalog = {
  models: [
    {
      model: {
        slug: SYNTHETIC_CLAUDE_CAPABLE_MODEL,
        name: "Claude Synthetic Capable",
        aliases: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS],
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            effort,
            { id: "fastMode", label: "Fast Mode", type: "boolean" },
            contextWindow,
          ],
        },
      },
      runtime,
      compatibility: {},
    },
    {
      model: {
        slug: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        name: "Claude Synthetic Standard",
        isCustom: false,
        capabilities: {
          optionDescriptors: [effort, contextWindow],
        },
      },
      runtime,
      compatibility: {},
    },
    {
      model: {
        slug: SYNTHETIC_CLAUDE_THINKING_MODEL,
        name: "Claude Synthetic Thinking",
        isCustom: false,
        capabilities: {
          optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
        },
      },
      runtime: {},
      compatibility: {},
    },
  ],
};

/** An opaque third-party ID, with options explicitly declared by its owner. */
export const SYNTHETIC_CLAUDE_CUSTOM_MODEL = {
  slug: "third-party-synthetic",
  name: "Third-party Synthetic",
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select" as const,
        options: [
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
          { id: "ultracode", label: "Ultracode" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        // Deliberately omit promptInjectedValues to cover older authored settings.
      },
    ],
  },
};

export const SYNTHETIC_CLAUDE_CUSTOM_PROMPT_DEFAULT = {
  ...SYNTHETIC_CLAUDE_CUSTOM_MODEL,
  capabilities: {
    optionDescriptors: SYNTHETIC_CLAUDE_CUSTOM_MODEL.capabilities.optionDescriptors.map(
      (descriptor) => ({
        ...descriptor,
        currentValue: "ultrathink",
        options: descriptor.options.map((option) => ({
          ...option,
          isDefault: option.id === "ultrathink",
        })),
      }),
    ),
  },
};
