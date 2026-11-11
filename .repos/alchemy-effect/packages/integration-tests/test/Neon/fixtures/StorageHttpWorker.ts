import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { storageHttpHandler } from "./StorageHttpHandler.ts";

export default class StorageHttpWorker extends Worker<StorageHttpWorker>()(
  "StorageHttpWorker",
  { main: import.meta.url },
  storageHttpHandler,
) {}
