import { Worker } from "@/Cloudflare/Workers/Worker";
import { storageHttpHandler } from "./StorageHttpHandler.ts";

export default class StorageHttpWorker extends Worker<StorageHttpWorker>()(
  "StorageHttpWorker",
  { main: import.meta.url },
  storageHttpHandler,
) {}
