import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * `…/connections/{c}/entityTypes/{type}` of an existing Integration
 * Connectors connection (the test is gated on it being set).
 */
export const ENTITY_TYPE_PARENT = (
  process.env.GCP_TEST_CONNECTORS_PARENT ?? ""
).trim();

/** Entity GetEntity reads. */
export const Account = GCP.Connectors.ConnectionsEntityTypesEntity("Account", {
  parent: ENTITY_TYPE_PARENT,
  fields: { Name: "Alchemy Binding" },
});

/**
 * Effect-native Cloud Run service exercising every Integration Connectors
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ConnectorsBindingsHost extends GCP.Function<ConnectorsBindingsHost>()(
  "ConnectorsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getEntity = yield* GCP.Connectors.GetEntity(Account);

    return {
      fetch: serveProbes({
        getEntity: getEntity(),
      }),
    };
  }).pipe(Effect.provide(GCP.Connectors.GetEntityHttp)),
) {}
