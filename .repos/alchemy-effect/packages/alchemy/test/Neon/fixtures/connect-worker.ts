import { Worker } from "@/Cloudflare/Workers/Worker";
import { connectHandler } from "./connect-handler.ts";

export default class ConnectWorker extends Worker<ConnectWorker>()(
  "ConnectWorker",
  { main: import.meta.url },
  connectHandler,
) {}
