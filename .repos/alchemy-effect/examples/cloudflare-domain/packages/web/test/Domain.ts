import * as Domain from "@alchemy.run/domain";
import { customer } from "@bank/domain/Actor";
import { Bank } from "@bank/domain/Bank.model";
import { CurrentActor } from "@bank/domain/CurrentActor.context";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { MfaChallenge, MfaRequired } from "@bank/domain/MfaChallenge.middleware";
import { Session } from "@bank/domain/Session.middleware";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

class WebBank extends Domain.Model("WebBank", {
  aggregates: Bank.definitions.aggregates,
  views: Bank.definitions.views,
  streams: Bank.definitions.streams,
}) {}
const Hosted = WebBank.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory));
const Middleware = Layer.merge(
  Layer.succeed(Session, (effect) => Effect.provideService(effect, CurrentActor, customer("c-1"))),
  Layer.succeed(MfaChallenge, () => Effect.fail(MfaRequired.make({}))),
);
export const Client = CustomerApi.layerClientInProcess.pipe(
  Layer.provide(Layer.merge(Hosted, Middleware)),
);
