import * as AWS from "alchemy/AWS";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ShellImageLive from "./src/shell-image.ts";
import ShellWorker from "./src/worker.ts";

/**
 * Browser terminal → Cloudflare Worker → Durable Object → AWS Lambda MicroVM.
 *
 * A hand-rolled terminal SPA (served inline by the Worker) opens a WebSocket to
 * a per-session Durable Object. The Worker provisions the session's MicroVM
 * (assume-role control plane) and hands its endpoint + auth token to the DO,
 * which POSTs each typed command to the VM's streaming `/exec` route and
 * forwards stdout/stderr back to the browser as it is produced.
 *
 * Runs end-to-end under `alchemy dev`: the Worker + DO in local workerd, the
 * MicroVM on the Floci emulator, connected by the cross-cloud endpoint + CA
 * wiring. A live `alchemy deploy` needs the AWS Lambda MicroVM preview
 * entitlement on the account.
 */
export default Alchemy.Stack(
  "CloudflareMicrovmShell",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* ShellWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(ShellImageLive)),
);
