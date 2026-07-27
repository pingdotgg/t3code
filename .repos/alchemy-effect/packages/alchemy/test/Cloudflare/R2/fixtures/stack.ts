import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
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
 * alchemy tail --stage test ./test/Cloudflare/R2/fixtures/stack.ts
 * ```
 */
export default Alchemy.Stack(
  "R2BindingStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const readBinding = yield* ReadBindingWorker;
    const writeBinding = yield* WriteBindingWorker;
    const readWriteBinding = yield* ReadWriteBindingWorker;
    const readHttp = yield* ReadHttpWorker;
    const writeHttp = yield* WriteHttpWorker;
    const readWriteHttp = yield* ReadWriteHttpWorker;
    return {
      readBinding: readBinding.url.as<string>(),
      writeBinding: writeBinding.url.as<string>(),
      readWriteBinding: readWriteBinding.url.as<string>(),
      readHttp: readHttp.url.as<string>(),
      writeHttp: writeHttp.url.as<string>(),
      readWriteHttp: readWriteHttp.url.as<string>(),
    };
  }),
);
