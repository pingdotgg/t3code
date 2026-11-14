import * as Layer from "effect/Layer";
import { ConnectRead } from "./Connect.ts";
import {
  DAX_PROTOCOL_ACTIONS,
  DAX_READ_ACTIONS,
  makeDaxConnectHttpBinding,
} from "./ConnectHttp.ts";

export const ConnectReadHttp = Layer.effect(
  ConnectRead,
  makeDaxConnectHttpBinding({
    tag: "AWS.DAX.ConnectRead",
    actions: [...DAX_PROTOCOL_ACTIONS, ...DAX_READ_ACTIONS],
  }),
);
