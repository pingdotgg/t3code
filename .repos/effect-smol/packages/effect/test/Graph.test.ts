import { assertNone, assertSome, strictEqual } from "@effect/vitest/utils"
import { Equal, Graph, Hash, Option } from "effect"
import { describe, expect, it } from "vitest"

const assertSomeEdge = <E>(edge: Option.Option<Graph.Edge<E>>): Graph.Edge<E> => {
  if (Option.isNone(edge)) {
    throw new Error("Expected edge to be present")
  }
  return edge.value
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

      expect(Graph.isGraph(directedGraph)).toBe(true)
      expect(Graph.isGraph(undirectedGraph)).toBe(true)
    })

    it("should return false for non-graph values", () => {
      expect(Graph.isGraph({})).toBe(false)
      expect(Graph.isGraph(null)).toBe(false)
      expect(Graph.isGraph(undefined)).toBe(false)
      expect(Graph.isGraph("string")).toBe(false)
      expect(Graph.isGraph(42)).toBe(false)
      expect(Graph.isGraph([])).toBe(false)
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

      expect(assertSomeEdge(edge0).data).toBe(20)
      expect(assertSomeEdge(edge1).data).toBe(40)
      expect(assertSomeEdge(edge2).data).toBe(60)
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

      expect(assertSomeEdge(edge1).data).toBe(30) // 15 * 2
      expect(assertSomeEdge(edge2).data).toBe(50) // 25 * 2

      // Filtered out edge should not exist
      expect(Graph.getEdge(graph, 0)).toEqual(Option.none())
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
        const edge2Data = mutable.edges.get(edge2)
        expect(edge2Data).toBeDefined()
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
    })
  })

  describe("toGraphViz", () => {
    it("should export empty directed graph", () => {
      const graph = Graph.directed<string, number>()
      const dot = Graph.toGraphViz(graph)

      expect(dot).toBe("digraph G {\n}")
    })

    it("should export empty undirected graph", () => {
      const graph = Graph.undirected<string, number>()
      const dot = Graph.toGraphViz(graph)

      expect(dot).toBe("graph G {\n}")
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

      expect(dot).toContain("digraph G {")
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

      expect(dot).toContain("graph G {")
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

      expect(dot).toContain("digraph MyGraph {")
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

      expect(dot).toContain("digraph DependencyGraph {")
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

      expect(dot).toContain("graph SocialNetwork {")
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
  })

  describe("Iterator Base Methods", () => {
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

    it("should throw for cyclic graphs", () => {
      const cyclicGraph = Graph.directed<string, number>((mutable) => {
        const a = Graph.addNode(mutable, "A")
        const b = Graph.addNode(mutable, "B")
        Graph.addEdge(mutable, a, b, 1)
        Graph.addEdge(mutable, b, a, 2) // Creates cycle
      })

      expect(() => Graph.topo(cyclicGraph)).toThrow("Cannot perform topological sort on cyclic graph")
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
  })

  describe("DfsPostOrder Iterator", () => {
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
