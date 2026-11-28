import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { TestBucket } from "./bucket.ts";
import ReadBindingWorker from "./read-binding.ts";
import ReadHttpWorker from "./read-http.ts";
import ReadWriteBindingWorker from "./readwrite-binding.ts";
import ReadWriteHttpWorker from "./readwrite-http.ts";
import WriteBindingWorker from "./write-binding.ts";
import WriteHttpWorker from "./write-http.ts";

/**
 * Deploys six Workers that all bind one shared R2 bucket — read / write /
 * read-write, each over the native Worker binding (`*BucketBinding`) and over a
 * scoped HTTP API token (`*BucketHttp`). Extracted into its own stack file so
 * it can be deployed by the test suite AND inspected directly, e.g.
 *
 * ```sh
 * alchemy logs --tail --stage test --config ./test/Cloudflare/R2/fixtures/stack.ts
 * ```
 */
export default Alchemy.Stack(
  "R2BindingStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const readBinding = yield* ReadBindingWorker;
    const writeBinding = yield* WriteBindingWorker;
    const readWriteBinding = yield* ReadWriteBindingWorker;
    const readHttp = yield* ReadHttpWorker;
    const writeHttp = yield* WriteHttpWorker;
    const readWriteHttp = yield* ReadWriteHttpWorker;
    return {
      bucketName: bucket.bucketName,
      workerNames: [
        readBinding.workerName,
        writeBinding.workerName,
        readWriteBinding.workerName,
        readHttp.workerName,
        writeHttp.workerName,
        readWriteHttp.workerName,
      ],
      readBinding: readBinding.url.as<string>(),
      writeBinding: writeBinding.url.as<string>(),
      readWriteBinding: readWriteBinding.url.as<string>(),
      readHttp: readHttp.url.as<string>(),
      writeHttp: writeHttp.url.as<string>(),
      readWriteHttp: readWriteHttp.url.as<string>(),
    };
  }),
);
