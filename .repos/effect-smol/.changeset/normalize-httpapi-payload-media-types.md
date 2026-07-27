---
"effect": patch
---

Normalize HttpApi payload media types.

Payload schemas were stored under their exact declared `Content-Type`, but the server lowercased the incoming header and removed its parameters before looking it up. For example, a schema declared as `Application/Vnd.Effect+JSON; profile=declared` was stored under that value, while the server looked for `application/vnd.effect+json`. This could produce a `415` response even when the generated client and server used the same API.

The same mismatch allowed incompatible encodings for equivalent media types to bypass validation. Generated form-urlencoded requests also ignored custom content types and always used the default one.

Payload maps now use normalized keys for matching and conflict checks, while each encoding keeps its declared content type. Generated requests and OpenAPI use the declared values, including every parameterized variant, and custom form-urlencoded content types are preserved.
