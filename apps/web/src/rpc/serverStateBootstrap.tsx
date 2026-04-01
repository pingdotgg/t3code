import { useEffect } from "react";

import { getWsRpcClient } from "../wsRpcClient";
import { startServerStateSync } from "./serverState";

export function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getWsRpcClient().server), []);

  return null;
}
