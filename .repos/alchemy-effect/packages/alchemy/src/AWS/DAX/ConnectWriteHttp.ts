import * as Layer from "effect/Layer";
import { ConnectWrite } from "./Connect.ts";
import {
  DAX_PROTOCOL_ACTIONS,
  DAX_WRITE_ACTIONS,
  makeDaxConnectHttpBinding,
} from "./ConnectHttp.ts";

export const ConnectWriteHttp = Layer.effect(
  ConnectWrite,
  makeDaxConnectHttpBinding({
    tag: "AWS.DAX.ConnectWrite",
    actions: [...DAX_PROTOCOL_ACTIONS, ...DAX_WRITE_ACTIONS],
  }),
);
