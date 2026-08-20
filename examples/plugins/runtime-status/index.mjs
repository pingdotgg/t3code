export default function activate(api) {
  api.registerCommand(
    {
      id: "example.runtime-status",
      label: "external runtime status",
      description: "report status from an external local plugin package.",
      surfaces: ["web", "desktop", "mobile"],
    },
    () => ({
      message: "external plugin runtime is active.",
      tone: "success",
    }),
  );
}
