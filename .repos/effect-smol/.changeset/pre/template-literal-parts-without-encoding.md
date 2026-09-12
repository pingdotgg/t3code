---
"effect": patch
---

Separate template literal validation from transformed tuple parsing. `TemplateLiteralParser` now propagates its parts' decoding and encoding service requirements.

### Breaking changes

`Schema.TemplateLiteral` and `SchemaAST.TemplateLiteral` now throw during construction when a part contains an encoding, including inside unions and nested templates. This also rejects transformations whose decoded and encoded types are equal. Brands and supported checks without encodings remain valid.

Use `Schema.Literals([0, 1])` to describe bit spellings or `Schema.Finite` to describe finite numeric spellings. Use `Schema.TemplateLiteralParser` when you need to decode transformed parts into a tuple. Explicit `Schema.toType` or `Schema.toEncoded` projections can remove an encoding, but do not necessarily preserve the strings accepted by the old template. For example, a `Finite` part rejects the empty segment accepted by `FiniteFromString`.

`Schema.toEncoded(Schema.TemplateLiteralParser(...))` now validates the structure of the template instead of accepting any string. Use `Schema.String` when unrestricted strings are intended.

When parser parts require services, provide those services to the corresponding decoding or encoding effect. These requirements were previously omitted from the parser's types.
