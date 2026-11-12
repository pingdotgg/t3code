import * as https from "node:https";

export default {
  async fetch() {
    // This will throw a 'not implemented' error if the compatibility_date is earlier than '2025-08-15' and the 'enable_nodejs_http_modules' compatibility_flag is not present
    const req = https.request({});
    req.end();

    return new Response("OK");
  },
} satisfies ExportedHandler;
