import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** OCR processor GetProcessor reads and Process runs. */
export const OcrBind = GCP.DocumentAI.Processor("OcrBind", {
  location: "us",
  type: "OCR_PROCESSOR",
  displayName: "ocr-bind",
});

/** Schema GetSchema reads. */
export const Invoice = GCP.DocumentAI.Schema("Invoice", {
  location: "us",
  displayName: "invoice-bind",
  labels: { env: "test" },
});

/** Schema version GetSchemaVersion reads. */
export const InvoiceV1 = Effect.gen(function* () {
  const schema = yield* Invoice;
  return yield* GCP.DocumentAI.SchemasSchemaVersion("V1", {
    schema: schema.name,
    location: "us",
    displayName: "v1",
    documentSchema: {
      displayName: "invoice",
      description: "invoice fields",
      entityTypes: [
        {
          name: "invoice",
          baseTypes: ["document"],
          properties: [
            {
              name: "invoice_id",
              valueType: "string",
              occurrenceType: "OPTIONAL_ONCE",
            },
          ],
        },
      ],
    },
    labels: { env: "test" },
  });
});

/** One-page PDF reading "Hello". */
export const MINIMAL_PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (Hello) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000216 00000 n 
0000000309 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
376
%%EOF
`;

/**
 * Effect-native Cloud Run service exercising every Document AI binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class DocumentAIBindingsHost extends GCP.Function<DocumentAIBindingsHost>()(
  "DocumentAIBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getProcessor = yield* GCP.DocumentAI.GetProcessor(OcrBind);
    const process = yield* GCP.DocumentAI.Process(OcrBind);
    const getSchema = yield* GCP.DocumentAI.GetSchema(Invoice);
    const getSchemaVersion = yield* GCP.DocumentAI.GetSchemaVersion(InvoiceV1);

    return {
      fetch: serveProbes({
        getProcessor: getProcessor(),
        process: process({
          body: {
            rawDocument: {
              content: btoa(MINIMAL_PDF),
              mimeType: "application/pdf",
            },
            skipHumanReview: true,
          },
        }).pipe(
          Effect.map((processed) => ({
            text: processed.document?.text,
            pages: processed.document?.pages?.length,
          })),
        ),
        getSchema: getSchema(),
        getSchemaVersion: getSchemaVersion(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.DocumentAI.GetProcessorHttp),
    Effect.provide(GCP.DocumentAI.ProcessHttp),
    Effect.provide(GCP.DocumentAI.GetSchemaHttp),
    Effect.provide(GCP.DocumentAI.GetSchemaVersionHttp),
  ),
) {}
