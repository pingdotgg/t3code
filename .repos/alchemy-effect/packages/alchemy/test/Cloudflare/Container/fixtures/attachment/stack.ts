import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type { AttachmentContainerObject } from "./worker.ts";

export const stackName = "ContainerAttachmentStack";

export const attachmentStack = (attached = true) =>
  Alchemy.Stack(
    stackName,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const container = Cloudflare.Container<AttachmentContainerObject>(
        "AttachmentContainer",
        {
          className: "AttachmentContainerObject",
          image: "mendhak/http-https-echo:41",
          maxInstances: 2,
        },
      );
      const other = Cloudflare.Container<AttachmentContainerObject>(
        "OtherAttachmentContainer",
        {
          className: "AttachmentContainerObject",
          image: "mendhak/http-https-echo:41",
          maxInstances: 2,
        },
      );
      const worker = yield* Cloudflare.Worker("AttachmentWorker", {
        main: path.join(import.meta.dirname, "worker.ts"),
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
