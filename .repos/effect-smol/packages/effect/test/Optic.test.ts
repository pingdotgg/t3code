import { Optic, Option, Result, Schema } from "effect"
import { describe, it } from "vitest"
import { assertFailure, assertSuccess, assertTrue, deepStrictEqual, strictEqual, throws } from "./utils/assert.ts"

const addOne = (n: number) => n + 1

describe("Optic", () => {
  it("replace should throw an error if the object has a non-Object constructor or null prototype", () => {
    {
      class A {
        readonly x: number
        constructor(x: number) {
          this.x = x
        }
      }
      const optic = Optic.id<A>().key("x")
      throws(() => optic.replace(2, new A(1)), "Cannot clone object with non-Object constructor or null prototype")
    }

    // null prototype is allowed
    {
      type S = { readonly a: number }
      const obj = Object.create(null)
      obj.a = 1
      const optic = Optic.id<S>().key("a")
      deepStrictEqual(optic.replace(2, obj), { a: 2 })
    }
  })

  it("id", () => {
    const iso = Optic.id<number>()

    strictEqual(iso.get(1), 1)
    strictEqual(iso.set(1), 1)
    strictEqual(iso.modify(addOne)(1), 2)
  })

  describe("key", () => {
    describe("Struct", () => {
      it("required key", () => {
        type S = { readonly a: number }
        const optic = Optic.id<S>().key("a")

        strictEqual(optic.get({ a: 1 }), 1)
        deepStrictEqual(optic.replace(2, { a: 1 }), { a: 2 })
        deepStrictEqual(optic.modify(addOne)({ a: 1 }), { a: 2 })
      })

      it("nested required keys", () => {
        type S = {
          readonly a: {
            readonly b: number
          }
        }
        const optic = Optic.id<S>().key("a").key("b")

        strictEqual(optic.get({ a: { b: 1 } }), 1)
        deepStrictEqual(optic.replace(2, { a: { b: 1 } }), { a: { b: 2 } })
        deepStrictEqual(optic.modify(addOne)({ a: { b: 1 } }), { a: { b: 2 } })
      })

      it("optional key (with undefined)", () => {
        type S = { readonly a?: number | undefined }
        const optic = Optic.id<S>().key("a")
        const f = (n: number | undefined) => n !== undefined ? n + 1 : undefined

        strictEqual(optic.get({ a: 1 }), 1)
        strictEqual(optic.get({}), undefined)
        strictEqual(optic.get({ a: undefined }), undefined)
        deepStrictEqual(optic.replace(2, { a: 1 }), { a: 2 })
        deepStrictEqual(optic.replace(2, {}), { a: 2 })
        deepStrictEqual(optic.replace(2, { a: undefined }), { a: 2 })
        deepStrictEqual(optic.replace(undefined, { a: 1 }), { a: undefined })
        deepStrictEqual(optic.replace(undefined, {}), { a: undefined })
        deepStrictEqual(optic.modify(f)({ a: 1 }), { a: 2 })
        deepStrictEqual(optic.modify(f)({}), { a: undefined })
        deepStrictEqual(optic.modify(f)({ a: undefined }), { a: undefined })
      })
    })

    describe("Tuple", () => {
      it("required element", () => {
        type S = readonly [number]
        const optic = Optic.id<S>().key(0)

        strictEqual(optic.get([1]), 1)
        deepStrictEqual(optic.replace(2, [1]), [2])
        deepStrictEqual(optic.modify(addOne)([1]), [2])
      })

      it("nested required element", () => {
        type S = readonly [string, readonly [number]]
        const optic = Optic.id<S>().key(1).key(0)

        strictEqual(optic.get(["a", [1]]), 1)
        deepStrictEqual(optic.replace(2, ["a", [1]]), ["a", [2]])
        deepStrictEqual(optic.modify(addOne)(["a", [1]]), ["a", [2]])
      })

      it("optional element (with undefined)", () => {
        type S = readonly [number, (number | undefined)?]
        const optic = Optic.id<S>().key(1)
        const f = (n: number | undefined) => n !== undefined ? n + 1 : undefined

        strictEqual(optic.get([1, 2]), 2)
        strictEqual(optic.get([1]), undefined)
        strictEqual(optic.get([1, undefined]), undefined)
        deepStrictEqual(optic.replace(2, [1, 2]), [1, 2])
        deepStrictEqual(optic.replace(2, [1]), [1, 2])
        deepStrictEqual(optic.replace(2, [1, undefined]), [1, 2])
        deepStrictEqual(optic.replace(undefined, [1, 2]), [1, undefined])
        deepStrictEqual(optic.replace(undefined, [1]), [1, undefined])
        deepStrictEqual(optic.modify(f)([1, 2]), [1, 3])
        deepStrictEqual(optic.modify(f)([1]), [1, undefined])
        deepStrictEqual(optic.modify(f)([1, undefined]), [1, undefined])
      })
    })

    it("Mixed structs and tuples", () => {
      type S = {
        readonly a: readonly [number]
      }
      const optic = Optic.id<S>().key("a").key(0)

      strictEqual(optic.get({ a: [1] }), 1)
      deepStrictEqual(optic.replace(2, { a: [1] }), { a: [2] })
      deepStrictEqual(optic.modify(addOne)({ a: [1] }), { a: [2] })
    })
  })

  describe("optionalKey", () => {
    describe("Struct", () => {
      it("exact optional key (without undefined)", () => {
        type S = { readonly a?: number }
        const optic = Optic.id<S>().optionalKey("a")
        const f = (n: number | undefined) => n !== undefined ? n + 1 : undefined

        strictEqual(optic.get({ a: 1 }), 1)
        strictEqual(optic.get({}), undefined)
        deepStrictEqual(optic.replace(2, { a: 1 }), { a: 2 })
        deepStrictEqual(optic.replace(2, {}), { a: 2 })
        deepStrictEqual(optic.replace(undefined, { a: 1 }), {})
        deepStrictEqual(optic.replace(undefined, {}), {})
        deepStrictEqual(optic.modify(f)({ a: 1 }), { a: 2 })
        deepStrictEqual(optic.modify(f)({}), {})
      })
    })

    it("Record", () => {
      type S = { [x: string]: number }
      const optic = Optic.id<S>().optionalKey("a")
      const f = (n: number | undefined) => n !== undefined ? n + 1 : undefined

      strictEqual(optic.get({ a: 1, b: 2 }), 1)
      strictEqual(optic.get({ b: 2 }), undefined)
      deepStrictEqual(optic.replace(2, { a: 1, b: 2 }), { a: 2, b: 2 })
      deepStrictEqual(optic.replace(2, { b: 2 }), { a: 2, b: 2 })
      deepStrictEqual(optic.replace(undefined, { a: 1 }), {})
      deepStrictEqual(optic.replace(undefined, { b: 2 }), { b: 2 })
      deepStrictEqual(optic.modify(f)({ a: 1 }), { a: 2 })
      deepStrictEqual(optic.modify(f)({ b: 2 }), { b: 2 })
    })

    describe("Tuple", () => {
      it("exact optional element (without undefined)", () => {
        type S = readonly [number, number?]
        const optic = Optic.id<S>().optionalKey(1)
        const f = (n: number | undefined) => n !== undefined ? n + 1 : undefined

        strictEqual(optic.get([1, 2]), 2)
        strictEqual(optic.get([1]), undefined)
        deepStrictEqual(optic.replace(3, [1, 2]), [1, 3])
        deepStrictEqual(optic.replace(3, [1]), [1, 3])
        deepStrictEqual(optic.replace(undefined, [1, 2]), [1])
        deepStrictEqual(optic.replace(undefined, [1]), [1])
        deepStrictEqual(optic.modify(f)([1, 2]), [1, 3])
        deepStrictEqual(optic.modify(f)([1]), [1])
      })
    })

    it("Array", () => {
      type S = ReadonlyArray<number>
      const optic = Optic.id<S>().optionalKey(1)
      const f = (n: number | undefined) => n !== undefined ? n + 1 : undefined

      strictEqual(optic.get([1, 2, 3]), 2)
      strictEqual(optic.get([1]), undefined)
      deepStrictEqual(optic.replace(4, [1, 2, 3]), [1, 4, 3])
      deepStrictEqual(optic.replace(4, [1]), [1, 4])
      deepStrictEqual(optic.replace(undefined, [1, 2]), [1])
      deepStrictEqual(optic.replace(undefined, [1, 2, 3]), [1, 3])
      deepStrictEqual(optic.replace(undefined, [1]), [1])
      deepStrictEqual(optic.modify(f)([1, 2]), [1, 3])
      deepStrictEqual(optic.modify(f)([1, 2, 4]), [1, 3, 4])
      deepStrictEqual(optic.modify(f)([1]), [1])
    })
  })

  describe("check", () => {
    it("single check", () => {
      type S = number
      const optic = Optic.id<S>().check(Schema.isGreaterThan(0))
      assertSuccess(optic.getResult(1), 1)
      assertFailure(optic.getResult(0), `Expected a value greater than 0, got 0`)
      strictEqual(optic.set(1), 1)
      strictEqual(optic.set(0), 0)
      deepStrictEqual(optic.modify(addOne)(1), 2)
      deepStrictEqual(optic.modify(addOne)(0), 0)
    })

    it("multiple checks", () => {
      type S = number
      const optic = Optic.id<S>().check(Schema.isInt(), Schema.isGreaterThan(0))
      assertSuccess(optic.getResult(1), 1)
      assertFailure(optic.getResult(0), `Expected a value greater than 0, got 0`)
      assertFailure(optic.getResult(1.1), `Expected an integer, got 1.1`)
      assertFailure(
        optic.getResult(-1.1),
        `Expected an integer, got -1.1
Expected a value greater than 0, got -1.1`
      )
      deepStrictEqual(optic.modify(addOne)(1), 2)
      deepStrictEqual(optic.modify(addOne)(0), 0)
      deepStrictEqual(optic.modify(addOne)(1.1), 1.1)
      deepStrictEqual(optic.modify(addOne)(-1.1), -1.1)
    })
  })

  it("refine", () => {
    type B = { readonly _tag: "b"; readonly b: number }
    type S = { readonly _tag: "a"; readonly a: string } | B
    const optic = Optic.id<S>().refine(
      (s: S): s is B => s._tag === "b",
      { expected: `"b" tag` }
    ).key("b")

    assertSuccess(optic.getResult({ _tag: "b", b: 1 }), 1)
    assertFailure(optic.getResult({ _tag: "a", a: "value" }), `Expected "b" tag, got {"_tag":"a","a":"value"}`)
    deepStrictEqual(optic.modify(addOne)({ _tag: "a", a: "value" }), { _tag: "a", a: "value" })
    deepStrictEqual(optic.modify(addOne)({ _tag: "b", b: 1 }), { _tag: "b", b: 2 })
  })

  it("tag", () => {
    type S = { readonly _tag: "a"; readonly a: string } | { readonly _tag: "b"; readonly b: number }
    const optic = Optic.id<S>().tag("b").key("b")

    assertSuccess(optic.getResult({ _tag: "b", b: 1 }), 1)
    assertFailure(optic.getResult({ _tag: "a", a: "value" }), `Expected "b" tag, got "a"`)
    deepStrictEqual(optic.modify(addOne)({ _tag: "a", a: "value" }), { _tag: "a", a: "value" })
    deepStrictEqual(optic.modify(addOne)({ _tag: "b", b: 1 }), { _tag: "b", b: 2 })
  })

  describe("at", () => {
    it("Record", () => {
      type S = { [x: string]: number }
      const optic = Optic.id<S>().at("a")

      assertSuccess(optic.getResult({ a: 1, b: 2 }), 1)
      assertFailure(optic.getResult({ b: 2 }), `Key "a" not found`)
      assertSuccess(optic.replaceResult(2, { a: 1, b: 2 }), { a: 2, b: 2 })
      assertFailure(optic.replaceResult(2, { b: 2 }), `Key "a" not found`)
      deepStrictEqual(optic.replace(2, { a: 1, b: 2 }), { a: 2, b: 2 })
      deepStrictEqual(optic.replace(2, { b: 2 }), { b: 2 })
    })

    it("Array", () => {
      type S = ReadonlyArray<number>
      const optic = Optic.id<S>().at(0)

      assertSuccess(optic.getResult([1, 2]), 1)
      assertFailure(optic.getResult([]), `Key 0 not found`)
      assertSuccess(optic.replaceResult(3, [1, 2]), [3, 2])
      assertFailure(optic.replaceResult(2, []), `Key 0 not found`)
      deepStrictEqual(optic.replace(3, [1, 2]), [3, 2])
      deepStrictEqual(optic.replace(2, []), [])
    })
  })

  it("key & check", () => {
    type S = { readonly a: number }
    const optic = Optic.id<S>().key("a").check(Schema.isGreaterThan(0))
    assertSuccess(optic.getResult({ a: 1 }), 1)
    assertFailure(optic.getResult({ a: 0 }), `Expected a value greater than 0, got 0`)
    assertSuccess(optic.replaceResult(2, { a: 1 }), { a: 2 })
    assertFailure(optic.replaceResult(2, { a: 0 }), `Expected a value greater than 0, got 0`)
    deepStrictEqual(optic.replace(2, { a: 1 }), { a: 2 })
    deepStrictEqual(optic.replace(2, { a: 0 }), { a: 0 })
  })

  describe("pick", () => {
    it("Struct", () => {
      type S = { readonly a: string; readonly b: number; readonly c: boolean }
      const optic = Optic.id<S>().pick(["a", "c"])

      deepStrictEqual(optic.replace({ a: "a2", c: false }, { a: "a", b: 1, c: true }), { a: "a2", b: 1, c: false })
    })
  })

  describe("omit", () => {
    it("Struct", () => {
      type S = { readonly a: string; readonly b: number; readonly c: boolean }
      const optic = Optic.id<S>().omit(["b"])

      deepStrictEqual(optic.replace({ a: "a2", c: false }, { a: "a", b: 1, c: true }), { a: "a2", b: 1, c: false })
    })
  })

  describe("forEach", () => {
    it("Array", () => {
      type Post = { title: string; likes: number }
      type S = { user: { posts: ReadonlyArray<Post> } }

      const _like = Optic.id<S>().key("user").key("posts").forEach((post) =>
        post.key("likes").check(Schema.isGreaterThan(0))
      )

      const addLike = _like.modify((likes) => likes.map((l) => l + 1))

      deepStrictEqual(
        addLike({ user: { posts: [{ title: "a", likes: 0 }, { title: "b", likes: 1 }, { title: "c", likes: 0 }] } }),
        {
          user: { posts: [{ title: "a", likes: 0 }, { title: "b", likes: 2 }, { title: "c", likes: 0 }] }
        }
      )
    })

    it("Record", () => {
      const optic = Optic.entries<number>().forEach((entry) => entry.key(1).check(Schema.isGreaterThan(0)))

      deepStrictEqual(
        optic.modify((entries) => entries.map((value) => value + 1))({ a: 0, b: 1, c: 0 }),
        { a: 0, b: 2, c: 0 }
      )
    })
  })

  describe("modifyAll", () => {
    it("Array", () => {
      type Post = { title: string; likes: number }
      type S = { user: { posts: ReadonlyArray<Post> } }

      const _like = Optic.id<S>().key("user").key("posts").forEach((post) =>
        post.key("likes").check(Schema.isGreaterThan(0))
      )

      const addLike = _like.modifyAll((like) => like + 1)

      deepStrictEqual(
        addLike({ user: { posts: [{ title: "a", likes: 0 }, { title: "b", likes: 1 }, { title: "c", likes: 0 }] } }),
        {
          user: { posts: [{ title: "a", likes: 0 }, { title: "b", likes: 2 }, { title: "c", likes: 0 }] }
        }
      )
    })

    it("Record", () => {
      const optic = Optic.entries<number>().forEach((entry) => entry.key(1).check(Schema.isGreaterThan(0)))

      deepStrictEqual(
        optic.modify((entries) => entries.map((value) => value + 1))({ a: 0, b: 1, c: 0 }),
        { a: 0, b: 2, c: 0 }
      )
    })
  })

  it("notUndefined", () => {
    const optic = Optic.id<number | undefined>().notUndefined()
    assertSuccess(optic.getResult(1), 1)
    assertFailure(optic.getResult(undefined), "Expected a value other than `undefined`, got undefined")

    deepStrictEqual(optic.replace(2, undefined), 2)
    deepStrictEqual(optic.replace(2, 1), 2)
  })

  it("getAll", () => {
    type S = {
      readonly a: ReadonlyArray<number>
    }
    const optic = Optic.id<S>().key("a").forEach((a) => a.check(Schema.isGreaterThan(0)))
    const getAll = Optic.getAll(optic)
    deepStrictEqual(getAll({ a: [1, 2, 3] }), [1, 2, 3])
    deepStrictEqual(getAll({ a: [1, -2, 3] }), [1, 3])
  })

  it("replace copies only objects and arrays along the focused path", () => {
    type Task = { id: number; done: boolean; title: string }
    type Project = { id: number; name: string; tasks: Array<Task> }
    type State = { user: { id: string; name: string }; settings: { theme: "light" | "dark" }; projects: Array<Project> }

    const s1: State = {
      user: { id: "u1", name: "Ada" },
      settings: { theme: "light" },
      projects: [
        { id: 1, name: "Alpha", tasks: [{ id: 1, done: false, title: "T1" }] },
        { id: 2, name: "Beta", tasks: [{ id: 2, done: false, title: "T2" }] }
      ]
    }

    // build an optic to projects[1].tasks[0].done
    const _done = Optic.id<State>()
      .key("projects").key(1)
      .key("tasks").key(0)
      .key("done")

    // Real update -> copy only the path
    const s2 = _done.replace(true, s1)
    assertTrue(s2 !== s1, "root should change on real update")
    assertTrue(s2.user === s1.user, "unrelated branch reused")
    assertTrue(s2.settings === s1.settings, "unrelated branch reused")
    assertTrue(s2.projects !== s1.projects, "parent array on the path should be new")
    assertTrue(s2.projects[0] === s1.projects[0], "sibling project reused")
    assertTrue(s2.projects[1] !== s1.projects[1], "changed project replaced")
    assertTrue(s2.projects[1].tasks !== s1.projects[1].tasks, "parent array of changed element should be new")
    assertTrue(s2.projects[1].tasks[0] !== s1.projects[1].tasks[0], "changed task replaced")
    assertTrue(s2.projects[1].tasks[0].done === true, "value updated")
  })

  it("fromChecks", () => {
    const optic = Optic.id<number>().compose(Optic.fromChecks(Schema.isGreaterThan(0), Schema.isInt()))
    assertSuccess(optic.getResult(1), 1)
    assertFailure(optic.getResult(0), `Expected a value greater than 0, got 0`)
    assertFailure(optic.getResult(1.1), `Expected an integer, got 1.1`)
  })

  describe("Option", () => {
    it("some", () => {
      const optic = Optic.id<Option.Option<number>>().compose(Optic.some())
      assertSuccess(optic.getResult(Option.some(1)), 1)
      assertFailure(optic.getResult(Option.none()), `Expected a Some value, got none()`)
    })

    it("none", () => {
      const optic = Optic.id<Option.Option<number>>().compose(Optic.none())
      assertSuccess(optic.getResult(Option.none()), undefined)
      assertFailure(optic.getResult(Option.some(1)), `Expected a None value, got some(1)`)
    })
  })

  describe("Result", () => {
    it("success", () => {
      const optic = Optic.id<Result.Result<number, string>>().compose(Optic.success())
      assertSuccess(optic.getResult(Result.succeed(1)), 1)
      assertFailure(optic.getResult(Result.fail("error")), `Expected a Result.Success value, got failure("error")`)
    })

    it("failure", () => {
      const optic = Optic.id<Result.Result<number, string>>().compose(Optic.failure())
      assertSuccess(optic.getResult(Result.fail("error")), "error")
      assertFailure(optic.getResult(Result.succeed(1)), `Expected a Result.Failure value, got success(1)`)
    })
  })
})
