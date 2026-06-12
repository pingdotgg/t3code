import { config } from "dotenv";
config({ path: ".env", quiet: true });

// Polyfill File constructor for Node.js if not available
if (typeof globalThis.File === "undefined") {
  const { File } = require("node:buffer");
  globalThis.File = File;
}
