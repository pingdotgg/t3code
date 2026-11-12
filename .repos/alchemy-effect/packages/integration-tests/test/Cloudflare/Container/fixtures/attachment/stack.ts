import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type { AttachmentContainerObject } from "./worker.ts";

export const stackName = "ContainerAttachmentStack";

export const namedStackName = "ContainerNamedAttachmentStack";

export const attachmentStack = (attached = true, name?: string) =>
  Alchemy.Stack(
    name === undefined ? stackName : namedStackName,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const container = Cloudflare.Container<AttachmentContainerObject>("AttachmentContainer", {
        className: "AttachmentContainerObject",
        image: "mendhak/http-https-echo:41",
        maxInstances: 2,
        name,
      });
      const other = Cloudflare.Container<AttachmentContainerObject>("OtherAttachmentContainer", {
        className: "AttachmentContainerObject",
        image: "mendhak/http-https-echo:41",
        maxInstances: 2,
      });
      const worker = yield* Cloudflare.Worker("AttachmentWorker", {
        main: path.join(import.meta.dirname, attached ? "worker.ts" : "detached-worker.ts"),
        env: attached ? { ECHO: container } : {},
      });
      const otherWorker = yield* Cloudflare.Worker("OtherAttachmentWorker", {
        main: path.join(import.meta.dirname, "worker.ts"),
        env: { ECHO: other },
      });
      const app = yield* container.Application;
      const otherApp = yield* other.Application;
      return {
        worker,
        app,
        otherWorker,
        otherApp,
        url: worker.url.as<string>(),
      };
    }),
  );

export default attachmentStack();
