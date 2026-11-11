import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { NotesApi } from "../NotesApi.api.ts";
import { UserId } from "../User.id.ts";
import { auth } from "./auth.ts";
import { Flags, init, Model, subscriptions, update, view } from "./Notes.ts";

// Who better-auth says is signed in, before the app starts.
const flags = Effect.promise(() => auth.getSession()).pipe(
  Effect.map(({ data }) => ({
    user: data ? { userId: UserId.make(data.user.id), name: data.user.name } : null,
  })),
);

// The session cookie is first-party, so every call and watch on /api carries it.
const NotesConnection = NotesApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
);

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: NotesConnection,
    container: document.getElementById("root"),
  }),
  { flags },
);
