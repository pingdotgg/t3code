import type { ServerExtension } from "@t3tools/extension-sdk/environment";

// No server logic: the host serves `t3.browser/profiles` directly.
export default { tools: [], apis: [] } satisfies ServerExtension;
