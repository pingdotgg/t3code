export const composerPreviewAnnotationResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inserted", "imageInserted", "screenshotFailed", "target"],
  properties: {
    inserted: { type: "boolean" },
    imageInserted: { type: "boolean" },
    screenshotFailed: { type: "boolean" },
    target: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

export const browserMiniPlayerStateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tabId"],
  properties: { tabId: { type: ["string", "null"], minLength: 1, maxLength: 128 } },
} as const;

export const browserMiniPlayerInputProperties = {
  tabId: { type: "string", minLength: 1, maxLength: 128 },
  serverEpoch: { type: "string", minLength: 1, maxLength: 128 },
  open: { type: "boolean" },
} as const;
