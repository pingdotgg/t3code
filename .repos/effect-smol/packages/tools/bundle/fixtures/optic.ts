import * as Optic from "effect/Optic"

type S = { readonly a: number }
const optic = Optic.id<S>().key("a")

optic.getResult({ a: 1 })
