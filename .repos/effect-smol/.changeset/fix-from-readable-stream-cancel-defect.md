---
"effect": patch
---

Stream.fromReadableStream: swallow the `reader.cancel()` rejection in the finalizer. Cancelling the reader of an already-errored ReadableStream rejects with the stored error, which turned the typed `onError` failure into a defect.
