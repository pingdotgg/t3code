import { createOxlintRuleHarness } from "../test/utils.ts";
const state = createOxlintRuleHarness("t3code/no-rpc-permission-bypass", {
  filename: "packages/client-runtime/src/state/example.ts",
});
state.invalid("blocks direct session calls", "session.client[tag](input);");
state.invalid("blocks extracting the raw client", 'const raw = session["client"];');
state.invalid(
  "blocks replacing the permission guard",
  'import { RpcPermissionGuard as Guard } from "../rpc/client.ts";',
);
state.invalid(
  "blocks namespace guard access",
  'import * as Rpc from "../rpc/client.ts"; const guard = Rpc.RpcPermissionGuard;',
);
state.invalid("blocks raw protocol imports", 'import { makeClient } from "../rpc/protocol.ts";');
state.valid(
  "allows typed requests",
  'import { request } from "../rpc/client.ts"; request(method, input);',
);
const rpc = createOxlintRuleHarness("t3code/no-rpc-permission-bypass", {
  filename: "packages/client-runtime/src/rpc/client.ts",
});
rpc.valid("allows the transport boundary", "session.client[tag](input);");

const app = createOxlintRuleHarness("t3code/no-rpc-permission-bypass", {
  filename: "apps/web/src/example.ts",
});
app.invalid(
  "blocks guard imports through the barrel",
  'import { RpcPermissionGuard as Guard } from "@t3tools/client-runtime/rpc";',
);
app.invalid(
  "blocks explicit index imports",
  'import { RpcPermissionGuard } from "@t3tools/client-runtime/rpc/index.ts";',
);
app.invalid(
  "blocks raw session access in subscription callbacks",
  "subscribeDynamic(tag, session => session.client[method](input));",
);
app.invalid(
  "blocks raw client destructuring",
  "const { client: raw } = session; raw[method](input);",
);
app.valid(
  "allows public typed RPC helpers",
  'import { request, runStream } from "@t3tools/client-runtime/rpc";',
);
