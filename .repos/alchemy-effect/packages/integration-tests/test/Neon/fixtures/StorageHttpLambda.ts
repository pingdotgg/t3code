import { Function } from "@alchemy.run/aws/Lambda/Function";
import { storageHttpHandler } from "./StorageHttpHandler.ts";

export default class StorageHttpLambda extends Function<StorageHttpLambda>()(
  "StorageHttpLambda",
  { main: import.meta.url, functionUrl: true },
  storageHttpHandler,
) {}
