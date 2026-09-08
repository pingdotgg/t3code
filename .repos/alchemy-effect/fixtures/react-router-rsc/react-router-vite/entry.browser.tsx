import {
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from "@vitejs/plugin-rsc/browser";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import type { DataRouter, unstable_RSCPayload as RSCServerPayload } from "react-router";
import {
  unstable_createCallServer as createCallServer,
  unstable_getRSCStream as getRSCStream,
  unstable_RSCHydratedRouter as RSCHydratedRouter,
} from "react-router/dom";

setServerCallback(
  createCallServer({
    createFromReadableStream,
    createTemporaryReferenceSet,
    encodeReply,
  }),
);

createFromReadableStream<RSCServerPayload>(getRSCStream()).then((payload) => {
  startTransition(async () => {
    const formState = payload.type === "render" ? await payload.formState : undefined;

    hydrateRoot(
      document,
      <StrictMode>
        <RSCHydratedRouter createFromReadableStream={createFromReadableStream} payload={payload} />
      </StrictMode>,
      {
        // @ts-expect-error - no types for this yet
        formState,
      },
    );
  });
});

declare let __reactRouterDataRouter: DataRouter;

if (import.meta.hot) {
  import.meta.hot.on("rsc:update", () => {
    __reactRouterDataRouter.revalidate();
  });
}
