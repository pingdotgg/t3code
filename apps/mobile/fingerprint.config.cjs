// These Swift sources are copied by a dangerous config mod, so Expo's config
// loader cannot discover them. Include them in native-client and OTA compatibility.
module.exports = {
  extraSources: [
    "plugins/withAgentWidgetRefresh.cjs",
    "plugins/widget/AgentWidgetTimelineProvider.swift",
    "plugins/widget/AgentWidgetState.swift",
  ].map((filePath) => ({ type: "file", filePath, reasons: ["agentWidgetRefresh"] })),
};
