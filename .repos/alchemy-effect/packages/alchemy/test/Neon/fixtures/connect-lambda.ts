import { Function } from "@/AWS/Lambda/Function";
import { connectHandler } from "./connect-handler.ts";

export default class ConnectLambda extends Function<ConnectLambda>()(
  "ConnectLambda",
  { main: import.meta.url, functionUrl: true },
  connectHandler,
) {}
