import type * as AcpSchema from "effect-acp/compat";

// Captured from ACP 1.4.0 session/new with personal Google authentication.
export const antigravity140Session = {
  sessionId: "session-1",
  models: {
    currentModelId: "gemini-3.8-flash-high",
    availableModels: [
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-3.8-flash",
      options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
    },
    {
      id: "thinking_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
} satisfies AcpSchema.NewSessionResponse;
