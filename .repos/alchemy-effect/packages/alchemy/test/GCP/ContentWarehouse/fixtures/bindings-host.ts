import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

const location = "us";

/** Document schema GetDocumentSchema reads. */
export const Note = GCP.ContentWarehouse.DocumentSchema("Note", {
  location,
  displayName: "binding-note",
  propertyDefinitions: [
    { name: "title", isSearchable: true, textTypeOptions: {} },
  ],
});

/** Document GetDocument reads. */
export const Welcome = Effect.gen(function* () {
  const schema = yield* Note;
  return yield* GCP.ContentWarehouse.Document("Welcome", {
    location,
    documentSchemaName: schema.name,
    displayName: "binding-welcome",
    plainText: "hello binding",
  });
});

/** Rule set GetRuleSet reads. */
export const Checks = GCP.ContentWarehouse.RuleSet("Checks", {
  location,
  description: "binding rules",
  source: "alchemy",
  rules: [
    {
      description: "require title",
      triggerType: "ON_CREATE",
      condition: "true",
      actions: [{ dataValidation: { conditions: { display_name: "true" } } }],
    },
  ],
});

/** Synonym set GetSynonymSet reads. */
export const Sales = GCP.ContentWarehouse.SynonymSet("Sales", {
  location,
  synonyms: [{ words: ["sale", "invoice", "bill"] }],
});

/**
 * Effect-native Cloud Run service exercising every Document AI Warehouse
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ContentWarehouseBindingsHost extends GCP.Function<ContentWarehouseBindingsHost>()(
  "ContentWarehouseBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getDocumentSchema =
      yield* GCP.ContentWarehouse.GetDocumentSchema(Note);
    const getDocument = yield* GCP.ContentWarehouse.GetDocument(Welcome);
    const getRuleSet = yield* GCP.ContentWarehouse.GetRuleSet(Checks);
    const getSynonymSet = yield* GCP.ContentWarehouse.GetSynonymSet(Sales);

    return {
      fetch: serveProbes({
        getDocumentSchema: getDocumentSchema(),
        getDocument: getDocument(),
        getRuleSet: getRuleSet(),
        getSynonymSet: getSynonymSet(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.ContentWarehouse.GetDocumentSchemaHttp),
    Effect.provide(GCP.ContentWarehouse.GetDocumentHttp),
    Effect.provide(GCP.ContentWarehouse.GetRuleSetHttp),
    Effect.provide(GCP.ContentWarehouse.GetSynonymSetHttp),
  ),
) {}
