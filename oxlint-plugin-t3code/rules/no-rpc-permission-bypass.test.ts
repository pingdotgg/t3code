import { createOxlintRuleHarness } from "../test/utils.ts";
const state = createOxlintRuleHarness("t3code/no-rpc-permission-bypass", {
  filename: "fixture.ts",
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
  filename: "fixture.ts",
  ruleOptions: [{ allowRawClientAccess: true }],
});
rpc.valid("allows the transport boundary", "session.client[tag](input);");

const app = createOxlintRuleHarness("t3code/no-rpc-permission-bypass", {
  filename: "fixture.ts",
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

rpc.invalid(
  "raw client allowance does not permit installing the guard",
  'import { RpcPermissionGuard } from "@t3tools/client-runtime/rpc";',
);
const boundary = createOxlintRuleHarness("t3code/no-rpc-permission-bypass", {
  filename: "fixture.ts",
  ruleOptions: [{ allowGuardInstallation: true }],
});
boundary.valid(
  "permits guard installation when configured",
  'import { RpcPermissionGuard } from "@t3tools/client-runtime/rpc"; RpcPermissionGuard.of({ authorize });',
);
boundary.invalid(
  "guard installation allowance does not permit raw clients",
  "session.client[tag](input);",
);
boundary.invalid(
  "guard installation allowance does not permit raw protocol imports",
  'import { makeWsRpcProtocolClient } from "../rpc/protocol.ts";',
);
