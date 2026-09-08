---
"effect": patch
---

Improve Schema type-level performance by lazily computing schema views,
specializing common struct projections, and using lighter schema constraints at
API boundaries that do not need the full schema protocol.

This also adds the Schema type-performance benchmark suite, introduces
`Schema.toCodecArrayFromSingle`, preserves canonical StringTree array codecs,
renames the arbitrary-generation annotation constraint for clarity, and updates
affected codec, parser, channel, SQL, HTTP API, persistence, RPC, AI, OpenAPI,
and workflow typings to match the refined Schema surface.
