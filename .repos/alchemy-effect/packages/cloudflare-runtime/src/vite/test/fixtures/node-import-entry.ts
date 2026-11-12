import { readFileSync } from "node:fs";

export default { fetch: () => new Response(String(typeof readFileSync)) };
