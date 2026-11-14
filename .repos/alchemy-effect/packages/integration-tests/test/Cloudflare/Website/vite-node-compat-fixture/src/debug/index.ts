import debug from "debug";

export default {
  async fetch() {
    return testDebug();
  },
} satisfies ExportedHandler;

function testDebug() {
  const capturedLogs: string[] = [];

  // Override debug.log to capture output for verification
  debug.log = (...args: string[]) => {
    capturedLogs.push(args.join(" "));
  };

  // Test different namespaces based on DEBUG env var: "example:*,test"
  const testNamespace = debug("test"); // Should log (matches "test")
  const exampleNamespace = debug("example"); // Should NOT log (doesn't match "example:*")
  const exampleFooNamespace = debug("example:foo"); // Should log (matches "example:*")

  testNamespace("Test import message 1");
  exampleNamespace("Example import message (should not appear)");
  exampleFooNamespace("Example foo import message");

  if (testNamespace.enabled) {
    testNamespace("Test import enabled message");
  }

  // Strip timestamps from captured logs, keeping namespace and message
  // Format: "2025-08-14T20:09:49.769Z test Test import message 1"
  const logsWithoutTimestamp = capturedLogs.map((log) => {
    const parts = log.split(" ");
    return parts.slice(1).join(" "); // Remove timestamp, keep namespace + message
  });

  return Response.json(logsWithoutTimestamp);
}
