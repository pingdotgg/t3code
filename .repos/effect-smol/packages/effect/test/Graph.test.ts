import { assert } from "@effect/vitest"
import { assertNone, assertSome, strictEqual, throws } from "@effect/vitest/utils"
import { Equal, Graph, Hash, Option } from "effect"
import { describe, expect, it } from "vitest"

const assertSomeEdge = <E>(edge: Option.Option<Graph.Edge<E>>): Graph.Edge<E> => {
  if (Option.isNone(edge)) {
    throw new Error("Expected edge to be present")
  }
  return edge.value
}

const makeReversedUndirectedPath = () =>
  Graph.undirected<string, number>((mutable) => {
    const a = Graph.addNode(mutable, "A")
    const b = Graph.addNode(mutable, "B")
    const c = Graph.addNode(mutable, "C")
    Graph.addEdge(mutable, a, b, 1)
    Graph.addEdge(mutable, c, b, 1)
  })

const makeSingleEdgeGraph = (weight: number) =>
  Graph.directed<string, number>((mutable) => {
    const source = Graph.addNode(mutable, "source")
    const target = Graph.addNode(mutable, "target")
    Graph.addEdge(mutable, source, target, weight)
  })

const unsupportedEdgeWeights = [NaN, -Infinity] as const

const assertGraphError = (thunk: () => void, message: string) => {
  throws(thunk, (error) => {
    strictEqual(error instanceof Graph.GraphError, true)
    if (error instanceof Graph.GraphError) {
      strictEqual(error.message, message)
    }
  })
}

type SetNode = { readonly id: string; readonly label: string }

class SetNodeKey implements Equal.Equal {
  readonly id: string

  constructor(id: string) {
    this.id = id
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof SetNodeKey && this.id === that.id
  }

  [Hash.symbol](): number {
    return Hash.string(this.id)
  }
}

const graphNodeIds = <E, T extends Graph.Kind>(graph: Graph.Graph<SetNode, E, T>) =>
  new Set(Array.from(graph, ([, node]) => node.id))

const graphNodeLabels = <E, T extends Graph.Kind>(graph: Graph.Graph<SetNode, E, T>) =>
  new Map(Array.from(graph, ([, node]) => [node.id, node.label]))

const graphEdgeKeys = <E, T extends Graph.Kind>(graph: Graph.Graph<SetNode, E, T>) => {
  const nodeIds = new Map(Array.from(graph, ([index, node]) => [index, node.id]))
  return new Set(
    Array.from(Graph.edges(graph), ([, edge]) =>
      graph.type === "directed"
        ? `${nodeIds.get(edge.source)}->${nodeIds.get(edge.target)}`
        : `${nodeIds.get(edge.source)}--${nodeIds.get(edge.target)}`)
  )
}

const graphEdgeData = <E, T extends Graph.Kind>(graph: Graph.Graph<SetNode, E, T>) => {
  const nodeIds = new Map(Array.from(graph, ([index, node]) => [index, node.id]))
  return new Map(
    Array.from(
      Graph.edges(graph),
      ([, edge]) => [
        graph.type === "directed"
          ? `${nodeIds.get(edge.source)}->${nodeIds.get(edge.target)}`
          : `${nodeIds.get(edge.source)}--${nodeIds.get(edge.target)}`,
        edge.data
      ]
    )
  )
}

describe("Graph", () => {
  describe("constructors", () => {
    it("should create empty directed graph", () => {
      const graph = Graph.directed<string, number>()

      expect(graph.type).toBe("directed")
      expect(Graph.nodeCount(graph)).toBe(0)
      expect(Graph.edgeCount(graph)).toBe(0)
    })

    it("should create empty undirected graph", () => {
      const graph = Graph.undirected<string, number>()

      expect(graph.type).toBe("undirected")
      expect(Graph.nodeCount(graph)).toBe(0)
      expect(Graph.edgeCount(graph)).toBe(0)
    })
  })

  describe("equality and hashing", () => {
    const makeGraph = (
      type: Graph.Kind,
      edges: ReadonlyArray<readonly [Graph.NodeIndex, Graph.NodeIndex, string]>
    ) =>
      Graph.make(type)<string, string>((mutable) => {
        Graph.addNode(mutable, "A")
        Graph.addNode(mutable, "B")
        for (const [source, target, data] of edges) {
          Graph.addEdge(mutable, source, target, data)
        }
      })

    it("treats undirected edge endpoints as unordered", () => {
      const left = makeGraph("undirected", [[0, 1, "edge"]])
      const right = makeGraph("undirected", [[1, 0, "edge"]])

      strictEqual(Equal.equals(left, right), true)
      strictEqual(Equal.equals(right, left), true)
      strictEqual(Hash.hash(left), Hash.hash(right))
    })

    it("keeps directed edge endpoints ordered", () => {
      const left = makeGraph("directed", [[0, 1, "edge"]])
      const right = makeGraph("directed", [[1, 0, "edge"]])

      strictEqual(Equal.equals(left, right), false)
      strictEqual(Equal.equals(right, left), false)
    })

    it("compares undirected edge data", () => {
      const left = makeGraph("undirected", [[0, 1, "left"]])
      const right = makeGraph("undirected", [[1, 0, "right"]])

      strictEqual(Equal.equals(left, right), false)
    })

    it("keeps parallel edges paired by edge index", () => {
      const left = makeGraph("undirected", [[0, 1, "first"], [0, 1, "second"]])
      const reversed = makeGraph("undirected", [[1, 0, "first"], [1, 0, "second"]])
      const reordered = makeGraph("undirected", [[1, 0, "second"], [1, 0, "first"]])

      strictEqual(Equal.equals(left, reversed), true)
      strictEqual(Hash.hash(left), Hash.hash(reversed))
      strictEqual(Equal.equals(left, reordered), false)
    })

    it("handles undirected self-loops", () => {
      const left = makeGraph("undirected", [[0, 0, "loop"]])
      const right = makeGraph("undirected", [[0, 0, "loop"]])

      strictEqual(Equal.equals(left, right), true)
      strictEqual(Hash.hash(left), Hash.hash(right))
    })

    it("keeps Graph.Edge endpoint equality ordered", () => {
      const left = new Graph.Edge({ source: 0, target: 1, data: "edge" })
      const right = new Graph.Edge({ source: 1, target: 0, data: "edge" })

      strictEqual(Equal.equals(left, right), false)
    })

    it("compares future node allocation", () => {
      const left = Graph.directed<string, string>()
      const right = Graph.directed<string, string>((mutable) => {
        const node = Graph.addNode(mutable, "removed")
        Graph.removeNode(mutable, node)
      })

      strictEqual(Graph.nodeCount(left), Graph.nodeCount(right))
      strictEqual(Graph.edgeCount(left), Graph.edgeCount(right))
      strictEqual(Equal.equals(left, right), false)
      strictEqual(Hash.hash(left) === Hash.hash(right), false)

      let leftNode: Graph.NodeIndex | undefined
      let rightNode: Graph.NodeIndex | undefined
      Graph.mutate(left, (mutable) => {
        leftNode = Graph.addNode(mutable, "next")
      })
      Graph.mutate(right, (mutable) => {
        rightNode = Graph.addNode(mutable, "next")
      })

      strictEqual(leftNode, 0)
      strictEqual(rightNode, 1)
    })

    it("compares future edge allocation", () => {
      const left = makeGraph("directed", [])
      const right = Graph.directed<string, string>((mutable) => {
        const source = Graph.addNode(mutable, "A")
        const target = Graph.addNode(mutable, "B")
        const edge = Graph.addEdge(mutable, source, target, "removed")
        Graph.removeEdge(mutable, edge)
      })

      assert.deepStrictEqual(Array.from(left), Array.from(right))
      assert.deepStrictEqual(Array.from(Graph.edges(left)), Array.from(Graph.edges(right)))
      strictEqual(Equal.equals(left, right), false)
      strictEqual(Hash.hash(left) === Hash.hash(right), false)

      let leftEdge: Graph.EdgeIndex | undefined
      let rightEdge: Graph.EdgeIndex | undefined
      Graph.mutate(left, (mutable) => {
        leftEdge = Graph.addEdge(mutable, 0, 1, "next")
      })
      Graph.mutate(right, (mutable) => {
        rightEdge = Graph.addEdge(mutable, 0, 1, "next")
      })

      strictEqual(leftEdge, 0)
      strictEqual(rightEdge, 1)
    })

    it("preserves allocator equality and hashing through an empty mutation", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const source = Graph.addNode(mutable, "A")
        const target = Graph.addNode(mutable, "B")
        const removed = Graph.addNode(mutable, "removed")
        Graph.removeNode(mutable, removed)
        const edge = Graph.addEdge(mutable, source, target, "removed")
        Graph.removeEdge(mutable, edge)
      })
      const clone = Graph.mutate(graph, () => {})

      strictEqual(Equal.equals(graph, clone), true)
      strictEqual(Hash.hash(graph), Hash.hash(clone))
    })

    it("uses stable reference equality and hashing for mutable graphs", () => {
      const mutable = Graph.beginMutation(Graph.directed<string, string>())
      const initialHash = Hash.hash(mutable)

      strictEqual(Equal.equals(mutable, mutable), true)
      const source = Graph.addNode(mutable, "A")
      const target = Graph.addNode(mutable, "B")
      Graph.addEdge(mutable, source, target, "edge")

      strictEqual(Hash.hash(mutable), initialHash)
      strictEqual(Equal.equals(mutable, mutable), true)
    })

    it("does not structurally compare independently constructed mutable graphs", () => {
      const graph = makeGraph("directed", [[0, 1, "edge"]])
      const left = Graph.beginMutation(graph)
      const right = Graph.beginMutation(graph)

      strictEqual(Equal.equals(left, right), false)
      strictEqual(Equal.equals(right, left), false)
    })

    it("restores structural equality and hashing after finalization", () => {
      const mutable = Graph.beginMutation(Graph.directed<string, string>())
      Hash.hash(mutable)
      const source = Graph.addNode(mutable, "A")
      const target = Graph.addNode(mutable, "B")
      Graph.addEdge(mutable, source, target, "edge")

      const graph = Graph.endMutation(mutable)
      const expected = makeGraph("directed", [[0, 1, "edge"]])

      strictEqual(Equal.equals(graph, expected), true)
      strictEqual(Hash.hash(graph), Hash.hash(expected))
    })
  })

  describe("set operations", () => {
    const makeLeft = () =>
      Graph.directed<{ readonly id: string; readonly label: string }, string>((mutable) => {
        const a = Graph.addNode(mutable, { id: "a", label: "A1" })
        const b = Graph.addNode(mutable, { id: "b", label: "B1" })
        const c = Graph.addNode(mutable, { id: "c", label: "C1" })
        Graph.addEdge(mutable, a, b, "left-ab")
        Graph.addEdge(mutable, b, c, "shared-bc")
      })

    const makeRight = () =>
      Graph.directed<{ readonly id: string; readonly label: string }, string>((mutable) => {
        const b = Graph.addNode(mutable, { id: "b", label: "B2" })
        const c = Graph.addNode(mutable, { id: "c", label: "C2" })
        const d = Graph.addNode(mutable, { id: "d", label: "D2" })
        Graph.addEdge(mutable, b, c, "shared-bc")
        Graph.addEdge(mutable, c, d, "right-cd")
      })

    it("compose merges nodes and edges by identity", () => {
      const graph = Graph.compose(makeLeft(), makeRight(), { nodeIdentity: (node) => node.id })

      assert.deepStrictEqual(graphNodeIds(graph), new Set(["a", "b", "c", "d"]))
      assert.deepStrictEqual(
        graphNodeLabels(graph),
        new Map([
          ["a", "A1"],
          ["b", "B2"],
          ["c", "C2"],
          ["d", "D2"]
        ])
      )
      assert.deepStrictEqual(graphEdgeKeys(graph), new Set(["a->b", "b->c", "c->d"]))
      assert.deepStrictEqual(
        graphEdgeData(graph),
        new Map([
          ["a->b", "left-ab"],
          ["b->c", "shared-bc"],
          ["c->d", "right-cd"]
        ])
      )
    })

    it("intersection keeps shared nodes and shared edges", () => {
      const graph = Graph.intersection(makeLeft(), makeRight(), { nodeIdentity: (node) => node.id })

      assert.deepStrictEqual(graphNodeIds(graph), new Set(["b", "c"]))
      assert.deepStrictEqual(
        graphNodeLabels(graph),
        new Map([
          ["b", "B1"],
          ["c", "C1"]
        ])
      )
      assert.deepStrictEqual(graphEdgeKeys(graph), new Set(["b->c"]))
      assert.deepStrictEqual(graphEdgeData(graph), new Map([["b->c", "shared-bc"]]))
    })

    it("difference preserves self nodes and removes shared edges", () => {
      const graph = Graph.difference(makeLeft(), makeRight(), { nodeIdentity: (node) => node.id })

      assert.deepStrictEqual(graphNodeIds(graph), new Set(["a", "b", "c"]))
      assert.deepStrictEqual(
        graphNodeLabels(graph),
        new Map([
          ["a", "A1"],
          ["b", "B1"],
          ["c", "C1"]
        ])
      )
      assert.deepStrictEqual(graphEdgeKeys(graph), new Set(["a->b"]))
      assert.deepStrictEqual(graphEdgeData(graph), new Map([["a->b", "left-ab"]]))
    })

    it("symmetricDifference keeps edges present in exactly one graph", () => {
      const graph = Graph.symmetricDifference(makeLeft(), makeRight(), { nodeIdentity: (node) => node.id })

      assert.deepStrictEqual(graphNodeIds(graph), new Set(["a", "b", "c", "d"]))
      assert.deepStrictEqual(
        graphNodeLabels(graph),
        new Map([
          ["a", "A1"],
          ["b", "B2"],
          ["c", "C2"],
          ["d", "D2"]
        ])
      )
      assert.deepStrictEqual(graphEdgeKeys(graph), new Set(["a->b", "c->d"]))
      assert.deepStrictEqual(
        graphEdgeData(graph),
        new Map([
          ["a->b", "left-ab"],
          ["c->d", "right-cd"]
        ])
      )
    })

    it("uses node data as identity by default", () => {
      const left = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
      })
      const right = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
      })

      strictEqual(Graph.nodeCount(Graph.compose(left, right)), 2)
      strictEqual(Graph.edgeCount(left.pipe(Graph.intersection(right))), 1)
      strictEqual(Graph.edgeCount(Graph.difference(left, right)), 0)
      strictEqual(Graph.edgeCount(left.pipe(Graph.symmetricDifference(right))), 0)
    })

    it("supports hashable node identities", () => {
      const graph = Graph.compose(makeLeft(), makeRight(), {
        nodeIdentity: (node) => new SetNodeKey(node.id)
      })

      strictEqual(Graph.nodeCount(graph), 4)
      strictEqual(Graph.edgeCount(graph), 3)
    })

    it("supports undefined node data and identities", () => {
      const left = Graph.directed<undefined, never>((mutable) => {
        Graph.addNode(mutable, undefined)
      })
      const right = Graph.directed<undefined, never>((mutable) => {
        Graph.addNode(mutable, undefined)
      })

      strictEqual(Graph.nodeCount(Graph.compose(left, right)), 1)
    })

    it("coalesces duplicate node identities", () => {
      const left = Graph.directed<SetNode, string>((mutable) => {
        const first = Graph.addNode(mutable, { id: "a", label: "first" })
        const last = Graph.addNode(mutable, { id: "a", label: "last" })
        Graph.addEdge(mutable, first, last, "same")
      })
      const right = Graph.directed<SetNode, string>()
      const result = Graph.compose(left, right, { nodeIdentity: (node) => node.id })
      const edge = Array.from(Graph.edges(result))[0][1]

      strictEqual(Graph.nodeCount(result), 1)
      strictEqual(Array.from(Graph.values(Graph.nodes(result)))[0].label, "last")
      strictEqual(edge.source, edge.target)
    })

    it("includes edge data in edge identity", () => {
      const left = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "left")
      })
      const right = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "right")
      })

      strictEqual(Graph.edgeCount(Graph.compose(left, right)), 2)
      strictEqual(Graph.edgeCount(Graph.intersection(left, right)), 0)
      strictEqual(Graph.edgeCount(Graph.difference(left, right)), 1)
      strictEqual(Graph.edgeCount(Graph.symmetricDifference(left, right)), 2)
    })

    it("uses edge data from that for equivalent edges", () => {
      const left = Graph.directed<string, { readonly id: string; readonly label: string }>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, { id: "shared", label: "left" })
      })
      const right = Graph.directed<string, { readonly id: string; readonly label: string }>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, { id: "shared", label: "right" })
      })
      const options = { edgeIdentity: (edge: { readonly id: string }) => edge.id }

      strictEqual(Array.from(Graph.edges(Graph.compose(left, right, options)))[0][1].data.label, "right")
      strictEqual(Array.from(Graph.edges(Graph.intersection(left, right, options)))[0][1].data.label, "right")
    })

    it("deduplicates equal edges in intersections", () => {
      const left = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
      })
      const right = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
        Graph.addEdge(mutable, a, b, "shared")
      })

      strictEqual(Graph.edgeCount(Graph.intersection(left, right)), 1)
    })

    it("treats equal parallel edges as set members rather than occurrences", () => {
      const left = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
        Graph.addEdge(mutable, a, b, "shared")
      })
      const empty = Graph.directed<string, string>()
      const right = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
      })

      strictEqual(Graph.edgeCount(Graph.compose(left, empty)), 1)
      strictEqual(Graph.edgeCount(Graph.intersection(left, right)), 1)
      strictEqual(Graph.edgeCount(Graph.difference(left, empty)), 2)
      strictEqual(Graph.edgeCount(Graph.difference(left, right)), 0)
      strictEqual(Graph.edgeCount(Graph.symmetricDifference(left, empty)), 1)
    })

    it("rejects graphs with different kinds", () => {
      const directed: Graph.Graph<string, string, Graph.Kind> = Graph.directed()
      const undirected: Graph.Graph<string, string, Graph.Kind> = Graph.undirected()

      throws(
        () => Graph.compose(directed, undirected),
        (error) => {
          strictEqual(error instanceof Graph.GraphError, true)
          if (error instanceof Graph.GraphError) {
            strictEqual(error.message, "Cannot combine directed and undirected graphs")
          }
        }
      )
      throws(() => Graph.sum(directed, undirected), (error) => {
        strictEqual(error instanceof Graph.GraphError, true)
      })
    })

    it("matches undirected edges regardless of endpoint order", () => {
      const left = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "shared")
      })
      const right = Graph.undirected<string, string>((mutable) => {
        const b = Graph.addNode(mutable, "B")
        const a = Graph.addNode(mutable, "A")
        Graph.addEdge(mutable, b, a, "shared")
      })

      const options = { nodeIdentity: (node: string) => new SetNodeKey(node) }
      strictEqual(Graph.edgeCount(Graph.intersection(left, right, options)), 1)
      strictEqual(Graph.edgeCount(Graph.difference(left, right, options)), 0)
    })

    it("complement adds missing directed edges", () => {
      const graph = Graph.directed<SetNode, string>((mutable) => {
        const a = Graph.addNode(mutable, { id: "a", label: "A" })
        const b = Graph.addNode(mutable, { id: "b", label: "B" })
        const c = Graph.addNode(mutable, { id: "c", label: "C" })
        Graph.addEdge(mutable, a, b, "A-B")
        Graph.addEdge(mutable, b, c, "B-C")
      })

      const result = Graph.complement(graph, (source, target) => `${source.label}-${target.label}`)

      strictEqual(Graph.nodeCount(result), 3)
      strictEqual(Graph.edgeCount(result), 4)
      assert.deepStrictEqual(
        graphEdgeData(result),
        new Map([
          ["a->c", "A-C"],
          ["b->a", "B-A"],
          ["c->a", "C-A"],
          ["c->b", "C-B"]
        ])
      )
    })

    it("complement adds missing undirected edges once", () => {
      const graph = Graph.undirected<SetNode, string>((mutable) => {
        const a = Graph.addNode(mutable, { id: "A", label: "A" })
        const b = Graph.addNode(mutable, { id: "B", label: "B" })
        Graph.addNode(mutable, { id: "C", label: "C" })
        Graph.addEdge(mutable, a, b, "A-B")
      })

      const result = Graph.complement(graph, (source, target) => `${source.label}-${target.label}`)

      strictEqual(result.type, "undirected")
      strictEqual(Graph.edgeCount(result), 2)
      assert.deepStrictEqual(
        graphEdgeData(result),
        new Map([
          ["A--C", "A-C"],
          ["B--C", "B-C"]
        ])
      )
    })

    it("neighborhood returns the induced subgraph within radius", () => {
      const graph = Graph.directed<SetNode, string>((mutable) => {
        const a = Graph.addNode(mutable, { id: "A", label: "A" })
        const b = Graph.addNode(mutable, { id: "B", label: "B" })
        const c = Graph.addNode(mutable, { id: "C", label: "C" })
        const d = Graph.addNode(mutable, { id: "D", label: "D" })
        Graph.addEdge(mutable, a, b, "A-B")
        Graph.addEdge(mutable, b, c, "B-C")
        Graph.addEdge(mutable, c, d, "C-D")
        Graph.addEdge(mutable, c, b, "C-B")
      })

      const result = Graph.neighborhood(graph, 1, { radius: 1, direction: "outgoing" })

      assert.deepStrictEqual(graphNodeIds(result), new Set(["B", "C"]))
      assert.deepStrictEqual(graphEdgeKeys(result), new Set(["B->C", "C->B"]))
    })

    it("neighborhood follows outgoing edges by default", () => {
      const graph = Graph.directed<SetNode, string>((mutable) => {
        const a = Graph.addNode(mutable, { id: "A", label: "A" })
        const b = Graph.addNode(mutable, { id: "B", label: "B" })
        const c = Graph.addNode(mutable, { id: "C", label: "C" })
        Graph.addEdge(mutable, a, b, "A-B")
        Graph.addEdge(mutable, b, c, "B-C")
      })

      const result = Graph.neighborhood(graph, 1)

      assert.deepStrictEqual(graphNodeIds(result), new Set(["B", "C"]))
      assert.deepStrictEqual(graphEdgeKeys(result), new Set(["B->C"]))
    })

    it("neighborhood can ignore edge direction", () => {
      const graph = Graph.directed<SetNode, string>((mutable) => {
        const a = Graph.addNode(mutable, { id: "A", label: "A" })
        const b = Graph.addNode(mutable, { id: "B", label: "B" })
        const c = Graph.addNode(mutable, { id: "C", label: "C" })
        Graph.addEdge(mutable, a, b, "A-B")
        Graph.addEdge(mutable, a, c, "A-C")
      })

      const result = Graph.neighborhood(graph, 1, { radius: 2, direction: "undirected" })

      assert.deepStrictEqual(graphNodeIds(result), new Set(["A", "B", "C"]))
      assert.deepStrictEqual(graphEdgeKeys(result), new Set(["A->B", "A->C"]))
    })

    it("sum keeps equal nodes disjoint", () => {
      const left = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "left")
      })
      const right = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, "right")
      })

      const result = Graph.sum(left, right)

      strictEqual(Graph.nodeCount(result), 4)
      strictEqual(Graph.edgeCount(result), 2)
      assert.deepStrictEqual(Array.from(Graph.values(Graph.nodes(result))), ["A", "B", "A", "B"])
    })
  })

  it("toString", () => {
    const graph = Graph.directed<undefined, number>((mutable) => {
      const nodeA = Graph.addNode(mutable, undefined)
      const nodeB = Graph.addNode(mutable, undefined)
      Graph.addEdge(mutable, nodeA, nodeB, 1)
    })
    strictEqual(String(graph), "Graph(directed, 2, 1)")
  })

  describe("isGraph", () => {
    it("should return true for graph instances", () => {
      const directedGraph = Graph.directed<string, number>()
      const undirectedGraph = Graph.undirected<string, number>()

      strictEqual(Graph.isGraph(directedGraph), true)
      strictEqual(Graph.isGraph(undirectedGraph), true)
    })

    it("should return true for mutable graph instances", () => {
      const directedGraph = Graph.beginMutation(Graph.directed<string, number>())
      const undirectedGraph = Graph.beginMutation(Graph.undirected<string, number>())

      strictEqual(Graph.isGraph(directedGraph), true)
      strictEqual(Graph.isGraph(undirectedGraph), true)
    })

    it("should return false for non-graph values", () => {
      strictEqual(Graph.isGraph({}), false)
      strictEqual(Graph.isGraph(null), false)
      strictEqual(Graph.isGraph(undefined), false)
      strictEqual(Graph.isGraph("string"), false)
      strictEqual(Graph.isGraph(42), false)
      strictEqual(Graph.isGraph([]), false)
    })

    it("should be iterable using for...of syntax", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
        Graph.addNode(mutable, "Node B")
        Graph.addNode(mutable, "Node C")
      })

      const collected: Array<readonly [number, string]> = []
      for (const entry of graph) {
        collected.push(entry)
      }

      expect(collected).toHaveLength(3)
      expect(collected).toEqual([
        [0, "Node A"],
        [1, "Node B"],
        [2, "Node C"]
      ])
    })

    it("should support manual iterator operations", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
        Graph.addNode(mutable, "Node B")
      })

      const iterator = graph[Symbol.iterator]()
      const first = iterator.next()
      const second = iterator.next()
      const third = iterator.next()

      expect(first.done).toBe(false)
      expect(first.value).toEqual([0, "Node A"])
      expect(second.done).toBe(false)
      expect(second.value).toEqual([1, "Node B"])
      expect(third.done).toBe(true)
    })
  })

  describe("undefined data handling", () => {
    describe("undefined node data", () => {
      it("should allow adding nodes with undefined data", () => {
        const graph = Graph.directed<undefined, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, undefined)
          const nodeB = Graph.addNode(mutable, undefined)
          Graph.addEdge(mutable, nodeA, nodeB, 1)
        })

        expect(Graph.nodeCount(graph)).toBe(2)
        expect(Graph.edgeCount(graph)).toBe(1)
        expect(Graph.getNode(graph, 0)).toEqual(Option.some(undefined))
        expect(Graph.getNode(graph, 1)).toEqual(Option.some(undefined))
      })

      it("should correctly update nodes with undefined data", () => {
        const graph = Graph.directed<undefined | string, number>((mutable) => {
          Graph.addNode(mutable, undefined)
          Graph.addNode(mutable, "defined")
        })

        const updated = Graph.mutate(graph, (mutable) => {
          Graph.updateNode(mutable, 0, () => "now defined")
          Graph.updateNode(mutable, 1, () => undefined)
        })

        expect(Graph.getNode(updated, 0)).toEqual(Option.some("now defined"))
        expect(Graph.getNode(updated, 1)).toEqual(Option.some(undefined))
      })

      it("should correctly compare graphs with undefined node data", () => {
        const graph1 = Graph.directed<undefined, number>((mutable) => {
          Graph.addNode(mutable, undefined)
          Graph.addNode(mutable, undefined)
        })

        const graph2 = Graph.directed<undefined, number>((mutable) => {
          Graph.addNode(mutable, undefined)
          Graph.addNode(mutable, undefined)
        })

        expect(Equal.equals(graph1, graph2)).toBe(true)
      })

      it("should find nodes with undefined data using predicates", () => {
        const graph = Graph.directed<undefined | string, number>((mutable) => {
          Graph.addNode(mutable, undefined)
          Graph.addNode(mutable, "defined")
          Graph.addNode(mutable, undefined)
        })

        const undefinedNode = Graph.findNode(graph, (data) => data === undefined)
        const undefinedNodes = Graph.findNodes(graph, (data) => data === undefined)

        expect(undefinedNode).toEqual(Option.some(0))
        expect(undefinedNodes).toEqual([0, 2])
      })

      it("should iterate correctly over graphs with undefined node data", () => {
        const graph = Graph.directed<undefined, number>((mutable) => {
          Graph.addNode(mutable, undefined)
          Graph.addNode(mutable, undefined)
        })

        const collected: Array<readonly [number, undefined]> = []
        for (const entry of graph) {
          collected.push(entry)
        }

        expect(collected).toEqual([
          [0, undefined],
          [1, undefined]
        ])
      })
    })

    describe("undefined edge data", () => {
      it("should allow adding edges with undefined data", () => {
        const graph = Graph.directed<string, undefined>((mutable) => {
          const nodeA = Graph.addNode(mutable, "A")
          const nodeB = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, nodeA, nodeB, undefined)
        })

        expect(Graph.edgeCount(graph)).toBe(1)
        expect(Graph.getEdge(graph, 0)).toEqual(Option.some(new Graph.Edge({ source: 0, target: 1, data: undefined })))
      })

      it("should correctly update edges with undefined data", () => {
        const graph = Graph.directed<string, undefined | number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "A")
          const nodeB = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, nodeA, nodeB, undefined)
          Graph.addEdge(mutable, nodeB, nodeA, 42)
        })

        const updated = Graph.mutate(graph, (mutable) => {
          Graph.updateEdge(mutable, 0, () => 100)
          Graph.updateEdge(mutable, 1, () => undefined)
        })

        const edge0 = Graph.getEdge(updated, 0)
        const edge1 = Graph.getEdge(updated, 1)

        expect(edge0).toEqual(Option.some(new Graph.Edge({ source: 0, target: 1, data: 100 })))
        expect(edge1).toEqual(Option.some(new Graph.Edge({ source: 1, target: 0, data: undefined })))
      })

      it("should correctly compare graphs with undefined edge data", () => {
        const graph1 = Graph.directed<string, undefined>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, a, b, undefined)
        })

        const graph2 = Graph.directed<string, undefined>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, a, b, undefined)
        })

        expect(Equal.equals(graph1, graph2)).toBe(true)
      })

      it("should find edges with undefined data using predicates", () => {
        const graph = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, undefined)
          Graph.addEdge(mutable, b, c, 42)
          Graph.addEdge(mutable, c, a, undefined)
        })

        const undefinedEdge = Graph.findEdge(graph, (data) => data === undefined)
        const undefinedEdges = Graph.findEdges(graph, (data) => data === undefined)

        expect(undefinedEdge).toEqual(Option.some(0))
        expect(undefinedEdges).toEqual([0, 2])
      })

      it("should produce consistent hashes for graphs with undefined edge data", () => {
        const graph1 = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, undefined)
          Graph.addEdge(mutable, b, c, 42)
        })

        const graph2 = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, undefined)
          Graph.addEdge(mutable, b, c, 42)
        })

        // Graphs with identical structure should have the same hash
        expect(Hash.hash(graph1)).toBe(Hash.hash(graph2))

        // Graph with different edge data should have different hash
        const graph3 = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, 100) // Different data
          Graph.addEdge(mutable, b, c, 42)
        })

        expect(Hash.hash(graph1)).not.toBe(Hash.hash(graph3))
      })

      it("should correctly handle Equal.equals with graphs containing undefined edge data", () => {
        const graph1 = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, a, b, undefined)
        })

        const graph2 = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, a, b, undefined)
        })

        const graph3 = Graph.directed<string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, a, b, 42)
        })

        // Equal graphs with undefined edge data should be equal
        expect(Equal.equals(graph1, graph2)).toBe(true)

        // Graphs with different edge data should not be equal
        expect(Equal.equals(graph1, graph3)).toBe(false)
      })
    })

    describe("mixed undefined scenarios", () => {
      it("should handle graphs with both undefined nodes and edges", () => {
        const graph = Graph.directed<undefined, undefined>((mutable) => {
          const nodeA = Graph.addNode(mutable, undefined)
          const nodeB = Graph.addNode(mutable, undefined)
          Graph.addEdge(mutable, nodeA, nodeB, undefined)
        })

        expect(Graph.nodeCount(graph)).toBe(2)
        expect(Graph.edgeCount(graph)).toBe(1)
        expect(Graph.getNode(graph, 0)).toEqual(Option.some(undefined))
        expect(Graph.getEdge(graph, 0)).toEqual(Option.some(new Graph.Edge({ source: 0, target: 1, data: undefined })))
      })

      it("should correctly handle graph operations with mixed undefined data", () => {
        const graph = Graph.directed<undefined | string, undefined | number>((mutable) => {
          const a = Graph.addNode(mutable, undefined)
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, undefined)
          Graph.addEdge(mutable, a, b, undefined)
          Graph.addEdge(mutable, b, c, 42)
          Graph.addEdge(mutable, c, a, undefined)
        })

        // Test neighbors
        const neighborsOfA = Graph.neighbors(graph, 0)
        const neighborsOfB = Graph.neighbors(graph, 1)

        expect(neighborsOfA).toEqual([1])
        expect(neighborsOfB).toEqual([2])

        // Test filtering
        const nodesWithUndefined = Graph.findNodes(graph, (data) => data === undefined)
        const edgesWithUndefined = Graph.findEdges(graph, (data) => data === undefined)

        expect(nodesWithUndefined).toEqual([0, 2])
        expect(edgesWithUndefined).toEqual([0, 2])
      })
    })
  })

  describe("beginMutation", () => {
    it("should create a mutable graph from an immutable graph", () => {
      const graph = Graph.directed<string, number>()
      const mutable = Graph.beginMutation(graph)

      expect(mutable.type).toBe("directed")
      expect(Graph.nodeCount(mutable)).toBe(Graph.nodeCount(graph))
      expect(Graph.edgeCount(mutable)).toBe(Graph.edgeCount(graph))
    })
  })

  describe("endMutation", () => {
    it("should convert a mutable graph back to immutable", () => {
      const graph = Graph.directed<string, number>()
      const mutable = Graph.beginMutation(graph)
      const result = Graph.endMutation(mutable)

      expect(result.type).toBe("directed")
      expect(Graph.nodeCount(result)).toBe(Graph.nodeCount(mutable))
      expect(Graph.edgeCount(result)).toBe(Graph.edgeCount(mutable))
    })

    it("should reject mutations on a finalized mutable graph", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let edgeIndex: Graph.EdgeIndex
      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
        nodeB = Graph.addNode(mutable, "B")
        edgeIndex = Graph.addEdge(mutable, nodeA, nodeB, 1)
      })

      const mutable = Graph.beginMutation(graph)
      const result = Graph.endMutation(mutable)

      throws(
        () => Graph.removeEdge(mutable, edgeIndex!),
        (error) => {
          strictEqual(error instanceof Graph.GraphError, true)
          if (error instanceof Graph.GraphError) {
            strictEqual(error.message, "Graph is not mutable")
          }
        }
      )
      strictEqual(Graph.hasEdge(result, nodeA!, nodeB!), true)
      assert.deepStrictEqual(Graph.neighbors(result, nodeA!), [nodeB!])
      assert.deepStrictEqual(Graph.predecessors(result, nodeB!), [nodeA!])
    })
  })

  describe("mutate", () => {
    it("should create a new graph instance", () => {
      const graph = Graph.directed<string, number>()

      const result = Graph.mutate(graph, () => {
        // No mutations performed
      })

      expect(result).not.toBe(graph)
      expect(Equal.equals(result, graph)).toBe(true) // Structural equality
    })

    it("should handle empty mutation function", () => {
      const graph = Graph.directed<string, number>()

      const result = Graph.mutate(graph, () => {
        // Do nothing
      })

      expect(Graph.nodeCount(result)).toBe(0)
      expect(Graph.edgeCount(result)).toBe(0)
    })

    it("should finalize the mutable graph when the callback throws", () => {
      let mutable: Graph.MutableDirectedGraph<string, number> | undefined
      const error = new Error("boom")

      throws(
        () =>
          Graph.mutate(Graph.directed<string, number>(), (graph) => {
            mutable = graph
            throw error
          }),
        (cause) => {
          strictEqual(cause, error)
        }
      )
      assertGraphError(() => Graph.addNode(mutable!, "late"), "Graph is not mutable")
    })
  })

  describe("addNode", () => {
    it("should add a node to a mutable graph and return its index", () => {
      const graph = Graph.directed<string, number>()
      let nodeIndex: Graph.NodeIndex

      const result = Graph.mutate(graph, (mutable) => {
        nodeIndex = Graph.addNode(mutable, "Node A")
      })

      expect(Graph.nodeCount(result)).toBe(1)
      expect(Graph.getNode(result, nodeIndex!)).toEqual(Option.some("Node A"))
    })
  })

  describe("getNode", () => {
    it("should return the node data for existing nodes", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "Node A")
        nodeB = Graph.addNode(mutable, "Node B")
      })

      expect(Graph.getNode(graph, nodeA!)).toEqual(Option.some("Node A"))
      expect(Graph.getNode(graph, nodeB!)).toEqual(Option.some("Node B"))
    })

    it("should return None for non-existent nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
      })

      const nonExistent = Graph.getNode(graph, 999)
      expect(Option.isNone(nonExistent)).toBe(true)
    })
  })

  describe("hasNode", () => {
    it("should return true for existing nodes", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "Node A")
        nodeB = Graph.addNode(mutable, "Node B")
      })

      expect(Graph.hasNode(graph, nodeA!)).toBe(true)
      expect(Graph.hasNode(graph, nodeB!)).toBe(true)
    })

    it("should return false for non-existent nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
      })

      expect(Graph.hasNode(graph, 999)).toBe(false)
      expect(Graph.hasNode(graph, -1)).toBe(false)
    })
  })

  describe("nodeCount", () => {
    it("should return 0 for empty graph", () => {
      const graph = Graph.directed<string, number>()
      expect(Graph.nodeCount(graph)).toBe(0)
    })

    it("should return correct count after adding nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        expect(Graph.nodeCount(mutable)).toBe(0)
        Graph.addNode(mutable, "Node A")
        expect(Graph.nodeCount(mutable)).toBe(1)
        Graph.addNode(mutable, "Node B")
        expect(Graph.nodeCount(mutable)).toBe(2)
        Graph.addNode(mutable, "Node C")
        expect(Graph.nodeCount(mutable)).toBe(3)
      })

      expect(Graph.nodeCount(graph)).toBe(3)
    })
  })

  describe("findNode", () => {
    it("should find node by predicate", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
        Graph.addNode(mutable, "Node B")
        Graph.addNode(mutable, "Node C")
      })

      const result = Graph.findNode(graph, (data) => data === "Node B")
      expect(result).toEqual(Option.some(1))
    })

    it("should return None when no node matches", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
        Graph.addNode(mutable, "Node B")
      })

      const result = Graph.findNode(graph, (data) => data === "Node C")
      expect(result).toEqual(Option.none())
    })

    it("should find first matching node when multiple match", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Start A")
        Graph.addNode(mutable, "Start B")
        Graph.addNode(mutable, "Start C")
      })

      const result = Graph.findNode(graph, (data) => data.startsWith("Start"))
      expect(result).toEqual(Option.some(0))
    })
  })

  describe("findNodes", () => {
    it("should find all matching nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Start A")
        Graph.addNode(mutable, "Node B")
        Graph.addNode(mutable, "Start C")
        Graph.addNode(mutable, "Start D")
      })

      const result = Graph.findNodes(graph, (data) => data.startsWith("Start"))
      expect(result).toEqual([0, 2, 3])
    })
  })

  describe("findEdge", () => {
    it("should find edge by predicate", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")
        Graph.addEdge(mutable, nodeA, nodeB, 10)
        Graph.addEdge(mutable, nodeB, nodeC, 20)
      })

      const result = Graph.findEdge(graph, (data) => data === 20)
      expect(result).toEqual(Option.some(1))
    })

    it("should return None when no edge matches", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        Graph.addEdge(mutable, nodeA, nodeB, 10)
      })

      const result = Graph.findEdge(graph, (data) => data === 99)
      expect(result).toEqual(Option.none())
    })

    it("should find first matching edge when multiple match", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")
        Graph.addEdge(mutable, nodeA, nodeB, 15)
        Graph.addEdge(mutable, nodeB, nodeC, 25)
        Graph.addEdge(mutable, nodeC, nodeA, 35)
      })

      const result = Graph.findEdge(graph, (data) => data > 20)
      expect(result).toEqual(Option.some(1))
    })
  })

  describe("findEdges", () => {
    it("should find all matching edges", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")
        Graph.addEdge(mutable, nodeA, nodeB, 10)
        Graph.addEdge(mutable, nodeB, nodeC, 20)
        Graph.addEdge(mutable, nodeC, nodeA, 30)
        Graph.addEdge(mutable, nodeA, nodeC, 25)
      })

      const result = Graph.findEdges(graph, (data) => data >= 20)
      expect(result).toEqual([1, 2, 3])
    })
  })

  describe("updateNode", () => {
    it("should update node data", () => {
      const updated = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
        Graph.addNode(mutable, "Node B")
        Graph.updateNode(mutable, 0, (data) => data.toUpperCase())
      })

      const nodeData = Graph.getNode(updated, 0)
      assertSome(nodeData, "NODE A")
    })

    it("should do nothing if node doesn't exist", () => {
      let nodeA: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "Node A")
        Graph.updateNode(mutable, 999, (data) => data.toUpperCase())
      })

      // Original node should be unchanged
      const nodeData = Graph.getNode(graph, nodeA!)
      assertSome(nodeData, "Node A")
    })
  })

  describe("updateEdge", () => {
    it("should update edge data", () => {
      const result = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const edgeIndex = Graph.addEdge(mutable, nodeA, nodeB, 10)
        Graph.updateEdge(mutable, edgeIndex, (data) => data * 2)
      })

      const edge = Graph.getEdge(result, 0)
      assertSome(edge, new Graph.Edge({ source: 0, target: 1, data: 20 }))
    })

    it("should do nothing if edge doesn't exist", () => {
      Graph.mutate(Graph.directed<string, number>(), (mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const edgeIndex = Graph.addEdge(mutable, nodeA, nodeB, 10)

        // Try to update non-existent edge
        Graph.updateEdge(mutable, 999, (data) => data * 2)

        // Original edge should be unchanged
        const edge = Graph.getEdge(mutable, edgeIndex)
        assertSome(edge, new Graph.Edge({ source: 0, target: 1, data: 10 }))
      })
    })
  })

  describe("mapNodes", () => {
    it("should transform all node data", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let nodeC: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "node a")
        nodeB = Graph.addNode(mutable, "node b")
        nodeC = Graph.addNode(mutable, "node c")
        Graph.mapNodes(mutable, (data) => data.toUpperCase())
      })

      expect(Graph.getNode(graph, nodeA!)).toEqual(Option.some("NODE A"))
      expect(Graph.getNode(graph, nodeB!)).toEqual(Option.some("NODE B"))
      expect(Graph.getNode(graph, nodeC!)).toEqual(Option.some("NODE C"))
    })

    it("should apply transformation to all nodes", () => {
      let firstNode: Graph.NodeIndex
      let secondNode: Graph.NodeIndex
      let thirdNode: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        firstNode = Graph.addNode(mutable, "first")
        secondNode = Graph.addNode(mutable, "second")
        thirdNode = Graph.addNode(mutable, "third")
        Graph.mapNodes(mutable, (data) => data + " (transformed)")
      })

      const node0 = Graph.getNode(graph, firstNode!)
      const node1 = Graph.getNode(graph, secondNode!)
      const node2 = Graph.getNode(graph, thirdNode!)

      assertSome(node0, "first (transformed)")
      assertSome(node1, "second (transformed)")
      assertSome(node2, "third (transformed)")
    })

    it("should modify graph in place during construction", () => {
      let originalNode: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        originalNode = Graph.addNode(mutable, "original")
        // Before transformation
        const beforeData = Graph.getNode(mutable, originalNode!)
        assertSome(beforeData, "original")

        // Apply transformation
        Graph.mapNodes(mutable, (data) => data.toUpperCase())
      })

      // After transformation
      const afterData = Graph.getNode(graph, originalNode!)
      assertSome(afterData, "ORIGINAL")
    })
  })

  describe("mapEdges", () => {
    it("should transform all edge data", () => {
      let edgeAB: Graph.EdgeIndex
      let edgeBC: Graph.EdgeIndex
      let edgeCA: Graph.EdgeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        edgeAB = Graph.addEdge(mutable, a, b, 10)
        edgeBC = Graph.addEdge(mutable, b, c, 20)
        edgeCA = Graph.addEdge(mutable, c, a, 30)
        Graph.mapEdges(mutable, (data) => data * 2)
      })

      const edge0 = Graph.getEdge(graph, edgeAB!)
      const edge1 = Graph.getEdge(graph, edgeBC!)
      const edge2 = Graph.getEdge(graph, edgeCA!)

      assertSome(edge0, new Graph.Edge({ source: 0, target: 1, data: 20 }))
      assertSome(edge1, new Graph.Edge({ source: 1, target: 2, data: 40 }))
      assertSome(edge2, new Graph.Edge({ source: 2, target: 0, data: 60 }))
      strictEqual(edge0.value instanceof Graph.Edge, true)
      strictEqual(edge1.value instanceof Graph.Edge, true)
      strictEqual(edge2.value instanceof Graph.Edge, true)

      const expected = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 20)
        Graph.addEdge(mutable, b, c, 40)
        Graph.addEdge(mutable, c, a, 60)
      })

      strictEqual(Equal.equals(graph, expected), true)
    })

    it("should modify graph in place during construction", () => {
      let edgeAB: Graph.EdgeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        edgeAB = Graph.addEdge(mutable, a, b, 10)

        // Before transformation
        const beforeData = Graph.getEdge(mutable, edgeAB!)
        assertSome(beforeData, new Graph.Edge({ source: 0, target: 1, data: 10 }))

        // Apply transformation
        Graph.mapEdges(mutable, (data) => data * 5)
      })

      // After transformation
      const afterData = Graph.getEdge(graph, edgeAB!)
      expect(assertSomeEdge(afterData).data).toBe(50)
    })
  })

  describe("reverse", () => {
    it("should reverse all edge directions", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let nodeC: Graph.NodeIndex
      let edgeAB: Graph.EdgeIndex
      let edgeBC: Graph.EdgeIndex
      let edgeCA: Graph.EdgeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
        nodeB = Graph.addNode(mutable, "B")
        nodeC = Graph.addNode(mutable, "C")
        edgeAB = Graph.addEdge(mutable, nodeA, nodeB, 1) // A -> B
        edgeBC = Graph.addEdge(mutable, nodeB, nodeC, 2) // B -> C
        edgeCA = Graph.addEdge(mutable, nodeC, nodeA, 3) // C -> A
        Graph.reverse(mutable) // Now B -> A, C -> B, A -> C
      })

      const edge0 = Graph.getEdge(graph, edgeAB!)
      const edge1 = Graph.getEdge(graph, edgeBC!)
      const edge2 = Graph.getEdge(graph, edgeCA!)

      assertSome(edge0, new Graph.Edge({ source: nodeB!, target: nodeA!, data: 1 }))
      assertSome(edge1, new Graph.Edge({ source: nodeC!, target: nodeB!, data: 2 }))
      assertSome(edge2, new Graph.Edge({ source: nodeA!, target: nodeC!, data: 3 }))
    })

    it("should update adjacency lists correctly", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1) // A -> B
        Graph.addEdge(mutable, a, c, 2) // A -> C
        Graph.reverse(mutable) // Now B -> A, C -> A
      })

      // After reversal:
      // - Node A should have no outgoing edges
      // - Node B should have edge to A
      // - Node C should have edge to A

      const neighborsA = Graph.neighbors(graph, 0)
      const neighborsB = Graph.neighbors(graph, 1)
      const neighborsC = Graph.neighbors(graph, 2)

      expect(Array.from(neighborsA)).toEqual([]) // A has no outgoing edges
      expect(Array.from(neighborsB)).toEqual([0]) // B -> A
      expect(Array.from(neighborsC)).toEqual([0]) // C -> A
    })

    it("should preserve adjacency lists when adding edges after reversal", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")

        Graph.addEdge(mutable, a, b, 1)
        Graph.reverse(mutable)
        Graph.addEdge(mutable, a, b, 2)
      })

      expect(Graph.edgeCount(graph)).toBe(2)
      expect(Graph.neighbors(graph, 0)).toEqual([1])
      expect(Graph.hasEdge(graph, 0, 1)).toBe(true)
      expect(Graph.hasEdge(graph, 1, 0)).toBe(true)
    })

    it("should be a no-op for undirected graphs", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")

        Graph.addEdge(mutable, a, b, 1)
        Graph.reverse(mutable)
      })

      expect(Graph.neighbors(graph, 0)).toEqual([1])
      expect(Graph.neighbors(graph, 1)).toEqual([0])
      expect(Graph.hasEdge(graph, 0, 1)).toBe(true)
      expect(Graph.hasEdge(graph, 1, 0)).toBe(true)
    })
  })

  describe("filterMapNodes", () => {
    it("should filter and transform nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "active")
        Graph.addNode(mutable, "inactive")
        Graph.addNode(mutable, "active")
        Graph.addNode(mutable, "pending")

        // Keep only "active" nodes and transform to uppercase
        Graph.filterMapNodes(mutable, (data) => data === "active" ? Option.some(data.toUpperCase()) : Option.none())
      })

      // Should only have 2 nodes remaining (the "active" ones)
      expect(Graph.nodeCount(graph)).toBe(2)

      // Check the remaining nodes have been transformed
      const nodeData0 = Graph.getNode(graph, 0)
      const nodeData2 = Graph.getNode(graph, 2)

      expect(Option.isSome(nodeData0)).toBe(true)
      expect(Option.isSome(nodeData2)).toBe(true)

      if (Option.isSome(nodeData0) && Option.isSome(nodeData2)) {
        expect(nodeData0.value).toBe("ACTIVE")
        expect(nodeData2.value).toBe("ACTIVE")
      }

      // Filtered out nodes should not exist
      expect(Option.isNone(Graph.getNode(graph, 1))).toBe(true)
      expect(Option.isNone(Graph.getNode(graph, 3))).toBe(true)
    })

    it("should remove edges connected to filtered nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "keep")
        const b = Graph.addNode(mutable, "remove")
        const c = Graph.addNode(mutable, "keep")

        Graph.addEdge(mutable, a, b, 1) // keep -> remove
        Graph.addEdge(mutable, b, c, 2) // remove -> keep
        Graph.addEdge(mutable, a, c, 3) // keep -> keep

        // Filter out "remove" nodes
        Graph.filterMapNodes(mutable, (data) => data === "keep" ? Option.some(data) : Option.none())
      })

      // Should have 2 nodes and 1 edge remaining
      expect(Graph.nodeCount(graph)).toBe(2)
      expect(Graph.edgeCount(graph)).toBe(1)

      // Only the keep -> keep edge should remain
      const remainingEdge = Graph.getEdge(graph, 2)
      assertSome(remainingEdge, new Graph.Edge({ source: 0, target: 2, data: 3 }))

      // Edges involving removed node should be gone
      expect(Graph.getEdge(graph, 0)).toEqual(Option.none())
      expect(Graph.getEdge(graph, 1)).toEqual(Option.none())
    })

    it("should handle transformation without filtering", () => {
      const graph = Graph.directed<number, string>((mutable) => {
        Graph.addNode(mutable, 1)
        Graph.addNode(mutable, 2)
        Graph.addNode(mutable, 3)

        // Transform all nodes by doubling them
        Graph.filterMapNodes(mutable, (data) => Option.some(data * 2))
      })

      expect(Graph.nodeCount(graph)).toBe(3)

      const node0 = Graph.getNode(graph, 0)
      const node1 = Graph.getNode(graph, 1)
      const node2 = Graph.getNode(graph, 2)

      assertSome(node0, 2)
      assertSome(node1, 4)
      assertSome(node2, 6)
    })

    it("should handle filtering without transformation", () => {
      const graph = Graph.directed<number, string>((mutable) => {
        Graph.addNode(mutable, 1)
        Graph.addNode(mutable, 2)
        Graph.addNode(mutable, 3)
        Graph.addNode(mutable, 4)

        // Keep only even numbers
        Graph.filterMapNodes(mutable, (data) => data % 2 === 0 ? Option.some(data) : Option.none())
      })

      expect(Graph.nodeCount(graph)).toBe(2)

      const node1 = Graph.getNode(graph, 1)
      const node3 = Graph.getNode(graph, 3)

      assertSome(node1, 2)
      assertSome(node3, 4)

      // Odd numbers should be removed
      assertNone(Graph.getNode(graph, 0))
      assertNone(Graph.getNode(graph, 2))
    })
  })

  describe("filterMapEdges", () => {
    it("should filter and transform edges", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 5) // Remove (< 10)
        Graph.addEdge(mutable, b, c, 15) // Keep and double (30)
        Graph.addEdge(mutable, c, a, 25) // Keep and double (50)

        // Keep only edges with weight >= 10 and double their weight
        Graph.filterMapEdges(mutable, (data) => data >= 10 ? Option.some(data * 2) : Option.none())
      })

      // Should have 2 edges remaining
      expect(Graph.edgeCount(graph)).toBe(2)
      expect(Graph.nodeCount(graph)).toBe(3) // All nodes should remain

      // Check that remaining edges have been transformed
      const edge1 = Graph.getEdge(graph, 1)
      const edge2 = Graph.getEdge(graph, 2)

      assertSome(edge1, new Graph.Edge({ source: 1, target: 2, data: 30 })) // 15 * 2
      assertSome(edge2, new Graph.Edge({ source: 2, target: 0, data: 50 })) // 25 * 2
      strictEqual(edge1.value instanceof Graph.Edge, true)
      strictEqual(edge2.value instanceof Graph.Edge, true)

      // Filtered out edge should not exist
      expect(Graph.getEdge(graph, 0)).toEqual(Option.none())

      const expected = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const removed = Graph.addEdge(mutable, a, b, 5)
        Graph.addEdge(mutable, b, c, 30)
        Graph.addEdge(mutable, c, a, 50)
        Graph.removeEdge(mutable, removed)
      })

      strictEqual(Equal.equals(graph, expected), true)
    })

    it("should update adjacency lists when removing edges", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")

        Graph.addEdge(mutable, a, b, 1) // Keep
        Graph.addEdge(mutable, a, c, 2) // Remove
        Graph.addEdge(mutable, b, c, 3) // Keep

        // Keep only odd numbers
        Graph.filterMapEdges(mutable, (data) => data % 2 === 1 ? Option.some(data) : Option.none())
      })

      // Should have 2 edges remaining (1 and 3)
      expect(Graph.edgeCount(graph)).toBe(2)

      // Check adjacency: A should only connect to B now
      const neighborsA = Array.from(Graph.neighbors(graph, 0))
      expect(neighborsA).toEqual([1]) // A -> B only

      // Check that B still connects to C
      const neighborsB = Array.from(Graph.neighbors(graph, 1))
      expect(neighborsB).toEqual([2]) // B -> C

      // Check that C has no outgoing edges
      const neighborsC = Array.from(Graph.neighbors(graph, 2))
      expect(neighborsC).toEqual([]) // C has no outgoing edges
    })

    it("should handle transformation without filtering", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 10)
        Graph.addEdge(mutable, b, c, 20)
        Graph.addEdge(mutable, c, a, 30)

        // Transform all edges by adding 100
        Graph.filterMapEdges(mutable, (data) => Option.some(data + 100))
      })

      expect(Graph.edgeCount(graph)).toBe(3)

      const edge0 = Graph.getEdge(graph, 0)
      const edge1 = Graph.getEdge(graph, 1)
      const edge2 = Graph.getEdge(graph, 2)

      expect(assertSomeEdge(edge0).data).toBe(110)
      expect(assertSomeEdge(edge1).data).toBe(120)
      expect(assertSomeEdge(edge2).data).toBe(130)
    })

    it("should handle filtering without transformation", () => {
      const graph = Graph.directed<string, { weight: number; type: string }>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, { weight: 10, type: "primary" })
        Graph.addEdge(mutable, b, c, { weight: 20, type: "secondary" })
        Graph.addEdge(mutable, c, a, { weight: 30, type: "primary" })

        // Keep only "primary" edges
        Graph.filterMapEdges(mutable, (data) => data.type === "primary" ? Option.some(data) : Option.none())
      })

      expect(Graph.edgeCount(graph)).toBe(2)

      const edge0 = Graph.getEdge(graph, 0)
      const edge2 = Graph.getEdge(graph, 2)

      expect(assertSomeEdge(edge0).data.type).toBe("primary")
      expect(assertSomeEdge(edge2).data.type).toBe("primary")

      // Secondary edge should be removed
      expect(Graph.getEdge(graph, 1)).toEqual(Option.none())
    })
  })

  describe("filterNodes", () => {
    it("should filter nodes by predicate", () => {
      let activeNode1: Graph.NodeIndex
      let inactiveNode: Graph.NodeIndex
      let activeNode2: Graph.NodeIndex
      let pendingNode: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        activeNode1 = Graph.addNode(mutable, "active")
        inactiveNode = Graph.addNode(mutable, "inactive")
        activeNode2 = Graph.addNode(mutable, "active")
        pendingNode = Graph.addNode(mutable, "pending")

        // Keep only "active" nodes
        Graph.filterNodes(mutable, (data) => data === "active")
      })

      expect(Graph.nodeCount(graph)).toBe(2)

      const node0 = Graph.getNode(graph, activeNode1!)
      const node2 = Graph.getNode(graph, activeNode2!)

      assertSome(node0, "active")
      assertSome(node2, "active")

      // Filtered out nodes should be removed
      assertNone(Graph.getNode(graph, inactiveNode!))
      assertNone(Graph.getNode(graph, pendingNode!))
    })

    it("should remove connected edges when filtering nodes", () => {
      let edgeAB: Graph.EdgeIndex
      let edgeBC: Graph.EdgeIndex
      let edgeAC: Graph.EdgeIndex

      const graph = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "keep")
        const b = Graph.addNode(mutable, "remove")
        const c = Graph.addNode(mutable, "keep")

        edgeAB = Graph.addEdge(mutable, a, b, "A-B")
        edgeBC = Graph.addEdge(mutable, b, c, "B-C")
        edgeAC = Graph.addEdge(mutable, a, c, "A-C")

        // Remove node "remove"
        Graph.filterNodes(mutable, (data) => data === "keep")
      })

      expect(Graph.nodeCount(graph)).toBe(2) // Only "keep" nodes remain
      expect(Graph.edgeCount(graph)).toBe(1) // Only A-C edge remains

      // Check remaining edge
      const edge2 = Graph.getEdge(graph, edgeAC!)
      assertSome(edge2, new Graph.Edge({ source: 0, target: 2, data: "A-C" }))

      // Check removed edges
      expect(Graph.getEdge(graph, edgeAB!)).toEqual(Option.none()) // A-B removed
      expect(Graph.getEdge(graph, edgeBC!)).toEqual(Option.none()) // B-C removed
    })
  })

  describe("filterEdges", () => {
    it("should filter edges by predicate", () => {
      let edgeAB: Graph.EdgeIndex
      let edgeBC: Graph.EdgeIndex
      let edgeCA: Graph.EdgeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")

        edgeAB = Graph.addEdge(mutable, a, b, 5)
        edgeBC = Graph.addEdge(mutable, b, c, 15)
        edgeCA = Graph.addEdge(mutable, c, a, 25)

        // Keep only edges with weight >= 10
        Graph.filterEdges(mutable, (data) => data >= 10)
      })

      expect(Graph.nodeCount(graph)).toBe(3) // All nodes remain
      expect(Graph.edgeCount(graph)).toBe(2) // Edge with weight 5 removed

      const edge1 = Graph.getEdge(graph, edgeBC!)
      const edge2 = Graph.getEdge(graph, edgeCA!)

      assertSome(edge1, new Graph.Edge({ source: 1, target: 2, data: 15 }))
      assertSome(edge2, new Graph.Edge({ source: 2, target: 0, data: 25 }))

      // Edge with weight 5 should be removed
      expect(Graph.getEdge(graph, edgeAB!)).toEqual(Option.none())
    })

    it("should update adjacency lists when filtering edges", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let nodeC: Graph.NodeIndex

      const graph = Graph.directed<string, string>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
        nodeB = Graph.addNode(mutable, "B")
        nodeC = Graph.addNode(mutable, "C")

        Graph.addEdge(mutable, nodeA, nodeB, "primary")
        Graph.addEdge(mutable, nodeA, nodeC, "secondary")
        Graph.addEdge(mutable, nodeB, nodeC, "primary")

        // Keep only "primary" edges
        Graph.filterEdges(mutable, (data) => data === "primary")
      })

      expect(Graph.edgeCount(graph)).toBe(2)

      // Check adjacency - A should only connect to B now
      const neighborsA = Array.from(Graph.neighbors(graph, nodeA!))
      expect(neighborsA).toEqual([nodeB!]) // A -> B only

      const neighborsB = Array.from(Graph.neighbors(graph, nodeB!))
      expect(neighborsB).toEqual([nodeC!]) // B -> C

      const neighborsC = Array.from(Graph.neighbors(graph, nodeC!))
      expect(neighborsC).toEqual([]) // C has no outgoing edges
    })
  })

  describe("addEdge", () => {
    it("should add an edge between two existing nodes", () => {
      let edgeIndex: Graph.EdgeIndex

      const result = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        edgeIndex = Graph.addEdge(mutable, nodeA, nodeB, 42)
      })

      expect(edgeIndex!).toBe(0)
      expect(Graph.edgeCount(result)).toBe(1)
    })

    it("should add multiple edges with sequential indices", () => {
      let edgeA: Graph.EdgeIndex
      let edgeB: Graph.EdgeIndex
      let edgeC: Graph.EdgeIndex

      const result = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")

        edgeA = Graph.addEdge(mutable, nodeA, nodeB, 10)
        edgeB = Graph.addEdge(mutable, nodeB, nodeC, 20)
        edgeC = Graph.addEdge(mutable, nodeA, nodeC, 30)
      })

      expect(edgeA!).toBe(0)
      expect(edgeB!).toBe(1)
      expect(edgeC!).toBe(2)
      expect(Graph.edgeCount(result)).toBe(3)
    })

    it("should throw error when source node doesn't exist", () => {
      expect(() => {
        Graph.directed<string, number>((mutable) => {
          const nodeB = Graph.addNode(mutable, "Node B")
          const nonExistentNode = 999
          Graph.addEdge(mutable, nonExistentNode, nodeB, 42)
        })
      }).toThrow("Node 999 does not exist")
    })

    it("should throw error when target node doesn't exist", () => {
      expect(() => {
        Graph.directed<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nonExistentNode = 999
          Graph.addEdge(mutable, nodeA, nonExistentNode, 42)
        })
      }).toThrow("Node 999 does not exist")
    })
  })

  describe("removeNode", () => {
    it("should remove a node and all its incident edges", () => {
      const result = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")

        Graph.addEdge(mutable, nodeA, nodeB, 10)
        Graph.addEdge(mutable, nodeB, nodeC, 20)
        Graph.addEdge(mutable, nodeC, nodeA, 30)

        expect(Graph.nodeCount(mutable)).toBe(3)
        expect(Graph.edgeCount(mutable)).toBe(3)

        // Remove nodeB which has 2 incident edges
        Graph.removeNode(mutable, nodeB)

        expect(Graph.nodeCount(mutable)).toBe(2)
        expect(Graph.edgeCount(mutable)).toBe(1) // Only nodeC -> nodeA edge remains
      })

      expect(Graph.nodeCount(result)).toBe(2)
      expect(Graph.edgeCount(result)).toBe(1)
    })

    it("should handle removing non-existent node gracefully", () => {
      const result = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A") // Just need one node for count
        const nonExistentNode = 999

        expect(Graph.nodeCount(mutable)).toBe(1)
        Graph.removeNode(mutable, nonExistentNode) // Should not throw
        expect(Graph.nodeCount(mutable)).toBe(1) // Should remain unchanged
      })

      expect(Graph.nodeCount(result)).toBe(1)
    })

    it("should handle isolated node removal", () => {
      const result = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A") // Keep for final count
        const nodeB = Graph.addNode(mutable, "Node B") // Isolated node to remove

        expect(Graph.nodeCount(mutable)).toBe(2)
        expect(Graph.edgeCount(mutable)).toBe(0)

        Graph.removeNode(mutable, nodeB)

        expect(Graph.nodeCount(mutable)).toBe(1)
        expect(Graph.edgeCount(mutable)).toBe(0)
      })

      expect(Graph.nodeCount(result)).toBe(1)
    })
  })

  describe("removeEdge", () => {
    it("should remove an edge between two nodes", () => {
      let edgeIndex: Graph.EdgeIndex

      const result = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        edgeIndex = Graph.addEdge(mutable, nodeA, nodeB, 42)

        expect(Graph.edgeCount(mutable)).toBe(1)

        Graph.removeEdge(mutable, edgeIndex)

        expect(Graph.edgeCount(mutable)).toBe(0)
      })

      expect(Graph.edgeCount(result)).toBe(0)
    })

    it("should handle removing non-existent edge gracefully", () => {
      const result = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        Graph.addEdge(mutable, nodeA, nodeB, 42)

        const nonExistentEdge = 999

        expect(Graph.edgeCount(mutable)).toBe(1)
        Graph.removeEdge(mutable, nonExistentEdge) // Should not throw
        expect(Graph.edgeCount(mutable)).toBe(1) // Should remain unchanged
      })

      expect(Graph.edgeCount(result)).toBe(1)
    })

    it("should handle multiple edges between same nodes", () => {
      const result = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")

        const edge1 = Graph.addEdge(mutable, nodeA, nodeB, 10)
        const edge2 = Graph.addEdge(mutable, nodeA, nodeB, 20)

        expect(Graph.edgeCount(mutable)).toBe(2)

        Graph.removeEdge(mutable, edge1)

        expect(Graph.edgeCount(mutable)).toBe(1)

        // Verify second edge still exists
        assertSome(Graph.getEdge(mutable, edge2), new Graph.Edge({ source: nodeA, target: nodeB, data: 20 }))
      })

      expect(Graph.edgeCount(result)).toBe(1)
    })
  })

  describe("getEdge", () => {
    it("should return edge data for existing edge", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        Graph.addEdge(mutable, nodeA, nodeB, 42)
      })

      const edgeIndex = 0
      const edge = Graph.getEdge(graph, edgeIndex)

      assertSome(edge, new Graph.Edge({ source: 0, target: 1, data: 42 }))
    })

    it("should return None for non-existent edge", () => {
      const graph = Graph.directed<string, number>()
      const edgeIndex = 999
      const edge = Graph.getEdge(graph, edgeIndex)

      expect(edge).toEqual(Option.none())
    })

    describe("hasEdge", () => {
      it("should return true for existing edge", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          Graph.addEdge(mutable, nodeA, nodeB, 42)
        })

        const nodeA = 0
        const nodeB = 1

        expect(Graph.hasEdge(graph, nodeA, nodeB)).toBe(true)
      })

      it("should return false for non-existent edge", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          Graph.addNode(mutable, "Node C")
          Graph.addEdge(mutable, nodeA, nodeB, 42)
        })

        const nodeA = 0
        const nodeC = 2

        expect(Graph.hasEdge(graph, nodeA, nodeC)).toBe(false)
      })

      it("should return false for non-existent source node", () => {
        const graph = Graph.directed<string, number>()
        const nodeA = 0
        const nodeB = 1

        expect(Graph.hasEdge(graph, nodeA, nodeB)).toBe(false)
      })

      it("should be symmetric for undirected graphs", () => {
        const graph = Graph.undirected<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          Graph.addEdge(mutable, nodeA, nodeB, 42)
        })

        expect(Graph.hasEdge(graph, 0, 1)).toBe(true)
        expect(Graph.hasEdge(graph, 1, 0)).toBe(true)
      })
    })

    describe("edgeCount", () => {
      it("should return 0 for empty graph", () => {
        const graph = Graph.directed<string, number>()
        expect(Graph.edgeCount(graph)).toBe(0)
      })

      it("should return correct edge count", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          const nodeC = Graph.addNode(mutable, "Node C")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
          Graph.addEdge(mutable, nodeB, nodeC, 2)
          Graph.addEdge(mutable, nodeC, nodeA, 3)
        })

        expect(Graph.edgeCount(graph)).toBe(3)
      })
    })

    describe("neighbors", () => {
      it("should return correct neighbors for directed graph", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          const nodeC = Graph.addNode(mutable, "Node C")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
          Graph.addEdge(mutable, nodeA, nodeC, 2)
        })

        const nodeA = 0
        const nodeB = 1
        const nodeC = 2

        const neighborsA = Graph.neighbors(graph, nodeA)
        expect(neighborsA).toContain(nodeB)
        expect(neighborsA).toContain(nodeC)
        expect(neighborsA).toHaveLength(2)

        const neighborsB = Graph.neighbors(graph, nodeB)
        expect(neighborsB).toEqual([])
      })
    })

    describe("neighbors with undirected graphs", () => {
      it("should return correct neighbors for single edge", () => {
        const graph = Graph.undirected<number, void>((mutable) => {
          Graph.addNode(mutable, 0)
          Graph.addNode(mutable, 1)
          Graph.addEdge(mutable, 0, 1, undefined)
        })

        expect(Graph.neighbors(graph, 0)).toEqual([1])
        expect(Graph.neighbors(graph, 1)).toEqual([0])
      })

      it("should return correct neighbors for linear graph", () => {
        const graph = Graph.undirected<number, void>((mutable) => {
          Graph.addNode(mutable, 0)
          Graph.addNode(mutable, 1)
          Graph.addNode(mutable, 2)
          Graph.addEdge(mutable, 0, 1, undefined)
          Graph.addEdge(mutable, 1, 2, undefined)
        })

        expect(Graph.neighbors(graph, 0)).toEqual([1])
        expect(Graph.neighbors(graph, 1).sort()).toEqual([0, 2])
        expect(Graph.neighbors(graph, 2)).toEqual([1])
      })

      it("should handle multiple edges between same nodes", () => {
        const graph = Graph.undirected<number, void>((mutable) => {
          Graph.addNode(mutable, 0)
          Graph.addNode(mutable, 1)
          Graph.addEdge(mutable, 0, 1, undefined)
          Graph.addEdge(mutable, 0, 1, undefined)
        })

        // Should deduplicate neighbors
        expect(Graph.neighbors(graph, 0)).toEqual([1])
        expect(Graph.neighbors(graph, 1)).toEqual([0])
      })

      it("should handle self-loops", () => {
        const graph = Graph.undirected<number, void>((mutable) => {
          Graph.addNode(mutable, 0)
          Graph.addEdge(mutable, 0, 0, undefined)
        })

        expect(Graph.neighbors(graph, 0)).toEqual([0])
      })

      it("should handle node with no neighbors", () => {
        const graph = Graph.undirected<number, void>((mutable) => {
          Graph.addNode(mutable, 0)
          Graph.addNode(mutable, 1)
        })

        expect(Graph.neighbors(graph, 0)).toEqual([])
        expect(Graph.neighbors(graph, 1)).toEqual([])
      })
    })

    describe("successors and predecessors", () => {
      it("should return outgoing and incoming directed neighbors", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          const nodeC = Graph.addNode(mutable, "Node C")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
          Graph.addEdge(mutable, nodeC, nodeB, 2)
        })

        expect(Graph.successors(graph, 0)).toEqual([1])
        expect(Graph.predecessors(graph, 1).sort()).toEqual([0, 2])
      })

      it("should throw for undirected graphs", () => {
        const graph = Graph.undirected<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
        })

        expect(() => Graph.successors(graph as any, 0)).toThrow("Cannot get successors of undirected graph")
        expect(() => Graph.predecessors(graph as any, 0)).toThrow("Cannot get predecessors of undirected graph")
      })
    })

    describe("neighborsDirected", () => {
      it("should return incoming neighbors", () => {
        let nodeA: Graph.NodeIndex
        let nodeB: Graph.NodeIndex
        let nodeC: Graph.NodeIndex

        const graph = Graph.directed<string, number>((mutable) => {
          nodeA = Graph.addNode(mutable, "Node A")
          nodeB = Graph.addNode(mutable, "Node B")
          nodeC = Graph.addNode(mutable, "Node C")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
          Graph.addEdge(mutable, nodeC, nodeB, 2)
        })

        const incomingB = Graph.neighborsDirected(graph, nodeB!, "incoming")
        expect(incomingB.sort()).toEqual([nodeA!, nodeC!].sort())

        const incomingA = Graph.neighborsDirected(graph, nodeA!, "incoming")
        expect(incomingA).toEqual([])
      })

      it("should return outgoing neighbors", () => {
        let nodeA: Graph.NodeIndex
        let nodeB: Graph.NodeIndex
        let nodeC: Graph.NodeIndex

        const graph = Graph.directed<string, number>((mutable) => {
          nodeA = Graph.addNode(mutable, "Node A")
          nodeB = Graph.addNode(mutable, "Node B")
          nodeC = Graph.addNode(mutable, "Node C")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
          Graph.addEdge(mutable, nodeA, nodeC, 2)
        })

        const outgoingA = Graph.neighborsDirected(graph, nodeA!, "outgoing")
        expect(outgoingA.sort()).toEqual([nodeB!, nodeC!].sort())

        const outgoingB = Graph.neighborsDirected(graph, nodeB!, "outgoing")
        expect(outgoingB).toEqual([])
      })

      it("should handle node with no connections", () => {
        let nodeA: Graph.NodeIndex

        const graph = Graph.directed<string, number>((mutable) => {
          nodeA = Graph.addNode(mutable, "Node A")
        })

        expect(Graph.neighborsDirected(graph, nodeA!, "incoming")).toEqual([])
        expect(Graph.neighborsDirected(graph, nodeA!, "outgoing")).toEqual([])
      })

      it("should throw for undirected graphs", () => {
        const graph = Graph.undirected<string, number>((mutable) => {
          const nodeA = Graph.addNode(mutable, "Node A")
          const nodeB = Graph.addNode(mutable, "Node B")
          Graph.addEdge(mutable, nodeA, nodeB, 1)
        })

        expect(() => Graph.neighborsDirected(graph as any, 0, "outgoing"))
          .toThrow("Cannot get directed neighbors of undirected graph")
      })
    })
  })

  describe("toGraphViz", () => {
    it("should export empty directed graph", () => {
      const graph = Graph.directed<string, number>()
      const dot = Graph.toGraphViz(graph)

      expect(dot).toBe("digraph \"G\" {\n}")
    })

    it("should export empty undirected graph", () => {
      const graph = Graph.undirected<string, number>()
      const dot = Graph.toGraphViz(graph)

      expect(dot).toBe("graph \"G\" {\n}")
    })

    it("should export directed graph with nodes and edges", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")
        Graph.addEdge(mutable, nodeA, nodeB, 1)
        Graph.addEdge(mutable, nodeB, nodeC, 2)
        Graph.addEdge(mutable, nodeC, nodeA, 3)
      })

      const dot = Graph.toGraphViz(graph)

      expect(dot).toContain("digraph \"G\" {")
      expect(dot).toContain("\"0\" [label=\"Node A\"];")
      expect(dot).toContain("\"1\" [label=\"Node B\"];")
      expect(dot).toContain("\"2\" [label=\"Node C\"];")
      expect(dot).toContain("\"0\" -> \"1\" [label=\"1\"];")
      expect(dot).toContain("\"1\" -> \"2\" [label=\"2\"];")
      expect(dot).toContain("\"2\" -> \"0\" [label=\"3\"];")
      expect(dot).toContain("}")
    })

    it("should export undirected graph with correct edge format", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "A")
        const nodeB = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, nodeA, nodeB, 1)
      })

      const dot = Graph.toGraphViz(graph)

      expect(dot).toContain("graph \"G\" {")
      expect(dot).toContain("\"0\" -- \"1\" [label=\"1\"];")
    })

    it("should support custom node and edge labels", () => {
      const graph = Graph.directed<{ name: string }, { weight: number }>((mutable) => {
        const nodeA = Graph.addNode(mutable, { name: "Alice" })
        const nodeB = Graph.addNode(mutable, { name: "Bob" })
        Graph.addEdge(mutable, nodeA, nodeB, { weight: 42 })
      })

      const dot = Graph.toGraphViz(graph, {
        nodeLabel: (data) => data.name,
        edgeLabel: (data) => `weight: ${data.weight}`,
        graphName: "MyGraph"
      })

      expect(dot).toContain("digraph \"MyGraph\" {")
      expect(dot).toContain("\"0\" [label=\"Alice\"];")
      expect(dot).toContain("\"1\" [label=\"Bob\"];")
      expect(dot).toContain("\"0\" -> \"1\" [label=\"weight: 42\"];")
    })

    it("should escape quotes in labels", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node \"A\"")
        const nodeB = Graph.addNode(mutable, "Node \"B\"")
        Graph.addEdge(mutable, nodeA, nodeB, "Edge \"1\"")
      })

      const dot = Graph.toGraphViz(graph)

      expect(dot).toContain("\"0\" [label=\"Node \\\"A\\\"\"];")
      expect(dot).toContain("\"1\" [label=\"Node \\\"B\\\"\"];")
      expect(dot).toContain("\"0\" -> \"1\" [label=\"Edge \\\"1\\\"\"];")
    })

    it("should quote graph names", () => {
      const graph = Graph.directed<string, string>()

      strictEqual(Graph.toGraphViz(graph, { graphName: "MyGraph" }), "digraph \"MyGraph\" {\n}")
      strictEqual(Graph.toGraphViz(graph, { graphName: "My Graph" }), "digraph \"My Graph\" {\n}")
      strictEqual(Graph.toGraphViz(graph, { graphName: "" }), "digraph \"\" {\n}")
      strictEqual(Graph.toGraphViz(graph, { graphName: "graph" }), "digraph \"graph\" {\n}")
      strictEqual(Graph.toGraphViz(graph, { graphName: "Node" }), "digraph \"Node\" {\n}")
      strictEqual(Graph.toGraphViz(graph, { graphName: "My \"Graph\"" }), "digraph \"My \\\"Graph\\\"\" {\n}")
    })

    it("should escape labels as literal text", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const nodeA = Graph.addNode(mutable, "C:\\new\\path")
        const nodeB = Graph.addNode(mutable, "Line 1\nLine 2")
        Graph.addEdge(mutable, nodeA, nodeB, "edge\\label\nnext")
      })

      const dot = Graph.toGraphViz(graph)

      strictEqual(
        dot,
        [
          "digraph \"G\" {",
          "  \"0\" [label=\"C:\\\\new\\\\path\"];",
          "  \"1\" [label=\"Line 1\\nLine 2\"];",
          "  \"0\" -> \"1\" [label=\"edge\\\\label\\nnext\"];",
          "}"
        ].join("\n")
      )
    })

    it("should demonstrate graph visualization", () => {
      // Create a simple directed graph representing a dependency graph
      const graph = Graph.directed<string, string>((mutable) => {
        const app = Graph.addNode(mutable, "App")
        const auth = Graph.addNode(mutable, "Auth")
        const db = Graph.addNode(mutable, "Database")
        const cache = Graph.addNode(mutable, "Cache")

        Graph.addEdge(mutable, app, auth, "uses")
        Graph.addEdge(mutable, app, db, "stores")
        Graph.addEdge(mutable, auth, db, "validates")
        Graph.addEdge(mutable, app, cache, "caches")
      })

      const dot = Graph.toGraphViz(graph, {
        graphName: "DependencyGraph"
      })

      // Uncomment the next line to see the GraphViz output in test console
      // console.log("\nDependency Graph DOT format:\n" + dot)

      expect(dot).toContain("digraph \"DependencyGraph\" {")
      expect(dot).toContain("\"0\" [label=\"App\"];")
      expect(dot).toContain("\"0\" -> \"1\" [label=\"uses\"];")
      expect(dot).toContain("\"0\" -> \"2\" [label=\"stores\"];")
      expect(dot).toContain("\"1\" -> \"2\" [label=\"validates\"];")
      expect(dot).toContain("\"0\" -> \"3\" [label=\"caches\"];")
    })

    it("should demonstrate undirected graph visualization", () => {
      // Create a simple social network graph
      const graph = Graph.undirected<string, string>((mutable) => {
        const alice = Graph.addNode(mutable, "Alice")
        const bob = Graph.addNode(mutable, "Bob")
        const charlie = Graph.addNode(mutable, "Charlie")
        const diana = Graph.addNode(mutable, "Diana")

        Graph.addEdge(mutable, alice, bob, "friends")
        Graph.addEdge(mutable, bob, charlie, "friends")
        Graph.addEdge(mutable, charlie, diana, "friends")
        Graph.addEdge(mutable, alice, diana, "friends")
      })

      const dot = Graph.toGraphViz(graph, {
        graphName: "SocialNetwork"
      })

      // Uncomment the next line to see the GraphViz output in test console
      // console.log("\nSocial Network DOT format:\n" + dot)

      expect(dot).toContain("graph \"SocialNetwork\" {")
      expect(dot).toContain("\"0\" [label=\"Alice\"];")
      expect(dot).toContain("\"0\" -- \"1\" [label=\"friends\"];")
      expect(dot).toContain("\"1\" -- \"2\" [label=\"friends\"];")
      expect(dot).toContain("\"2\" -- \"3\" [label=\"friends\"];")
      expect(dot).toContain("\"0\" -- \"3\" [label=\"friends\"];")
    })
  })

  describe("toMermaid", () => {
    it("should export empty directed graph", () => {
      const graph = Graph.directed<string, number>()
      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toBe("flowchart TD")
    })

    it("should export empty undirected graph", () => {
      const graph = Graph.undirected<string, number>()
      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toBe("graph TD")
    })

    it("should export directed graph with nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node A")
        Graph.addNode(mutable, "Node B")
        Graph.addNode(mutable, "Node C")
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("flowchart TD")
      expect(mermaid).toContain("0[\"Node A\"]")
      expect(mermaid).toContain("1[\"Node B\"]")
      expect(mermaid).toContain("2[\"Node C\"]")
    })

    it("should export undirected graph with nodes", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        Graph.addNode(mutable, "Alice")
        Graph.addNode(mutable, "Bob")
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("graph TD")
      expect(mermaid).toContain("0[\"Alice\"]")
      expect(mermaid).toContain("1[\"Bob\"]")
    })

    it("should support all node shapes", () => {
      const shapes: Array<[string, any]> = [
        ["rectangle", "rectangle"],
        ["rounded", "rounded"],
        ["circle", "circle"],
        ["diamond", "diamond"],
        ["hexagon", "hexagon"],
        ["stadium", "stadium"],
        ["subroutine", "subroutine"],
        ["cylindrical", "cylindrical"]
      ]

      shapes.forEach(([shapeName, shapeValue]) => {
        const graph = Graph.directed<string, number>((mutable) => {
          Graph.addNode(mutable, "Test")
        })

        const mermaid = Graph.toMermaid(graph, {
          nodeShape: () => shapeValue
        })

        expect(mermaid).toContain("flowchart TD")

        // Test expected shape format
        switch (shapeName) {
          case "rectangle":
            expect(mermaid).toContain("0[\"Test\"]")
            break
          case "rounded":
            expect(mermaid).toContain("0(\"Test\")")
            break
          case "circle":
            expect(mermaid).toContain("0((\"Test\"))")
            break
          case "diamond":
            expect(mermaid).toContain("0{\"Test\"}")
            break
          case "hexagon":
            expect(mermaid).toContain("0{{\"Test\"}}")
            break
          case "stadium":
            expect(mermaid).toContain("0([\"Test\"])")
            break
          case "subroutine":
            expect(mermaid).toContain("0[[\"Test\"]]")
            break
          case "cylindrical":
            expect(mermaid).toContain("0[(\"Test\")]")
            break
        }
      })
    })

    it("should escape special characters in labels", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Node with \"quotes\"")
        Graph.addNode(mutable, "Node with [brackets]")
        Graph.addNode(mutable, "Node with | pipe")
        Graph.addNode(mutable, "Node with \\ backslash")
        Graph.addNode(mutable, "Node with \n newline")
      })

      const mermaid = Graph.toMermaid(graph)

      expect(mermaid).toContain("0[\"Node with #quot;quotes#quot;\"]")
      expect(mermaid).toContain("1[\"Node with #91;brackets#93;\"]")
      expect(mermaid).toContain("2[\"Node with #124; pipe\"]")
      expect(mermaid).toContain("3[\"Node with #92; backslash\"]")
      expect(mermaid).toContain("4[\"Node with <br/> newline\"]")
    })

    it("should export directed graph with edges", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "Node A")
        const nodeB = Graph.addNode(mutable, "Node B")
        const nodeC = Graph.addNode(mutable, "Node C")
        Graph.addEdge(mutable, nodeA, nodeB, 1)
        Graph.addEdge(mutable, nodeB, nodeC, 2)
        Graph.addEdge(mutable, nodeC, nodeA, 3)
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("flowchart TD")
      expect(mermaid).toContain("0[\"Node A\"]")
      expect(mermaid).toContain("1[\"Node B\"]")
      expect(mermaid).toContain("2[\"Node C\"]")
      expect(mermaid).toContain("0 -->|\"1\"| 1")
      expect(mermaid).toContain("1 -->|\"2\"| 2")
      expect(mermaid).toContain("2 -->|\"3\"| 0")
    })

    it("should export undirected graph with edges", () => {
      const graph = Graph.undirected<string, string>((mutable) => {
        const alice = Graph.addNode(mutable, "Alice")
        const bob = Graph.addNode(mutable, "Bob")
        const charlie = Graph.addNode(mutable, "Charlie")
        Graph.addEdge(mutable, alice, bob, "friends")
        Graph.addEdge(mutable, bob, charlie, "colleagues")
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("graph TD")
      expect(mermaid).toContain("0[\"Alice\"]")
      expect(mermaid).toContain("1[\"Bob\"]")
      expect(mermaid).toContain("2[\"Charlie\"]")
      expect(mermaid).toContain("0 ---|\"friends\"| 1")
      expect(mermaid).toContain("1 ---|\"colleagues\"| 2")
    })

    it("should handle empty edge labels", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const nodeA = Graph.addNode(mutable, "A")
        const nodeB = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, nodeA, nodeB, "")
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("0 --> 1")
    })

    it("should support all diagram directions", () => {
      const directions = ["TB", "TD", "BT", "RL", "LR"] as const

      directions.forEach((dir) => {
        const graph = Graph.directed<string, number>((mutable) => {
          Graph.addNode(mutable, "A")
          Graph.addNode(mutable, "B")
        })

        const mermaid = Graph.toMermaid(graph, { direction: dir })
        expect(mermaid).toContain(`flowchart ${dir}`)
        expect(mermaid).toContain("0[\"A\"]")
        expect(mermaid).toContain("1[\"B\"]")
      })
    })

    it("should auto-detect diagram type based on graph type", () => {
      // Directed graph should auto-detect as flowchart
      const directedGraph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })
      const directedMermaid = Graph.toMermaid(directedGraph)
      expect(directedMermaid).toContain("flowchart TD")

      // Undirected graph should auto-detect as graph
      const undirectedGraph = Graph.undirected<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })
      const undirectedMermaid = Graph.toMermaid(undirectedGraph)
      expect(undirectedMermaid).toContain("graph TD")
    })

    it("should allow manual diagram type override", () => {
      // Override directed graph to use 'graph' type
      const directedGraph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })
      const overriddenMermaid = Graph.toMermaid(directedGraph, {
        diagramType: "graph"
      })
      expect(overriddenMermaid).toContain("graph TD")

      // Override undirected graph to use 'flowchart' type
      const undirectedGraph = Graph.undirected<string, number>((mutable) => {
        Graph.addNode(mutable, "B")
      })
      const overriddenFlowchart = Graph.toMermaid(undirectedGraph, {
        diagramType: "flowchart"
      })
      expect(overriddenFlowchart).toContain("flowchart TD")
    })

    it("should combine direction and diagram type options", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "Test")
      })

      const mermaid = Graph.toMermaid(graph, {
        direction: "LR",
        diagramType: "graph"
      })

      expect(mermaid).toContain("graph LR")
      expect(mermaid).toContain("0[\"Test\"]")
    })

    it("should handle self-loops correctly", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const nodeA = Graph.addNode(mutable, "A")
        Graph.addEdge(mutable, nodeA, nodeA, "self")
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("flowchart TD")
      expect(mermaid).toContain("0[\"A\"]")
      expect(mermaid).toContain("0 -->|\"self\"| 0")
    })

    it("should handle multi-edges correctly", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const nodeA = Graph.addNode(mutable, "A")
        const nodeB = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, nodeA, nodeB, 1)
        Graph.addEdge(mutable, nodeA, nodeB, 2)
        Graph.addEdge(mutable, nodeA, nodeB, 3)
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("flowchart TD")
      expect(mermaid).toContain("0[\"A\"]")
      expect(mermaid).toContain("1[\"B\"]")
      // Should contain all three edges
      expect(mermaid).toContain("0 -->|\"1\"| 1")
      expect(mermaid).toContain("0 -->|\"2\"| 1")
      expect(mermaid).toContain("0 -->|\"3\"| 1")
    })

    it("should handle disconnected components", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        // Component 1: A -> B
        const nodeA = Graph.addNode(mutable, "A")
        const nodeB = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, nodeA, nodeB, "A->B")

        // Component 2: C -> D (disconnected)
        const nodeC = Graph.addNode(mutable, "C")
        const nodeD = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, nodeC, nodeD, "C->D")

        // Isolated node E
        Graph.addNode(mutable, "E")
      })

      const mermaid = Graph.toMermaid(graph)
      expect(mermaid).toContain("flowchart TD")
      expect(mermaid).toContain("0[\"A\"]")
      expect(mermaid).toContain("1[\"B\"]")
      expect(mermaid).toContain("2[\"C\"]")
      expect(mermaid).toContain("3[\"D\"]")
      expect(mermaid).toContain("4[\"E\"]")
      expect(mermaid).toContain("0 -->|\"A-#gt;B\"| 1")
      expect(mermaid).toContain("2 -->|\"C-#gt;D\"| 3")
    })

    it("should handle custom labels with complex data", () => {
      interface NodeData {
        id: string
        value: number
        metadata: { type: string }
      }

      interface EdgeData {
        weight: number
        type: string
      }

      const graph = Graph.directed<NodeData, EdgeData>((mutable) => {
        const node1 = Graph.addNode(mutable, {
          id: "node1",
          value: 42,
          metadata: { type: "input" }
        })
        const node2 = Graph.addNode(mutable, {
          id: "node2",
          value: 84,
          metadata: { type: "processing" }
        })
        Graph.addEdge(mutable, node1, node2, { weight: 1.5, type: "data" })
      })

      const mermaid = Graph.toMermaid(graph, {
        nodeLabel: (data) => `${data.id}:${data.value}`,
        edgeLabel: (data) => `${data.type}(${data.weight})`,
        direction: "LR"
      })

      expect(mermaid).toContain("flowchart LR")
      expect(mermaid).toContain("0[\"node1:42\"]")
      expect(mermaid).toContain("1[\"node2:84\"]")
      expect(mermaid).toContain("0 -->|\"data#40;1.5#41;\"| 1")
    })
  })

  describe("isAcyclic", () => {
    it("should detect acyclic directed graphs (DAGs)", () => {
      const dag = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "A->B")
        Graph.addEdge(mutable, a, c, "A->C")
        Graph.addEdge(mutable, b, d, "B->D")
        Graph.addEdge(mutable, c, d, "C->D")
      })

      expect(Graph.isAcyclic(dag)).toBe(true)
    })

    it("should detect cycles in directed graphs", () => {
      const cyclic = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, "A->B")
        Graph.addEdge(mutable, b, c, "B->C")
        Graph.addEdge(mutable, c, a, "C->A") // Creates cycle
      })

      expect(Graph.isAcyclic(cyclic)).toBe(false)
    })

    it("should handle disconnected components", () => {
      const disconnected = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "A->B") // Component 1: A->B (acyclic)
        Graph.addEdge(mutable, c, d, "C->D") // Component 2: C->D (acyclic)
        // No connections between components
      })

      expect(Graph.isAcyclic(disconnected)).toBe(true)
    })

    it("should detect cycles in one component of disconnected graph", () => {
      const mixedComponents = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "A->B") // Component 1: A->B (acyclic)
        Graph.addEdge(mutable, c, d, "C->D") // Component 2: C->D->C (cyclic)
        Graph.addEdge(mutable, d, c, "D->C")
      })

      expect(Graph.isAcyclic(mixedComponents)).toBe(false)
    })

    it("should treat a reversed-storage undirected chain as acyclic", () => {
      const graph = makeReversedUndirectedPath()

      expect(Graph.isAcyclic(graph)).toBe(true)
    })

    it("should treat a single undirected edge as acyclic", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      strictEqual(Graph.isAcyclic(graph), true)
    })

    it("should detect parallel undirected edges as a cycle", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, a, b, 2)
      })

      strictEqual(Graph.isAcyclic(graph), false)
    })

    it("should detect undirected self-loops as cycles", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        Graph.addEdge(mutable, a, a, 1)
      })

      strictEqual(Graph.isAcyclic(graph), false)
    })

    it("should detect cycles in undirected graphs", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 1)
        Graph.addEdge(mutable, c, a, 1)
      })

      expect(Graph.isAcyclic(graph)).toBe(false)
    })
  })

  describe("isBipartite", () => {
    it("should detect bipartite undirected graphs", () => {
      const bipartite = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "edge") // Set 1: {A, C}, Set 2: {B, D}
        Graph.addEdge(mutable, b, c, "edge")
        Graph.addEdge(mutable, c, d, "edge")
        Graph.addEdge(mutable, d, a, "edge")
      })

      expect(Graph.isBipartite(bipartite)).toBe(true)
    })

    it("should detect non-bipartite graphs (odd cycles)", () => {
      const triangle = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, "edge")
        Graph.addEdge(mutable, b, c, "edge")
        Graph.addEdge(mutable, c, a, "edge") // Triangle (3-cycle)
      })

      expect(Graph.isBipartite(triangle)).toBe(false)
    })

    it("should handle path graphs (always bipartite)", () => {
      const path = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "edge")
        Graph.addEdge(mutable, b, c, "edge")
        Graph.addEdge(mutable, c, d, "edge")
      })

      expect(Graph.isBipartite(path)).toBe(true)
    })

    it("should handle disconnected components", () => {
      const disconnected = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "edge") // Component 1: A-B (bipartite)
        Graph.addEdge(mutable, c, d, "edge") // Component 2: C-D (bipartite)
        // No connections between components
      })

      expect(Graph.isBipartite(disconnected)).toBe(true)
    })

    it("should detect non-bipartite component in disconnected graph", () => {
      const mixedComponents = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        const e = Graph.addNode(mutable, "E")
        Graph.addEdge(mutable, a, b, "edge") // Component 1: A-B (bipartite)
        Graph.addEdge(mutable, c, d, "edge") // Component 2: triangle (non-bipartite)
        Graph.addEdge(mutable, d, e, "edge")
        Graph.addEdge(mutable, e, c, "edge")
      })

      expect(Graph.isBipartite(mixedComponents)).toBe(false)
    })
  })

  describe("connectedComponents", () => {
    it("should find connected components in disconnected undirected graph", () => {
      const graph = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addNode(mutable, "E")
        Graph.addEdge(mutable, a, b, "edge") // Component 1: A-B
        Graph.addEdge(mutable, c, d, "edge") // Component 2: C-D
        // E is isolated - Component 3: E
      })

      const components = Graph.connectedComponents(graph)
      expect(components).toHaveLength(3)

      // Sort components by size and first element for deterministic testing
      components.sort((a, b) => a.length - b.length || a[0] - b[0])
      expect(components[0]).toEqual([4]) // E isolated
      expect(components[1]).toHaveLength(2) // A-B or C-D
      expect(components[2]).toHaveLength(2) // A-B or C-D
    })

    it("should handle fully connected component", () => {
      const graph = Graph.undirected<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, "edge")
        Graph.addEdge(mutable, b, c, "edge")
        Graph.addEdge(mutable, c, a, "edge")
      })

      const components = Graph.connectedComponents(graph)
      expect(components).toHaveLength(1)
      expect(components[0]).toHaveLength(3)
      expect(components[0].sort()).toEqual([0, 1, 2])
    })
  })

  describe("stronglyConnectedComponents", () => {
    it("should find strongly connected components in directed graph", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, "A->B")
        Graph.addEdge(mutable, b, c, "B->C")
        Graph.addEdge(mutable, c, a, "C->A") // SCC: A-B-C
        Graph.addEdge(mutable, b, d, "B->D") // D is separate
      })

      const sccs = Graph.stronglyConnectedComponents(graph)
      expect(sccs).toHaveLength(2)

      // Sort SCCs by size for deterministic testing
      sccs.sort((a, b) => a.length - b.length)
      expect(sccs[0]).toEqual([3]) // D is alone
      expect(sccs[1]).toHaveLength(3) // A-B-C cycle
      expect(sccs[1].sort()).toEqual([0, 1, 2])
    })

    it("should handle acyclic directed graph (each node is its own SCC)", () => {
      const dag = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, "A->B")
        Graph.addEdge(mutable, b, c, "B->C")
      })

      const sccs = Graph.stronglyConnectedComponents(dag)
      expect(sccs).toHaveLength(3)
      // Each SCC should contain exactly one node
      sccs.forEach((scc) => {
        expect(scc).toHaveLength(1)
      })
    })

    it("should handle fully connected components", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        // Create bidirectional edges (fully connected)
        Graph.addEdge(mutable, a, b, "A->B")
        Graph.addEdge(mutable, b, a, "B->A")
        Graph.addEdge(mutable, b, c, "B->C")
        Graph.addEdge(mutable, c, b, "C->B")
        Graph.addEdge(mutable, a, c, "A->C")
        Graph.addEdge(mutable, c, a, "C->A")
      })

      const sccs = Graph.stronglyConnectedComponents(graph)
      expect(sccs).toHaveLength(1)
      expect(sccs[0]).toHaveLength(3)
      expect(sccs[0].sort()).toEqual([0, 1, 2])
    })

    it("should handle disconnected components with cycles", () => {
      const graph = Graph.directed<string, string>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        // First SCC: A->B->A
        Graph.addEdge(mutable, a, b, "A->B")
        Graph.addEdge(mutable, b, a, "B->A")
        // Second SCC: C->D->C
        Graph.addEdge(mutable, c, d, "C->D")
        Graph.addEdge(mutable, d, c, "D->C")
      })

      const sccs = Graph.stronglyConnectedComponents(graph)
      expect(sccs).toHaveLength(2)
      sccs.forEach((scc) => {
        expect(scc).toHaveLength(2)
      })
    })

    it("should throw for undirected graphs", () => {
      const graph = makeReversedUndirectedPath()

      expect(() => Graph.stronglyConnectedComponents(graph as any))
        .toThrow("Cannot find strongly connected components of undirected graph")
    })
  })

  describe("dijkstra", () => {
    it("should find shortest path in simple graph", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let nodeC: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
        nodeB = Graph.addNode(mutable, "B")
        nodeC = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, nodeA, nodeB, 5)
        Graph.addEdge(mutable, nodeA, nodeC, 10)
        Graph.addEdge(mutable, nodeB, nodeC, 2)
      })

      const result = Graph.dijkstra(graph, {
        source: nodeA!,
        target: nodeC!,
        cost: (edge) => edge
      })

      assertSome(result, { path: [nodeA!, nodeB!, nodeC!], distance: 7, costs: [5, 2] })
    })

    it("should preserve insertion order for equal priorities", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const source = Graph.addNode(mutable, "source")
        const first = Graph.addNode(mutable, "first")
        const second = Graph.addNode(mutable, "second")
        const target = Graph.addNode(mutable, "target")
        Graph.addEdge(mutable, source, first, 1)
        Graph.addEdge(mutable, source, second, 1)
        Graph.addEdge(mutable, first, target, 1)
        Graph.addEdge(mutable, second, target, 1)
      })

      const result = Graph.dijkstra(graph, {
        source: 0,
        target: 3,
        cost: (edge) => edge
      })

      assertSome(result, { path: [0, 1, 3], distance: 2, costs: [1, 1] })
    })

    it("should skip stale priority queue entries", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const source = Graph.addNode(mutable, "source")
        const improved = Graph.addNode(mutable, "improved")
        const shortcut = Graph.addNode(mutable, "shortcut")
        const middle = Graph.addNode(mutable, "middle")
        const target = Graph.addNode(mutable, "target")
        Graph.addEdge(mutable, source, improved, 10)
        Graph.addEdge(mutable, source, shortcut, 1)
        Graph.addEdge(mutable, shortcut, improved, 1)
        Graph.addEdge(mutable, improved, middle, 20)
        Graph.addEdge(mutable, middle, target, 20)
      })

      const result = Graph.dijkstra(graph, {
        source: 0,
        target: 4,
        cost: (edge) => edge
      })

      assertSome(result, { path: [0, 2, 1, 3, 4], distance: 42, costs: [1, 1, 20, 20] })
    })

    it("should return None for unreachable nodes", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let nodeC: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
        nodeB = Graph.addNode(mutable, "B")
        nodeC = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, nodeA, nodeB, 1)
        // No path from A to C
      })

      const result = Graph.dijkstra(graph, {
        source: nodeA!,
        target: nodeC!,
        cost: (edge) => edge
      })

      expect(result).toEqual(Option.none())
    })

    it("should handle same source and target", () => {
      let nodeA: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
      })

      const result = Graph.dijkstra(graph, {
        source: nodeA!,
        target: nodeA!,
        cost: (edge) => edge
      })

      assertSome(result, { path: [nodeA!], distance: 0, costs: [] })
    })

    it("should throw for negative weights", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex

      const graph = Graph.directed<string, number>((mutable) => {
        nodeA = Graph.addNode(mutable, "A")
        nodeB = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, nodeA, nodeB, -1)
      })

      expect(() =>
        Graph.dijkstra(graph, {
          source: nodeA!,
          target: nodeB!,
          cost: (edge) => edge
        })
      ).toThrow(
        "Dijkstra's algorithm requires non-negative edge weights"
      )
    })

    it("should throw for NaN and negative infinity weights", () => {
      for (const weight of unsupportedEdgeWeights) {
        const graph = makeSingleEdgeGraph(weight)

        assertGraphError(
          () =>
            Graph.dijkstra(graph, {
              source: 0,
              target: 1,
              cost: (edge) => edge
            }),
          "Dijkstra's algorithm requires non-negative edge weights"
        )
      }
    })

    it("should treat infinity weights as unreachable", () => {
      const graph = makeSingleEdgeGraph(Infinity)

      const result = Graph.dijkstra(graph, {
        source: 0,
        target: 1,
        cost: (edge) => edge
      })

      assertNone(result)
    })

    it("should throw for negative weights before early target termination", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const source = Graph.addNode(mutable, "source")
        const target = Graph.addNode(mutable, "target")
        const other = Graph.addNode(mutable, "other")
        Graph.addEdge(mutable, source, target, 1)
        Graph.addEdge(mutable, source, other, 2)
        Graph.addEdge(mutable, other, target, -5)
      })

      expect(() =>
        Graph.dijkstra(graph, {
          source: 0,
          target: 1,
          cost: (edge) => edge
        })
      ).toThrow("Dijkstra's algorithm requires non-negative edge weights")
    })

    it("should validate weights before returning same source and target", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const node = Graph.addNode(mutable, "node")
        Graph.addEdge(mutable, node, node, -1)
      })

      expect(() =>
        Graph.dijkstra(graph, {
          source: 0,
          target: 0,
          cost: (edge) => edge
        })
      ).toThrow("Dijkstra's algorithm requires non-negative edge weights")
    })

    it("should throw for non-existent nodes", () => {
      const graph = Graph.directed<string, number>()

      expect(() =>
        Graph.dijkstra(graph, {
          source: 0,
          target: 1,
          cost: (edge) => edge
        })
      ).toThrow("Node 0 does not exist")
    })

    it("should traverse undirected edges in reverse storage direction", () => {
      const graph = makeReversedUndirectedPath()

      const result = Graph.dijkstra(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge
      })

      assertSome(result, { path: [0, 1, 2], distance: 2, costs: [1, 1] })
    })
  })

  describe("astar", () => {
    it("should find shortest path with heuristic", () => {
      let nodeA: Graph.NodeIndex
      let nodeB: Graph.NodeIndex
      let nodeC: Graph.NodeIndex

      const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
        nodeA = Graph.addNode(mutable, { x: 0, y: 0 })
        nodeB = Graph.addNode(mutable, { x: 1, y: 0 })
        nodeC = Graph.addNode(mutable, { x: 2, y: 0 })
        Graph.addEdge(mutable, nodeA, nodeB, 1)
        Graph.addEdge(mutable, nodeB, nodeC, 1)
      })

      const heuristic = (source: { x: number; y: number }, target: { x: number; y: number }) =>
        Math.abs(source.x - target.x) + Math.abs(source.y - target.y)

      const result = Graph.astar(graph, {
        source: nodeA!,
        target: nodeC!,
        cost: (edge) => edge,
        heuristic
      })

      assertSome(result, { path: [nodeA!, nodeB!, nodeC!], distance: 2, costs: [1, 1] })
    })

    it("should preserve insertion order for equal priorities", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const source = Graph.addNode(mutable, "source")
        const first = Graph.addNode(mutable, "first")
        const second = Graph.addNode(mutable, "second")
        const target = Graph.addNode(mutable, "target")
        Graph.addEdge(mutable, source, first, 1)
        Graph.addEdge(mutable, source, second, 1)
        Graph.addEdge(mutable, first, target, 1)
        Graph.addEdge(mutable, second, target, 1)
      })

      const result = Graph.astar(graph, {
        source: 0,
        target: 3,
        cost: (edge) => edge,
        heuristic: () => 0
      })

      assertSome(result, { path: [0, 1, 3], distance: 2, costs: [1, 1] })
    })

    it("should skip stale open set entries", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const source = Graph.addNode(mutable, "source")
        const improved = Graph.addNode(mutable, "improved")
        const shortcut = Graph.addNode(mutable, "shortcut")
        const middle = Graph.addNode(mutable, "middle")
        const target = Graph.addNode(mutable, "target")
        Graph.addEdge(mutable, source, improved, 10)
        Graph.addEdge(mutable, source, shortcut, 1)
        Graph.addEdge(mutable, shortcut, improved, 1)
        Graph.addEdge(mutable, improved, middle, 20)
        Graph.addEdge(mutable, middle, target, 20)
      })

      const result = Graph.astar(graph, {
        source: 0,
        target: 4,
        cost: (edge) => edge,
        heuristic: () => 0
      })

      assertSome(result, { path: [0, 2, 1, 3, 4], distance: 42, costs: [1, 1, 20, 20] })
    })

    it("should return None for unreachable nodes", () => {
      const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
        const a = Graph.addNode(mutable, { x: 0, y: 0 })
        const b = Graph.addNode(mutable, { x: 1, y: 0 })
        Graph.addNode(mutable, { x: 2, y: 0 })
        Graph.addEdge(mutable, a, b, 1)
        // No path from A to C
      })

      const heuristic = (source: { x: number; y: number }, target: { x: number; y: number }) =>
        Math.abs(source.x - target.x) + Math.abs(source.y - target.y)

      const result = Graph.astar(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge,
        heuristic
      })
      assertNone(result)
    })

    it("should handle same source and target", () => {
      const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
        Graph.addNode(mutable, { x: 0, y: 0 })
      })

      const heuristic = (source: { x: number; y: number }, target: { x: number; y: number }) =>
        Math.abs(source.x - target.x) + Math.abs(source.y - target.y)

      const result = Graph.astar(graph, {
        source: 0,
        target: 0,
        cost: (edge) => edge,
        heuristic
      })

      assertSome(result, { path: [0], distance: 0, costs: [] })
    })

    it("should throw for negative weights", () => {
      const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
        const a = Graph.addNode(mutable, { x: 0, y: 0 })
        const b = Graph.addNode(mutable, { x: 1, y: 0 })
        Graph.addEdge(mutable, a, b, -1)
      })

      const heuristic = (source: { x: number; y: number }, target: { x: number; y: number }) =>
        Math.abs(source.x - target.x) + Math.abs(source.y - target.y)

      expect(() =>
        Graph.astar(graph, {
          source: 0,
          target: 1,
          cost: (edge) => edge,
          heuristic
        })
      ).toThrow("A* algorithm requires non-negative edge weights")
    })

    it("should throw for NaN and negative infinity weights", () => {
      for (const weight of unsupportedEdgeWeights) {
        const graph = makeSingleEdgeGraph(weight)

        assertGraphError(
          () =>
            Graph.astar(graph, {
              source: 0,
              target: 1,
              cost: (edge) => edge,
              heuristic: () => 0
            }),
          "A* algorithm requires non-negative edge weights"
        )
      }
    })

    it("should treat infinity weights as unreachable", () => {
      const graph = makeSingleEdgeGraph(Infinity)

      const result = Graph.astar(graph, {
        source: 0,
        target: 1,
        cost: (edge) => edge,
        heuristic: () => 0
      })

      assertNone(result)
    })

    it("should throw for negative weights before early target termination", () => {
      const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
        const source = Graph.addNode(mutable, { x: 0, y: 0 })
        const target = Graph.addNode(mutable, { x: 1, y: 0 })
        const other = Graph.addNode(mutable, { x: 2, y: 0 })
        Graph.addEdge(mutable, source, target, 1)
        Graph.addEdge(mutable, source, other, 2)
        Graph.addEdge(mutable, other, target, -5)
      })

      expect(() =>
        Graph.astar(graph, {
          source: 0,
          target: 1,
          cost: (edge) => edge,
          heuristic: () => 0
        })
      ).toThrow("A* algorithm requires non-negative edge weights")
    })

    it("should validate weights before returning same source and target", () => {
      const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
        const node = Graph.addNode(mutable, { x: 0, y: 0 })
        Graph.addEdge(mutable, node, node, -1)
      })

      expect(() =>
        Graph.astar(graph, {
          source: 0,
          target: 0,
          cost: (edge) => edge,
          heuristic: () => 0
        })
      ).toThrow("A* algorithm requires non-negative edge weights")
    })

    it("should traverse undirected edges in reverse storage direction", () => {
      const graph = makeReversedUndirectedPath()

      const result = Graph.astar(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge,
        heuristic: () => 0
      })

      assertSome(result, { path: [0, 1, 2], distance: 2, costs: [1, 1] })
    })
  })

  describe("Bellman-Ford", () => {
    it("should find shortest path with negative weights", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, -1)
        Graph.addEdge(mutable, b, c, 3)
        Graph.addEdge(mutable, a, c, 5)
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge
      })

      assertSome(result, { path: [0, 1, 2], distance: 2, costs: [-1, 3] })
    })

    it("should return None for unreachable nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        // No path from A to C
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge
      })

      assertNone(result)
    })

    it("should handle same source and target", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 0,
        cost: (edge) => edge
      })

      assertSome(result, { path: [0], distance: 0, costs: [] })
    })

    it("should throw for NaN and negative infinity weights", () => {
      for (const weight of unsupportedEdgeWeights) {
        const graph = makeSingleEdgeGraph(weight)

        assertGraphError(
          () =>
            Graph.bellmanFord(graph, {
              source: 0,
              target: 1,
              cost: (edge) => edge
            }),
          "Bellman-Ford algorithm does not support NaN or -Infinity edge weights"
        )
      }
    })

    it("should treat infinity weights as unreachable", () => {
      const graph = makeSingleEdgeGraph(Infinity)

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 1,
        cost: (edge) => edge
      })

      assertNone(result)
    })

    it("should detect a directed negative self-loop when source equals target", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const node = Graph.addNode(mutable, "A")
        Graph.addEdge(mutable, node, node, -1)
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 0,
        cost: (edge) => edge
      })

      assertNone(result)
    })

    it("should detect an undirected negative self-loop when source equals target", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const node = Graph.addNode(mutable, "A")
        Graph.addEdge(mutable, node, node, -1)
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 0,
        cost: (edge) => edge
      })

      assertNone(result)
    })

    it("should detect negative cycles", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, -3)
        Graph.addEdge(mutable, c, a, 1)
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge
      })

      expect(result).toEqual(Option.none())
    })

    it("should traverse undirected edges in reverse storage direction", () => {
      const graph = makeReversedUndirectedPath()

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 2,
        cost: (edge) => edge
      })

      assertSome(result, { path: [0, 1, 2], distance: 2, costs: [1, 1] })
    })

    it("should treat a reachable negative undirected edge as a negative cycle", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, -1)
      })

      const result = Graph.bellmanFord(graph, {
        source: 0,
        target: 1,
        cost: (edge) => edge
      })

      assertNone(result)
    })
  })

  describe("Floyd-Warshall", () => {
    it("should find all-pairs shortest paths", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 3)
        Graph.addEdge(mutable, b, c, 2)
        Graph.addEdge(mutable, a, c, 7)
      })

      const result = Graph.floydWarshall(graph, (edge) => edge)

      // Check distance A to C (should be 5 via B, not 7 direct)
      expect(result.distances.get(0)?.get(2)).toBe(5)
      expect(result.paths.get(0)?.get(2)).toEqual([0, 1, 2])
      expect(result.costs.get(0)?.get(2)).toEqual([3, 2])

      // Check distance A to B
      expect(result.distances.get(0)?.get(1)).toBe(3)
      expect(result.paths.get(0)?.get(1)).toEqual([0, 1])

      // Check distance B to C
      expect(result.distances.get(1)?.get(2)).toBe(2)
      expect(result.paths.get(1)?.get(2)).toEqual([1, 2])
    })

    it("should handle unreachable nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        // No path from A to C
      })

      const result = Graph.floydWarshall(graph, (edge) => edge)

      expect(result.distances.get(0)?.get(2)).toBe(Infinity)
      expect(result.paths.get(0)?.get(2)).toBeNull()
    })

    it("should handle same source and target", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })

      const result = Graph.floydWarshall(graph, (edge) => edge)

      expect(result.distances.get(0)?.get(0)).toBe(0)
      expect(result.paths.get(0)?.get(0)).toEqual([0])
      expect(result.costs.get(0)?.get(0)).toEqual([])
    })

    it("should throw for NaN and negative infinity weights", () => {
      for (const weight of unsupportedEdgeWeights) {
        const graph = makeSingleEdgeGraph(weight)

        assertGraphError(
          () => Graph.floydWarshall(graph, (edge) => edge),
          "Floyd-Warshall algorithm does not support NaN or -Infinity edge weights"
        )
      }
    })

    it("should treat infinity weights as unreachable", () => {
      const graph = makeSingleEdgeGraph(Infinity)

      const result = Graph.floydWarshall(graph, (edge) => edge)

      expect(result.distances.get(0)?.get(1)).toBe(Infinity)
      expect(result.paths.get(0)?.get(1)).toBeNull()
      expect(result.costs.get(0)?.get(1)).toEqual([])
    })

    it("should preserve null edge data in direct paths", () => {
      const graph = Graph.directed<string, null>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, null)
      })

      const result = Graph.floydWarshall(graph, () => 1)

      assert.strictEqual(result.distances.get(0)?.get(1), 1)
      assert.deepStrictEqual(result.paths.get(0)?.get(1), [0, 1])
      assert.deepStrictEqual(result.costs.get(0)?.get(1), [null])
    })

    it("should preserve null edge data in multihop paths", () => {
      type EdgeData = null | { readonly weight: number }

      const graph = Graph.directed<string, EdgeData>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, null)
        Graph.addEdge(mutable, b, c, null)
        Graph.addEdge(mutable, a, c, { weight: 10 })
      })

      const result = Graph.floydWarshall(graph, (edge) => edge === null ? 1 : edge.weight)

      assert.strictEqual(result.distances.get(0)?.get(2), 2)
      assert.deepStrictEqual(result.paths.get(0)?.get(2), [0, 1, 2])
      assert.deepStrictEqual(result.costs.get(0)?.get(2), [null, null])
    })

    it("should detect negative cycles", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, -3)
        Graph.addEdge(mutable, c, a, 1)
      })

      expect(() => Graph.floydWarshall(graph, (edge) => edge)).toThrow("Negative cycle detected")
    })

    it("should traverse undirected edges in reverse storage direction", () => {
      const graph = makeReversedUndirectedPath()

      const result = Graph.floydWarshall(graph, (edge) => edge)

      expect(result.distances.get(0)?.get(2)).toBe(2)
      expect(result.paths.get(0)?.get(2)).toEqual([0, 1, 2])
      expect(result.costs.get(0)?.get(2)).toEqual([1, 1])
    })

    it("should treat negative undirected edges as negative cycles", () => {
      const graph = Graph.undirected<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, -1)
      })

      expect(() => Graph.floydWarshall(graph, (edge) => edge)).toThrow("Negative cycle detected")
    })
  })

  describe("Iterator Base Methods", () => {
    const staleTraversalNodeCount = 20000

    const makeSparseMutableGraph = () => {
      const graph = Graph.directed<string, number>((mutable) => {
        for (let i = 0; i < staleTraversalNodeCount; i++) {
          Graph.addNode(mutable, String(i))
        }
      })
      return {
        mutable: Graph.beginMutation(graph),
        start: Array.from({ length: staleTraversalNodeCount }, (_, index) => index)
      }
    }

    const removeNodes = (mutable: Graph.MutableDirectedGraph<string, number>, nodes: Array<Graph.NodeIndex>) => {
      for (const node of nodes) {
        Graph.removeNode(mutable, node)
      }
    }

    it("should provide values() method for DFS iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const dfsIterator = Graph.dfs(graph, { start: [0] })
      const values = Array.from(Graph.values(dfsIterator))

      expect(values).toEqual(["A", "B", "C"])
    })

    it("should provide entries() method for DFS iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const dfsIterator = Graph.dfs(graph, { start: [0] })
      const entries = Array.from(Graph.entries(dfsIterator))

      expect(entries).toEqual([[0, "A"], [1, "B"], [2, "C"]])
    })

    it("should provide values() method for BFS iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, a, c, 2)
      })

      const bfsIterator = Graph.bfs(graph, { start: [0] })
      const values = Array.from(Graph.values(bfsIterator))

      expect(values).toEqual(["A", "B", "C"])
    })

    it("should provide entries() method for BFS iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, a, c, 2)
      })

      const bfsIterator = Graph.bfs(graph, { start: [0] })
      const entries = Array.from(Graph.entries(bfsIterator))

      expect(entries).toEqual([[0, "A"], [1, "B"], [2, "C"]])
    })

    it("should skip stale BFS nodes without recursion", () => {
      const { mutable, start } = makeSparseMutableGraph()
      const iterator = Graph.indices(Graph.bfs(mutable, { start }))[Symbol.iterator]()

      removeNodes(mutable, start)

      assert.strictEqual(iterator.next().done, true)
    })

    it("should limit DFS traversal by radius", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
        Graph.addEdge(mutable, c, d, 3)
      })

      const dfsIterator = Graph.dfs(graph, { start: [0], radius: 1 })

      assert.deepStrictEqual(Array.from(Graph.indices(dfsIterator)), [0, 1])
    })

    it("should use the shortest discovered depth when limiting DFS traversal", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
        Graph.addEdge(mutable, a, c, 3)
        Graph.addEdge(mutable, c, d, 4)
      })

      const dfsIterator = Graph.dfs(graph, { start: [0], radius: 2 })

      assert.deepStrictEqual(Array.from(Graph.indices(dfsIterator)), [0, 1, 2, 3])
    })

    it("should limit BFS traversal by radius", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, a, c, 2)
        Graph.addEdge(mutable, b, d, 3)
      })

      const bfsIterator = Graph.bfs(graph, { start: [0], radius: 1 })

      assert.deepStrictEqual(Array.from(Graph.indices(bfsIterator)), [0, 1, 2])
    })

    it("should only include start nodes when radius is zero", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      assert.deepStrictEqual(Array.from(Graph.indices(Graph.dfs(graph, { start: [0], radius: 0 }))), [0])
      assert.deepStrictEqual(Array.from(Graph.indices(Graph.bfs(graph, { start: [0], radius: 0 }))), [0])
    })

    it("should provide values() method for Topo iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const topoIterator = Graph.topo(graph)

      const values = Array.from(Graph.values(topoIterator))
      expect(values).toEqual(["A", "B", "C"])
    })

    it("should provide entries() method for Topo iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const topoIterator = Graph.topo(graph)

      const entries = Array.from(Graph.entries(topoIterator))
      expect(entries).toEqual([[0, "A"], [1, "B"], [2, "C"]])
    })

    it("should skip stale topological sort nodes without recursion", () => {
      const { mutable, start } = makeSparseMutableGraph()
      const iterator = Graph.indices(Graph.topo(mutable))[Symbol.iterator]()

      removeNodes(mutable, start)

      assert.strictEqual(iterator.next().done, true)
    })

    it("should reject cycles introduced before topological iteration", () => {
      const mutable = Graph.beginMutation(Graph.directed<string, number>((graph) => {
        Graph.addNode(graph, "A")
        Graph.addNode(graph, "B")
      }))
      const walker = Graph.topo(mutable)

      Graph.addEdge(mutable, 0, 1, 1)
      Graph.addEdge(mutable, 1, 0, 2)

      assertGraphError(
        () => Array.from(Graph.indices(walker)),
        "Cannot perform topological sort on cyclic graph"
      )
    })

    it("should use fresh graph state for each topological iteration", () => {
      const mutable = Graph.beginMutation(Graph.directed<string, number>((graph) => {
        Graph.addNode(graph, "A")
        Graph.addNode(graph, "B")
      }))
      const walker = Graph.topo(mutable)

      assert.deepStrictEqual(Array.from(Graph.indices(walker)), [0, 1])
      Graph.addEdge(mutable, 0, 1, 1)
      Graph.addEdge(mutable, 1, 0, 2)

      assertGraphError(
        () => Array.from(Graph.indices(walker)),
        "Cannot perform topological sort on cyclic graph"
      )
    })

    it("should prioritize valid initials and still include all nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, c, d, 2)
      })

      const order = Array.from(Graph.indices(Graph.topo(graph, { initials: [2] })))
      expect(order).toEqual([2, 0, 3, 1])
    })

    it("should reject initials with incoming edges", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      expect(() => Array.from(Graph.topo(graph, { initials: [1] })))
        .toThrow("Initial node 1 has incoming edges")
    })

    it("should throw for cyclic graphs", () => {
      const cyclicGraph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, a, 2) // Creates cycle
      })

      expect(() => Graph.topo(cyclicGraph)).toThrow("Cannot perform topological sort on cyclic graph")
    })

    it("should throw for undirected graphs", () => {
      const graph = makeReversedUndirectedPath()

      expect(() => Graph.topo(graph as any)).toThrow("Cannot perform topological sort on undirected graph")
    })

    it("should handle corrupted graph state during topological sort", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      // Test edge case by corrupting graph internals during iteration
      const mutableGraph = graph as any
      const originalGetNode = mutableGraph.nodes.get

      let callCount = 0
      // Mock getNode to return undefined for certain calls to trigger the recursive edge case
      mutableGraph.nodes.get = function(key: any) {
        callCount++
        // On specific call, return undefined to trigger the Option.isNone path
        if (callCount === 2) {
          return undefined
        }
        return originalGetNode.call(this, key)
      }

      const iterator = Graph.topo(graph)
      const results = Array.from(iterator)

      // Restore original method
      mutableGraph.nodes.get = originalGetNode

      // Should complete without crashing
      expect(results.length).toBeGreaterThanOrEqual(0)
    })

    it("should provide values() method for DfsPostOrder iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const dfsPostIterator = Graph.dfsPostOrder(graph, { start: [0] })
      const values = Array.from(Graph.values(dfsPostIterator))

      expect(values).toEqual(["C", "B", "A"]) // Postorder: children before parents
    })

    it("should provide entries() method for DfsPostOrder iterator", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const dfsPostIterator = Graph.dfsPostOrder(graph, { start: [0] })
      const entries = Array.from(Graph.entries(dfsPostIterator))

      expect(entries).toEqual([[2, "C"], [1, "B"], [0, "A"]]) // Postorder: children before parents
    })

    it("should skip stale DFS postorder nodes without recursion", () => {
      const { mutable, start } = makeSparseMutableGraph()
      const iterator = Graph.indices(Graph.dfsPostOrder(mutable, { start }))[Symbol.iterator]()

      removeNodes(mutable, start)

      assert.strictEqual(iterator.next().done, true)
    })

    it("should traverse undirected edges in reverse storage direction", () => {
      const graph = makeReversedUndirectedPath()

      expect(Array.from(Graph.indices(Graph.dfs(graph, { start: [0] })))).toEqual([0, 1, 2])
      expect(Array.from(Graph.indices(Graph.dfs(graph, { start: [0], direction: "incoming" })))).toEqual([0, 1, 2])
      expect(Array.from(Graph.indices(Graph.bfs(graph, { start: [0] })))).toEqual([0, 1, 2])
      expect(Array.from(Graph.indices(Graph.dfsPostOrder(graph, { start: [0] })))).toEqual([2, 1, 0])
    })

    it("should ignore edge direction during traversal", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, a, c, 2)
      })

      assert.deepStrictEqual(
        Array.from(Graph.indices(Graph.dfs(graph, { start: [1], direction: "undirected" }))),
        [1, 0, 2]
      )
      assert.deepStrictEqual(
        Array.from(Graph.indices(Graph.bfs(graph, { start: [1], direction: "undirected" }))),
        [1, 0, 2]
      )
    })
  })

  describe("DfsPostOrder Iterator", () => {
    it("should limit traversal by radius", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      assert.deepStrictEqual(
        Array.from(Graph.indices(Graph.dfsPostOrder(graph, { start: [0], radius: 1 }))),
        [1, 0]
      )
    })

    it("should traverse in postorder for simple chain", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      const postOrder = Array.from(Graph.indices(Graph.dfsPostOrder(graph, { start: [0] })))
      expect(postOrder).toEqual([2, 1, 0]) // Children before parents
    })

    it("should traverse in postorder for branching tree", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const root = Graph.addNode(mutable, "root") // 0
        const left = Graph.addNode(mutable, "left") // 1
        const right = Graph.addNode(mutable, "right") // 2
        const leaf1 = Graph.addNode(mutable, "leaf1") // 3
        const leaf2 = Graph.addNode(mutable, "leaf2") // 4

        Graph.addEdge(mutable, root, left, 1)
        Graph.addEdge(mutable, root, right, 2)
        Graph.addEdge(mutable, left, leaf1, 3)
        Graph.addEdge(mutable, right, leaf2, 4)
      })

      const postOrder = Array.from(Graph.indices(Graph.dfsPostOrder(graph, { start: [0] })))
      // Should visit leaves first, then parents
      expect(postOrder).toEqual([3, 1, 4, 2, 0])
    })

    it("should handle empty start nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })

      const postOrder = Array.from(Graph.dfsPostOrder(graph, { start: [] }))
      expect(postOrder).toEqual([])
    })

    it("should handle disconnected components with multiple start nodes", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        const d = Graph.addNode(mutable, "D")

        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, c, d, 2)
        // No connection between (A,B) and (C,D)
      })

      const postOrder = Array.from(Graph.indices(Graph.dfsPostOrder(graph, { start: [0, 2] })))
      expect(postOrder).toEqual([1, 0, 3, 2]) // Each component in postorder
    })

    it("should support incoming direction", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      // Starting from C, going backwards
      const postOrder = Array.from(
        Graph.indices(Graph.dfsPostOrder(graph, {
          start: [2],
          direction: "incoming"
        }))
      )
      expect(postOrder).toEqual([0, 1, 2]) // A, B, C in reverse postorder
    })

    it("should handle cycles correctly", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
        Graph.addEdge(mutable, c, a, 3) // Creates cycle
      })

      const postOrder = Array.from(Graph.indices(Graph.dfsPostOrder(graph, { start: [0] })))
      // Should handle cycle without infinite loop, visiting each node once
      expect(postOrder.length).toBe(3)
      expect(new Set(postOrder)).toEqual(new Set([0, 1, 2]))
    })

    it("should throw error for non-existent start node", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        Graph.addNode(mutable, "A")
      })

      expect(() => Graph.dfsPostOrder(graph, { start: [99] }))
        .toThrow("Node 99 does not exist")
    })

    it("should be iterable multiple times with fresh state", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      const iterator = Graph.dfsPostOrder(graph, { start: [0] })

      const firstRun = Array.from(Graph.indices(iterator))
      const secondRun = Array.from(Graph.indices(iterator))

      expect(firstRun).toEqual([1, 0])
      expect(secondRun).toEqual([1, 0])
      expect(firstRun).toEqual(secondRun)
    })

    it("should handle corrupted graph state during iteration", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      // Test edge case by corrupting graph internals during iteration
      const mutableGraph = graph as any
      const originalGetNode = mutableGraph.nodes.get

      let callCount = 0
      // Mock getNode to return undefined for certain calls to trigger the recursive edge case
      mutableGraph.nodes.get = function(key: any) {
        callCount++
        // On specific call, return undefined to trigger the Option.isNone path
        if (callCount === 3) {
          return undefined
        }
        return originalGetNode.call(this, key)
      }

      const iterator = Graph.dfsPostOrder(graph, { start: [0] })
      const results = Array.from(iterator)

      // Restore original method
      mutableGraph.nodes.get = originalGetNode

      // Should complete without crashing
      expect(results.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe("Graph Element Iterators", () => {
    describe("nodes", () => {
      it("should iterate over all node indices", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          Graph.addNode(mutable, "A")
          Graph.addNode(mutable, "B")
          Graph.addNode(mutable, "C")
        })

        const indices = Array.from(Graph.indices(Graph.nodes(graph)))
        expect(indices).toEqual([0, 1, 2])
      })

      it("should work with manual iterator control", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          Graph.addNode(mutable, "A")
          Graph.addNode(mutable, "B")
        })

        const iterator = Graph.indices(Graph.nodes(graph))[Symbol.iterator]()
        expect(iterator.next().value).toBe(0)
        expect(iterator.next().value).toBe(1)
        expect(iterator.next().done).toBe(true)
      })
    })

    describe("edges", () => {
      it("should iterate over all edge indices", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, 1)
          Graph.addEdge(mutable, b, c, 2)
          Graph.addEdge(mutable, c, a, 3)
        })

        const indices = Array.from(Graph.indices(Graph.edges(graph)))
        expect(indices).toEqual([0, 1, 2])
      })

      it("should handle graph with no edges", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          Graph.addNode(mutable, "A")
          Graph.addNode(mutable, "B")
        })

        const indices = Array.from(Graph.indices(Graph.edges(graph)))
        expect(indices).toEqual([])
      })
    })

    describe("externals", () => {
      it("should find nodes with no outgoing edges (sinks)", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const source = Graph.addNode(mutable, "source") // 0
          const middle = Graph.addNode(mutable, "middle") // 1
          const sink = Graph.addNode(mutable, "sink") // 2
          Graph.addNode(mutable, "isolated") // 3

          Graph.addEdge(mutable, source, middle, 1)
          Graph.addEdge(mutable, middle, sink, 2)
          // No outgoing edges from sink (2) or isolated (3)
        })

        const sinks = Array.from(Graph.indices(Graph.externals(graph, { direction: "outgoing" })))
        expect(sinks.sort()).toEqual([2, 3])
      })

      it("should find nodes with no incoming edges (sources)", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const source = Graph.addNode(mutable, "source") // 0
          const middle = Graph.addNode(mutable, "middle") // 1
          const sink = Graph.addNode(mutable, "sink") // 2
          Graph.addNode(mutable, "isolated") // 3

          Graph.addEdge(mutable, source, middle, 1)
          Graph.addEdge(mutable, middle, sink, 2)
          // No incoming edges to source (0) or isolated (3)
        })

        const sources = Array.from(Graph.indices(Graph.externals(graph, { direction: "incoming" })))
        expect(sources.sort()).toEqual([0, 3])
      })

      it("should default to outgoing direction", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addEdge(mutable, a, b, 1)
          // b has no outgoing edges
        })

        const externalsDefault = Array.from(Graph.indices(Graph.externals(graph)))
        const externalsExplicit = Array.from(Graph.indices(Graph.externals(graph, { direction: "outgoing" })))

        expect(externalsDefault).toEqual(externalsExplicit)
        expect(externalsDefault).toEqual([1])
      })

      it("should handle fully connected components", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          const c = Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, 1)
          Graph.addEdge(mutable, b, c, 2)
          Graph.addEdge(mutable, c, a, 3) // Creates cycle
        })

        const outgoingExternals = Array.from(Graph.indices(Graph.externals(graph, { direction: "outgoing" })))
        const incomingExternals = Array.from(Graph.indices(Graph.externals(graph, { direction: "incoming" })))

        expect(outgoingExternals).toEqual([]) // All nodes have outgoing edges
        expect(incomingExternals).toEqual([]) // All nodes have incoming edges
      })

      it("should work with manual iterator control", () => {
        const graph = Graph.directed<string, number>((mutable) => {
          const a = Graph.addNode(mutable, "A")
          const b = Graph.addNode(mutable, "B")
          Graph.addNode(mutable, "C")
          Graph.addEdge(mutable, a, b, 1)
          // b and c have no outgoing edges
        })

        const iterator = Graph.indices(Graph.externals(graph, { direction: "outgoing" }))[Symbol.iterator]()

        const first = iterator.next().value
        const second = iterator.next().value
        const third = iterator.next()

        expect([first, second].sort()).toEqual([1, 2])
        expect(third.done).toBe(true)
      })
    })

    it("should allow combining different element iterators", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 100)
      })

      // Combine different iterators
      const nodeCount = Array.from(Graph.indices(Graph.nodes(graph))).length
      const edgeCount = Array.from(Graph.indices(Graph.edges(graph))).length
      const nodeData = Array.from(Graph.values(Graph.nodes(graph)))
      const edge = Array.from(Graph.values(Graph.edges(graph)))

      expect(nodeCount).toBe(2)
      expect(edgeCount).toBe(1)
      expect(nodeData).toEqual(["A", "B"])
      expect(edge).toEqual([{ source: 0, target: 1, data: 100 }])
    })
  })

  describe("GraphIterable abstraction", () => {
    it("should enable iteration over different types", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      // Should work with different iterator types
      const dfsIterable = Graph.dfs(graph, { start: [0] })
      const nodesIterable = Graph.nodes(graph)
      const externalsIterable = Graph.externals(graph)

      // All should be iterable and have expected structure
      expect(Array.from(dfsIterable)).toHaveLength(3)
      expect(Array.from(nodesIterable)).toHaveLength(3)
      expect(Array.from(externalsIterable)).toHaveLength(1) // Only one node with no outgoing edges
    })

    it("should preserve the receiver for iterable iterator methods", () => {
      const walker = new Graph.Walker<number, string>((f) => new Set([f(0, "A"), f(1, "B")]))

      assert.deepStrictEqual(Array.from(walker), [[0, "A"], [1, "B"]])
    })

    it("should create fresh iterators for generator-backed walkers", () => {
      const walker = new Graph.Walker<number, string>(function*(f) {
        yield f(0, "A")
        yield f(1, "B")
      })

      const assertRepeated = <A>(iterable: Iterable<A>, expected: Array<A>) => {
        assert.deepStrictEqual(Array.from(iterable), expected)
        assert.deepStrictEqual(Array.from(iterable), expected)
      }

      assertRepeated(walker, [[0, "A"], [1, "B"]])
      assert.deepStrictEqual(Array.from(walker.visit((index, data) => `${index}:${data}`)), ["0:A", "1:B"])
      assert.deepStrictEqual(Array.from(walker.visit((index, data) => `${index}:${data}`)), ["0:A", "1:B"])
      assert.deepStrictEqual(Array.from(Graph.indices(walker)), [0, 1])
      assert.deepStrictEqual(Array.from(Graph.indices(walker)), [0, 1])
      assert.deepStrictEqual(Array.from(Graph.values(walker)), ["A", "B"])
      assert.deepStrictEqual(Array.from(Graph.values(walker)), ["A", "B"])
      assert.deepStrictEqual(Array.from(Graph.entries(walker)), [[0, "A"], [1, "B"]])
      assert.deepStrictEqual(Array.from(Graph.entries(walker)), [[0, "A"], [1, "B"]])

      const left = walker[Symbol.iterator]()
      const right = walker[Symbol.iterator]()
      assert.deepStrictEqual(left.next(), { done: false, value: [0, "A"] })
      assert.deepStrictEqual(right.next(), { done: false, value: [0, "A"] })
      assert.deepStrictEqual(left.next(), { done: false, value: [1, "B"] })
      assert.deepStrictEqual(right.next(), { done: false, value: [1, "B"] })
      assert.deepStrictEqual(left.next(), { done: true, value: undefined })
      assert.deepStrictEqual(right.next(), { done: true, value: undefined })
    })
  })

  describe("NodeIterable abstraction", () => {
    it("should provide common interface for node index iterables", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      // Utility function that works with any NodeWalker
      function collectNodes<N>(
        nodeIterable: Graph.NodeWalker<N>
      ): Array<number> {
        return Array.from(Graph.indices(nodeIterable)).sort()
      }

      // Both traversal and element iterators implement NodeWalker
      const dfsNodes = Graph.dfs(graph, { start: [0] })
      const allNodes = Graph.nodes(graph)
      const externalNodes = Graph.externals(graph, { direction: "outgoing" })

      // All should work with the same utility function
      expect(collectNodes(dfsNodes)).toEqual([0, 1, 2])
      expect(collectNodes(allNodes)).toEqual([0, 1, 2])
      expect(collectNodes(externalNodes)).toEqual([2]) // Only node 2 has no outgoing edges
    })

    it("should allow type-safe node iterable operations", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      const nodeIterable: Graph.NodeWalker<string> = Graph.nodes(graph)
      const traversalIterable: Graph.NodeWalker<string> = Graph.dfs(graph, {
        start: [0]
      })

      expect(Array.from(Graph.indices(nodeIterable))).toEqual([0, 1])
      expect(Array.from(Graph.indices(traversalIterable))).toEqual([0, 1])
    })
  })

  describe("Standalone utility functions", () => {
    it("should work with values() function on any NodeIterable", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        const c = Graph.addNode(mutable, "C")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, c, 2)
      })

      // Test with traversal iterators
      const dfsIterable = Graph.dfs(graph, { start: [0] })
      const dfsValues = Array.from(Graph.values(dfsIterable))
      expect(dfsValues).toEqual(["A", "B", "C"])

      // Test with element iterators
      const nodesIterable = Graph.nodes(graph)
      const nodeValues = Array.from(Graph.values(nodesIterable))
      expect(nodeValues.sort()).toEqual(["A", "B", "C"])

      // Test with externals iterator
      const externalsIterable = Graph.externals(graph, { direction: "outgoing" })
      const externalValues = Array.from(Graph.values(externalsIterable))
      expect(externalValues).toEqual(["C"]) // Only C has no outgoing edges
    })

    it("should work with entries() function on any NodeIterable", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      // Test with traversal iterator
      const dfsIterable = Graph.dfs(graph, { start: [0] })
      const dfsEntries = Array.from(Graph.entries(dfsIterable))
      expect(dfsEntries).toEqual([[0, "A"], [1, "B"]])

      // Test with element iterator
      const nodesIterable = Graph.nodes(graph)
      const nodeEntries = Array.from(Graph.entries(nodesIterable))
      expect(nodeEntries.sort()).toEqual([[0, "A"], [1, "B"]])

      // Test with externals iterator
      const externalsIterable = Graph.externals(graph, { direction: "outgoing" })
      const externalEntries = Array.from(Graph.entries(externalsIterable))
      expect(externalEntries).toEqual([[1, "B"]]) // Only B has no outgoing edges
    })

    it("should work with instance methods", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      const dfs = Graph.dfs(graph, { start: [0] })

      // Instance methods should work
      const instanceValues = Array.from(Graph.values(dfs))
      const instanceEntries = Array.from(Graph.entries(dfs))

      expect(instanceValues).toEqual(["A", "B"])
      expect(instanceEntries).toEqual([[0, "A"], [1, "B"]])
    })

    it("should work with mapEntry for NodeIterable", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
      })

      const dfs = Graph.dfs(graph, { start: [0] })

      // Test mapEntry with custom mapping
      const custom = Array.from(dfs.visit((index, data) => ({ id: index, name: data })))
      expect(custom).toEqual([{ id: 0, name: "A" }, { id: 1, name: "B" }])

      // Test that values() is implemented using mapEntry
      const values = Array.from(Graph.values(dfs))
      expect(values).toEqual(["A", "B"])

      // Test that entries() is implemented using mapEntry
      const entries = Array.from(Graph.entries(dfs))
      expect(entries).toEqual([[0, "A"], [1, "B"]])
    })

    it("should work with mapEntry for EdgeIterable", () => {
      const graph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 42)
      })

      const edgesIterable = Graph.edges(graph)

      // Test mapEntry with custom mapping
      const connections = Array.from(edgesIterable.visit((index, edge) => ({
        id: index,
        from: edge.source,
        to: edge.target,
        weight: edge.data
      })))
      expect(connections).toEqual([{ id: 0, from: 0, to: 1, weight: 42 }])

      // Test that values() is implemented using mapEntry
      const weights = Array.from(edgesIterable.visit((_, edge) => edge.data))
      expect(weights).toEqual([42])

      // Test that entries() is implemented using mapEntry
      const entries = Array.from(Graph.entries(edgesIterable))
      expect(entries).toEqual([[0, { source: 0, target: 1, data: 42 }]])
    })
  })
})
