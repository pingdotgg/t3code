/**
 * The `Graph` module provides immutable and scoped-mutable graph data
 * structures for modeling relationships between indexed nodes and edges. A
 * graph can be directed or undirected, stores user-defined data on both nodes
 * and edges, and exposes traversal, analysis, path finding, transformation, and
 * diagram export utilities.
 *
 * **Mental model**
 *
 * - Nodes and edges are addressed by stable numeric indices: {@link NodeIndex}
 *   and {@link EdgeIndex}
 * - Node data has type `N`; edge data has type `E`
 * - {@link Graph} values are immutable snapshots; use {@link MutableGraph}
 *   through {@link mutate}, {@link beginMutation}, or constructor callbacks to
 *   add, remove, or update nodes and edges
 * - Directed graphs follow edge direction for neighbors and traversals, while
 *   undirected graphs treat each edge as connecting both endpoints
 * - Missing lookups return `Option`, while structurally invalid operations such
 *   as adding an edge to a missing node throw {@link GraphError}
 *
 * **Common tasks**
 *
 * - Create graphs: {@link directed}, {@link undirected}
 * - Mutate safely: {@link mutate}, {@link addNode}, {@link addEdge},
 *   {@link removeNode}, {@link removeEdge}
 * - Query contents: {@link getNode}, {@link getEdge}, {@link hasNode},
 *   {@link hasEdge}, {@link nodeCount}, {@link edgeCount}, {@link neighbors}
 * - Transform data: {@link updateNode}, {@link updateEdge}, {@link mapNodes},
 *   {@link mapEdges}, {@link filterNodes}, {@link filterEdges},
 *   {@link filterMapNodes}, {@link filterMapEdges}
 * - Traverse lazily: {@link dfs}, {@link bfs}, {@link topo},
 *   {@link dfsPostOrder}, {@link nodes}, {@link edges}, {@link Walker}
 * - Analyze structure: {@link isAcyclic}, {@link isBipartite},
 *   {@link connectedComponents}, {@link stronglyConnectedComponents},
 *   {@link externals}
 * - Find paths: {@link dijkstra}, {@link astar}, {@link bellmanFord},
 *   {@link floydWarshall}
 * - Export diagrams: {@link toGraphViz}, {@link toMermaid}
 *
 * **Gotchas**
 *
 * - Only mutable graphs can be changed. Create one with {@link mutate} or by
 *   passing a callback to {@link directed} / {@link undirected}.
 * - Traversal APIs return lazy {@link Walker} values. Use {@link indices},
 *   {@link values}, or {@link entries} to choose what each iteration yields.
 * - `NodeIndex` and `EdgeIndex` values are identifiers, not array offsets. They
 *   are not reused after removals.
 * - Shortest-path algorithms require a cost function. {@link dijkstra} and
 *   {@link astar} reject negative weights; use {@link bellmanFord} or
 *   {@link floydWarshall} when negative weights are part of the model.
 *
 * @since 4.0.0
 */

import * as Data from "./Data.ts"
import * as Equal from "./Equal.ts"
import { dual } from "./Function.ts"
import * as Hash from "./Hash.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type { Mutable } from "./Types.ts"

const TypeId = "~effect/collections/Graph"

/**
 * Node index for node identification using plain numbers.
 *
 * **When to use**
 *
 * Use when storing or passing the stable identifier of a graph node between
 * `Graph` operations.
 *
 * **Details**
 *
 * `addNode` allocates node identifiers from the graph's next node index.
 *
 * **Gotchas**
 *
 * A `NodeIndex` is an identifier, not an array offset. Removed node identifiers
 * are not reused.
 *
 * @see {@link EdgeIndex} for edge identifiers instead of node identifiers
 * @see {@link addNode} for creating node identifiers
 *
 * @category models
 * @since 3.18.0
 */
export type NodeIndex = number

/**
 * Edge index for edge identification using plain numbers.
 *
 * **When to use**
 *
 * Use when you need to keep the identifier for a graph edge so you can later
 * read, update, remove, or compare that edge.
 *
 * **Gotchas**
 *
 * An `EdgeIndex` is an identifier, not an array offset. Removed edge
 * identifiers are not reused.
 *
 * @see {@link NodeIndex} for node identifiers instead of edge identifiers
 * @see {@link Edge} for the edge value addressed by this identifier
 * @see {@link addEdge} for creating edge identifiers
 * @see {@link getEdge} for reading edges by identifier
 *
 * @category models
 * @since 3.18.0
 */
export type EdgeIndex = number

/**
 * Represents edge data containing source, target, and user data.
 *
 * **When to use**
 *
 * Use as the graph edge value returned by `getEdge` and `edges` when you need
 * the source node, target node, and stored edge data together.
 *
 * @see {@link getEdge} for reading a single edge by identifier
 * @see {@link addEdge} for adding edges to a graph
 * @see {@link edges} for iterating graph edges
 *
 * @category models
 * @since 3.18.0
 */
export class Edge<E> extends Data.Class<{
  readonly source: NodeIndex
  readonly target: NodeIndex
  readonly data: E
}> {}

/**
 * Graph type for distinguishing directed and undirected graphs.
 *
 * **When to use**
 *
 * Use when writing graph-polymorphic types or helpers that need to preserve
 * whether a graph is directed or undirected.
 *
 * @see {@link Graph} for immutable graphs parameterized by kind
 * @see {@link MutableGraph} for mutable graphs parameterized by kind
 *
 * @category models
 * @since 3.18.0
 */
export type Kind = "directed" | "undirected"

/**
 * Common structural interface shared by immutable and mutable graphs.
 *
 * **Details**
 *
 * Contains the node and edge maps, adjacency indexes, allocation counters, and
 * shared protocols used by both `Graph` and `MutableGraph`.
 *
 * @category models
 * @since 3.18.0
 */
export interface Proto<out N, out E> extends Iterable<readonly [NodeIndex, N]>, Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly nodes: Map<NodeIndex, N>
  readonly edges: Map<EdgeIndex, Edge<E>>
  readonly adjacency: Map<NodeIndex, Array<EdgeIndex>>
  readonly reverseAdjacency: Map<NodeIndex, Array<EdgeIndex>>
  nextNodeIndex: NodeIndex
  nextEdgeIndex: EdgeIndex
  acyclic: Option.Option<boolean>
}

/**
 * Immutable graph interface.
 *
 * **When to use**
 *
 * Use as the immutable graph model for code that queries, traverses,
 * transforms, or analyzes graph structure without mutating it.
 *
 * @see {@link MutableGraph} for the mutable counterpart used inside mutation scopes
 * @see {@link DirectedGraph} for a `Graph` fixed to directed edges
 * @see {@link UndirectedGraph} for a `Graph` fixed to undirected edges
 *
 * @category models
 * @since 3.18.0
 */
export interface Graph<out N, out E, T extends Kind = "directed"> extends Proto<N, E> {
  readonly type: T
  readonly mutable: false
}

/**
 * Mutable graph interface.
 *
 * **When to use**
 *
 * Use when adding, removing, or updating nodes and edges inside a graph
 * mutation scope.
 *
 * @see {@link Graph} for the immutable graph interface
 * @see {@link mutate} for scoped mutation of an immutable graph
 * @see {@link beginMutation} for opening a mutable graph manually
 * @see {@link endMutation} for returning to an immutable graph
 *
 * @category models
 * @since 3.18.0
 */
export interface MutableGraph<out N, out E, T extends Kind = "directed"> extends Proto<N, E> {
  readonly type: T
  readonly mutable: true
}

/**
 * Immutable graph type for source-to-target relationships.
 *
 * **When to use**
 *
 * Use as the immutable graph type when edge direction is part of the model and
 * traversal or neighbor queries should follow source-to-target edges.
 *
 * **Details**
 *
 * `DirectedGraph<N, E>` is a `Graph<N, E, "directed">` with node data of type
 * `N` and edge data of type `E`.
 *
 * @see {@link directed} for constructing directed graphs
 * @see {@link Graph} for the generic immutable graph type
 * @see {@link UndirectedGraph} for graphs whose edges connect both endpoints
 * @see {@link MutableDirectedGraph} for the mutable directed graph type
 *
 * @category models
 * @since 3.18.0
 */
export type DirectedGraph<N, E> = Graph<N, E, "directed">

/**
 * Immutable graph type for relationships without source-to-target direction.
 *
 * **When to use**
 *
 * Use when modeling relationships where each edge connects both endpoints
 * without a source-to-target direction.
 *
 * **Details**
 *
 * `UndirectedGraph<N, E>` is a `Graph<N, E, "undirected">`.
 *
 * @see {@link undirected} for constructing undirected graphs
 * @see {@link DirectedGraph} for graphs whose edges have source-to-target direction
 * @see {@link MutableUndirectedGraph} for the mutable undirected graph type
 *
 * @category models
 * @since 3.18.0
 */
export type UndirectedGraph<N, E> = Graph<N, E, "undirected">

/**
 * Mutable directed graph type alias.
 *
 * **When to use**
 *
 * Use when annotating a temporary graph value that can be changed in place and
 * whose edges have source-to-target direction.
 *
 * @see {@link MutableGraph} for the generic mutable graph type
 * @see {@link DirectedGraph} for the immutable directed graph type
 * @see {@link MutableUndirectedGraph} for mutable graphs without edge direction
 *
 * @category models
 * @since 3.18.0
 */
export type MutableDirectedGraph<N, E> = MutableGraph<N, E, "directed">

/**
 * Mutable undirected graph type alias.
 *
 * **When to use**
 *
 * Use when annotating a temporary graph value that can be changed in place and
 * whose edges connect both endpoints without direction.
 *
 * @see {@link MutableDirectedGraph} for mutable graphs with directed edges
 * @see {@link UndirectedGraph} for the immutable undirected graph type
 * @see {@link MutableGraph} for the generic mutable graph type
 *
 * @category models
 * @since 3.18.0
 */
export type MutableUndirectedGraph<N, E> = MutableGraph<N, E, "undirected">

// =============================================================================
// Proto Objects
// =============================================================================

/** @internal */
const ProtoGraph = {
  [TypeId]: TypeId,
  [Symbol.iterator](this: Graph<any, any>) {
    return this.nodes[Symbol.iterator]()
  },
  [NodeInspectSymbol](this: Graph<any, any>) {
    return this.toJSON()
  },
  [Equal.symbol](this: Graph<any, any>, that: Equal.Equal): boolean {
    if (isGraph(that)) {
      if (
        this.nodes.size !== that.nodes.size ||
        this.edges.size !== that.edges.size ||
        this.type !== that.type
      ) {
        return false
      }
      // Compare nodes
      for (const [nodeIndex, nodeData] of this.nodes) {
        if (!that.nodes.has(nodeIndex)) {
          return false
        }
        const otherNodeData = that.nodes.get(nodeIndex)!
        if (!Equal.equals(nodeData, otherNodeData)) {
          return false
        }
      }
      // Compare edges
      for (const [edgeIndex, edgeData] of this.edges) {
        if (!that.edges.has(edgeIndex)) {
          return false
        }
        const otherEdge = that.edges.get(edgeIndex)!
        if (!Equal.equals(edgeData, otherEdge)) {
          return false
        }
      }
      return true
    }
    return false
  },
  [Hash.symbol](this: Graph<any, any>): number {
    let hash = Hash.string("Graph")
    hash = hash ^ Hash.string(this.type)
    hash = hash ^ Hash.number(this.nodes.size)
    hash = hash ^ Hash.number(this.edges.size)
    for (const [nodeIndex, nodeData] of this.nodes) {
      hash = hash ^ (Hash.hash(nodeIndex) + Hash.hash(nodeData))
    }
    for (const [edgeIndex, edgeData] of this.edges) {
      hash = hash ^ (Hash.hash(edgeIndex) + Hash.hash(edgeData))
    }
    return hash
  },
  toJSON(this: Graph<any, any>) {
    return {
      _id: "Graph",
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      type: this.type
    }
  },
  toString(this: Graph<any, any>) {
    return `Graph(${this.type}, ${this.nodes.size}, ${this.edges.size})`
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

// =============================================================================
// Errors
// =============================================================================

// TODO: Do we need safe variants for these?

/**
 * Error thrown by graph operations when the requested graph structure is
 * invalid, such as referencing a missing node or using unsupported edge
 * weights.
 *
 * **When to use**
 *
 * Use when handling failures thrown by graph operations that reject invalid
 * graph structure or unsupported algorithm inputs.
 *
 * @category errors
 * @since 3.18.0
 */
export class GraphError extends Data.TaggedError("GraphError")<{
  readonly message: string
}> {}

/** @internal */
const missingNode = (node: number) => new GraphError({ message: `Node ${node} does not exist` })

// =============================================================================
// Constructors
// =============================================================================

/**
 * Returns `true` if a value has the graph runtime type identifier, narrowing
 * it to a `Graph`.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before treating it as a graph value.
 *
 * **Gotchas**
 *
 * This guard checks the shared graph runtime type identifier and does not
 * distinguish immutable graphs from mutable graphs.
 *
 * @category guards
 * @since 4.0.0
 */
export const isGraph = (u: unknown): u is Graph<unknown, unknown> => hasProperty(u, TypeId)

/**
 * Creates a directed graph, optionally with initial mutations.
 *
 * **Example** (Creating a directed graph)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Directed graph with initial nodes and edges
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A->B")
 *   Graph.addEdge(mutable, b, c, "B->C")
 * })
 * ```
 *
 * @category constructors
 * @since 3.18.0
 */
export const directed = <N, E>(mutate?: (mutable: MutableDirectedGraph<N, E>) => void): DirectedGraph<N, E> => {
  const graph: Mutable<DirectedGraph<N, E>> = Object.create(ProtoGraph)
  graph.type = "directed"
  graph.nodes = new Map()
  graph.edges = new Map()
  graph.adjacency = new Map()
  graph.reverseAdjacency = new Map()
  graph.nextNodeIndex = 0
  graph.nextEdgeIndex = 0
  graph.acyclic = Option.some(true)
  graph.mutable = false

  if (mutate) {
    const mutable = beginMutation(graph as DirectedGraph<N, E>)
    mutate(mutable as MutableDirectedGraph<N, E>)
    return endMutation(mutable)
  }

  return graph
}

/**
 * Creates an undirected graph, optionally with initial mutations.
 *
 * **Example** (Creating an undirected graph)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Undirected graph with initial nodes and edges
 * const graph = Graph.undirected<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A-B")
 *   Graph.addEdge(mutable, b, c, "B-C")
 * })
 * ```
 *
 * @category constructors
 * @since 3.18.0
 */
export const undirected = <N, E>(mutate?: (mutable: MutableUndirectedGraph<N, E>) => void): UndirectedGraph<N, E> => {
  const graph: Mutable<UndirectedGraph<N, E>> = Object.create(ProtoGraph)
  graph.type = "undirected"
  graph.nodes = new Map()
  graph.edges = new Map()
  graph.adjacency = new Map()
  graph.reverseAdjacency = new Map()
  graph.nextNodeIndex = 0
  graph.nextEdgeIndex = 0
  graph.acyclic = Option.some(true)
  graph.mutable = false

  if (mutate) {
    const mutable = beginMutation(graph)
    mutate(mutable as MutableUndirectedGraph<N, E>)
    return endMutation(mutable)
  }

  return graph
}

// =============================================================================
// Scoped Mutable API
// =============================================================================

/**
 * Creates a mutable scope for safe graph mutations by copying the data structure.
 *
 * **Example** (Beginning a mutation scope)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>()
 * const mutable = Graph.beginMutation(graph)
 * // Now mutable can be safely modified without affecting original graph
 * ```
 *
 * @category mutations
 * @since 3.18.0
 */
export const beginMutation = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T>
): MutableGraph<N, E, T> => {
  // Copy adjacency maps with deep cloned arrays
  const adjacency = new Map<NodeIndex, Array<EdgeIndex>>()
  const reverseAdjacency = new Map<NodeIndex, Array<EdgeIndex>>()

  for (const [nodeIndex, edges] of graph.adjacency) {
    adjacency.set(nodeIndex, [...edges])
  }

  for (const [nodeIndex, edges] of graph.reverseAdjacency) {
    reverseAdjacency.set(nodeIndex, [...edges])
  }

  const mutable: Mutable<MutableGraph<N, E, T>> = Object.create(ProtoGraph)
  mutable.type = graph.type
  mutable.nodes = new Map(graph.nodes)
  mutable.edges = new Map(graph.edges)
  mutable.adjacency = adjacency
  mutable.reverseAdjacency = reverseAdjacency
  mutable.nextNodeIndex = graph.nextNodeIndex
  mutable.nextEdgeIndex = graph.nextEdgeIndex
  mutable.acyclic = graph.acyclic
  mutable.mutable = true

  return mutable
}

/**
 * Converts a mutable graph back to an immutable graph, ending the mutation scope.
 *
 * **Example** (Ending a mutation scope)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>()
 * const mutable = Graph.beginMutation(graph)
 * // ... perform mutations on mutable ...
 * const newGraph = Graph.endMutation(mutable)
 * ```
 *
 * @category mutations
 * @since 3.18.0
 */
export const endMutation = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>
): Graph<N, E, T> => {
  const graph: Mutable<Graph<N, E, T>> = Object.create(ProtoGraph)
  graph.type = mutable.type
  graph.nodes = new Map(mutable.nodes)
  graph.edges = new Map(mutable.edges)
  graph.adjacency = mutable.adjacency
  graph.reverseAdjacency = mutable.reverseAdjacency
  graph.nextNodeIndex = mutable.nextNodeIndex
  graph.nextEdgeIndex = mutable.nextEdgeIndex
  graph.acyclic = mutable.acyclic
  graph.mutable = false

  return graph
}

/**
 * Performs scoped mutations on a graph, automatically managing the mutation lifecycle.
 *
 * **Example** (Applying scoped mutations)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>()
 * const newGraph = Graph.mutate(graph, (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "A")
 *   const nodeB = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, nodeA, nodeB, 1)
 * })
 *
 * console.log(Graph.nodeCount(newGraph)) // 2
 * console.log(Graph.edgeCount(newGraph)) // 1
 * ```
 *
 * @category mutations
 * @since 3.18.0
 */
export const mutate: {
  <N, E, T extends Kind = "directed">(
    f: (mutable: MutableGraph<N, E, T>) => void
  ): (graph: Graph<N, E, T>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T>,
    f: (mutable: MutableGraph<N, E, T>) => void
  ): Graph<N, E, T>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T>,
  f: (mutable: MutableGraph<N, E, T>) => void
): Graph<N, E, T> => {
  const mutable = beginMutation(graph)
  f(mutable)
  return endMutation(mutable)
})

// =============================================================================
// Basic Node Operations
// =============================================================================

/**
 * Adds a new node to a mutable graph and returns its index.
 *
 * **When to use**
 *
 * Use to allocate a new node in a mutable graph before storing edges or
 * querying it by index.
 *
 * **Details**
 *
 * The returned index is allocated from the graph's next node index. The mutable
 * graph stores the node data and initializes empty incoming and outgoing edge
 * indexes for the new node.
 *
 * **Gotchas**
 *
 * `NodeIndex` values are identifiers and are not reused after removals.
 *
 * **Example** (Adding nodes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const result = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   console.log(nodeA) // NodeIndex with value 0
 *   console.log(nodeB) // NodeIndex with value 1
 * })
 * ```
 *
 * @see {@link mutate} for obtaining a mutable graph from an immutable graph
 * @see {@link addEdge} for connecting existing nodes
 * @see {@link removeNode} for removing nodes from a mutable graph
 *
 * @category mutations
 * @since 3.18.0
 */
export const addNode = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  data: N
): NodeIndex => {
  const nodeIndex = mutable.nextNodeIndex

  // Add node data
  mutable.nodes.set(nodeIndex, data)

  // Initialize empty adjacency lists
  mutable.adjacency.set(nodeIndex, [])
  mutable.reverseAdjacency.set(nodeIndex, [])

  // Update graph allocators
  mutable.nextNodeIndex = mutable.nextNodeIndex + 1

  return nodeIndex
}

/**
 * Gets the data associated with a node index safely, if it exists.
 *
 * **Example** (Getting node data)
 *
 * ```ts
 * import { Graph, Option } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   Graph.addNode(mutable, "Node A")
 * })
 *
 * const nodeIndex = 0
 * const nodeData = Graph.getNode(graph, nodeIndex)
 *
 * if (Option.isSome(nodeData)) {
 *   console.log(nodeData.value) // "Node A"
 * }
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const getNode: {
  <N, E, T extends Kind = "directed">(
    nodeIndex: NodeIndex
  ): (graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<N>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    nodeIndex: NodeIndex
  ): Option.Option<N>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): Option.Option<N> => graph.nodes.has(nodeIndex) ? Option.some(graph.nodes.get(nodeIndex)!) : Option.none())

/**
 * Checks whether a node with the given index exists in the graph.
 *
 * **Example** (Checking node existence)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   Graph.addNode(mutable, "Node A")
 * })
 *
 * const nodeIndex = 0
 * const exists = Graph.hasNode(graph, nodeIndex)
 * console.log(exists) // true
 *
 * const nonExistentIndex = 999
 * const notExists = Graph.hasNode(graph, nonExistentIndex)
 * console.log(notExists) // false
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const hasNode: {
  (nodeIndex: NodeIndex): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => boolean
  <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>, nodeIndex: NodeIndex): boolean
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): boolean => graph.nodes.has(nodeIndex))

/**
 * Returns the number of nodes in the graph.
 *
 * **Example** (Counting nodes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const emptyGraph = Graph.directed<string, number>()
 * console.log(Graph.nodeCount(emptyGraph)) // 0
 *
 * const graphWithNodes = Graph.mutate(emptyGraph, (mutable) => {
 *   Graph.addNode(mutable, "Node A")
 *   Graph.addNode(mutable, "Node B")
 *   Graph.addNode(mutable, "Node C")
 * })
 *
 * console.log(Graph.nodeCount(graphWithNodes)) // 3
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const nodeCount = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): number => graph.nodes.size

/**
 * Finds the first node that matches the given predicate.
 *
 * **Example** (Finding the first matching node)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   Graph.addNode(mutable, "Node A")
 *   Graph.addNode(mutable, "Node B")
 *   Graph.addNode(mutable, "Node C")
 * })
 *
 * const result = Graph.findNode(graph, (data) => data.startsWith("Node B"))
 * console.log(result) // Option.some(1)
 *
 * const notFound = Graph.findNode(graph, (data) => data === "Node D")
 * console.log(notFound) // Option.none()
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const findNode: {
  <N>(
    predicate: (data: N) => boolean
  ): <E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<NodeIndex>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    predicate: (data: N) => boolean
  ): Option.Option<NodeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  predicate: (data: N) => boolean
): Option.Option<NodeIndex> => {
  for (const [index, data] of graph.nodes) {
    if (predicate(data)) {
      return Option.some(index)
    }
  }
  return Option.none()
})

/**
 * Finds all nodes that match the given predicate.
 *
 * **Example** (Finding matching nodes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   Graph.addNode(mutable, "Start A")
 *   Graph.addNode(mutable, "Node B")
 *   Graph.addNode(mutable, "Start C")
 * })
 *
 * const result = Graph.findNodes(graph, (data) => data.startsWith("Start"))
 * console.log(result) // [0, 2]
 *
 * const empty = Graph.findNodes(graph, (data) => data === "Not Found")
 * console.log(empty) // []
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const findNodes: {
  <N>(
    predicate: (data: N) => boolean
  ): <E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Array<NodeIndex>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    predicate: (data: N) => boolean
  ): Array<NodeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  predicate: (data: N) => boolean
): Array<NodeIndex> => {
  const results: Array<NodeIndex> = []
  for (const [index, data] of graph.nodes) {
    if (predicate(data)) {
      results.push(index)
    }
  }
  return results
})

/**
 * Finds the first edge that matches the given predicate.
 *
 * **Example** (Finding the first matching edge)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const nodeC = Graph.addNode(mutable, "Node C")
 *   Graph.addEdge(mutable, nodeA, nodeB, 10)
 *   Graph.addEdge(mutable, nodeB, nodeC, 20)
 * })
 *
 * const result = Graph.findEdge(graph, (data) => data > 15)
 * console.log(result) // Option.some(1)
 *
 * const notFound = Graph.findEdge(graph, (data) => data > 100)
 * console.log(notFound) // Option.none()
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const findEdge: {
  <E>(
    predicate: (data: E, source: NodeIndex, target: NodeIndex) => boolean
  ): <N, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<EdgeIndex>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    predicate: (data: E, source: NodeIndex, target: NodeIndex) => boolean
  ): Option.Option<EdgeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  predicate: (data: E, source: NodeIndex, target: NodeIndex) => boolean
): Option.Option<EdgeIndex> => {
  for (const [edgeIndex, edgeData] of graph.edges) {
    if (predicate(edgeData.data, edgeData.source, edgeData.target)) {
      return Option.some(edgeIndex)
    }
  }
  return Option.none()
})

/**
 * Finds all edges that match the given predicate.
 *
 * **Example** (Finding matching edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const nodeC = Graph.addNode(mutable, "Node C")
 *   Graph.addEdge(mutable, nodeA, nodeB, 10)
 *   Graph.addEdge(mutable, nodeB, nodeC, 20)
 *   Graph.addEdge(mutable, nodeC, nodeA, 30)
 * })
 *
 * const result = Graph.findEdges(graph, (data) => data >= 20)
 * console.log(result) // [1, 2]
 *
 * const empty = Graph.findEdges(graph, (data) => data > 100)
 * console.log(empty) // []
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const findEdges: {
  <E>(
    predicate: (data: E, source: NodeIndex, target: NodeIndex) => boolean
  ): <N, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Array<EdgeIndex>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    predicate: (data: E, source: NodeIndex, target: NodeIndex) => boolean
  ): Array<EdgeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  predicate: (data: E, source: NodeIndex, target: NodeIndex) => boolean
): Array<EdgeIndex> => {
  const results: Array<EdgeIndex> = []
  for (const [edgeIndex, edgeData] of graph.edges) {
    if (predicate(edgeData.data, edgeData.source, edgeData.target)) {
      results.push(edgeIndex)
    }
  }
  return results
})

/**
 * Updates a single node's data by applying a transformation function.
 *
 * **Example** (Updating node data)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   Graph.addNode(mutable, "Node A")
 *   Graph.addNode(mutable, "Node B")
 *   Graph.updateNode(mutable, 0, (data) => data.toUpperCase())
 * })
 *
 * const nodeData = Graph.getNode(graph, 0)
 * console.log(nodeData) // Option.some("NODE A")
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const updateNode = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  index: NodeIndex,
  f: (data: N) => N
): void => {
  if (!mutable.nodes.has(index)) {
    return
  }

  const currentData = mutable.nodes.get(index)!
  const newData = f(currentData)
  mutable.nodes.set(index, newData)
}

/**
 * Updates a single edge's data by applying a transformation function.
 *
 * **Example** (Updating edge data)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const result = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const edgeIndex = Graph.addEdge(mutable, nodeA, nodeB, 10)
 *   Graph.updateEdge(mutable, edgeIndex, (data) => data * 2)
 * })
 *
 * const edgeData = Graph.getEdge(result, 0)
 * console.log(edgeData) // Option.some(new Graph.Edge({ source: 0, target: 1, data: 20 }))
 * ```
 *
 * @category mutations
 * @since 3.18.0
 */
export const updateEdge = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  edgeIndex: EdgeIndex,
  f: (data: E) => E
): void => {
  if (!mutable.edges.has(edgeIndex)) {
    return
  }

  const currentEdge = mutable.edges.get(edgeIndex)!
  const newData = f(currentEdge.data)
  mutable.edges.set(edgeIndex, new Edge({ ...currentEdge, data: newData }))
}

/**
 * Transforms every node's data in a mutable graph in place using the provided
 * mapping function.
 *
 * **Details**
 *
 * Node indices and edges are preserved; only the stored node data is replaced.
 *
 * **Example** (Mapping node data)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   Graph.addNode(mutable, "node a")
 *   Graph.addNode(mutable, "node b")
 *   Graph.addNode(mutable, "node c")
 *   Graph.mapNodes(mutable, (data) => data.toUpperCase())
 * })
 *
 * const nodeData = Graph.getNode(graph, 0)
 * console.log(nodeData) // Option.some("NODE A")
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const mapNodes = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  f: (data: N) => N
): void => {
  // Transform existing node data in place
  for (const [index, data] of mutable.nodes) {
    const newData = f(data)
    mutable.nodes.set(index, newData)
  }
}

/**
 * Transforms all edge data in a mutable graph using the provided mapping function.
 *
 * **Example** (Mapping edge data)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 10)
 *   Graph.addEdge(mutable, b, c, 20)
 *   Graph.mapEdges(mutable, (data) => data * 2)
 * })
 *
 * const edgeData = Graph.getEdge(graph, 0)
 * console.log(edgeData) // Option.some(new Graph.Edge({ source: 0, target: 1, data: 20 }))
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const mapEdges = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  f: (data: E) => E
): void => {
  // Transform existing edge data in place
  for (const [index, edgeData] of mutable.edges) {
    const newData = f(edgeData.data)
    mutable.edges.set(index, {
      ...edgeData,
      data: newData
    })
  }
}

/**
 * Swaps source and target nodes for every edge in a mutable graph.
 *
 * **Example** (Reversing edge directions)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 1) // A -> B
 *   Graph.addEdge(mutable, b, c, 2) // B -> C
 *   Graph.reverse(mutable) // Now B -> A, C -> B
 * })
 *
 * const edge0 = Graph.getEdge(graph, 0)
 * console.log(edge0) // Option.some(new Graph.Edge({ source: 1, target: 0, data: 1 }))
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const reverse = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>
): void => {
  // Reverse all edges by swapping source and target
  for (const [index, edgeData] of mutable.edges) {
    mutable.edges.set(
      index,
      new Edge({
        source: edgeData.target,
        target: edgeData.source,
        data: edgeData.data
      })
    )
  }

  // Clear and rebuild adjacency lists with reversed directions
  mutable.adjacency.clear()
  mutable.reverseAdjacency.clear()

  // Rebuild adjacency lists with reversed directions
  for (const [edgeIndex, edgeData] of mutable.edges) {
    // Add to forward adjacency (source -> target)
    const sourceEdges = mutable.adjacency.get(edgeData.source) || []
    sourceEdges.push(edgeIndex)
    mutable.adjacency.set(edgeData.source, sourceEdges)

    // Add to reverse adjacency (target <- source)
    const targetEdges = mutable.reverseAdjacency.get(edgeData.target) || []
    targetEdges.push(edgeIndex)
    mutable.reverseAdjacency.set(edgeData.target, targetEdges)
  }

  // Invalidate cycle flag since edge directions changed
  mutable.acyclic = Option.none()
}

/**
 * Filters and optionally transforms nodes in a mutable graph using a predicate function.
 * Nodes that return Option.none are removed along with all their connected edges.
 *
 * **Example** (Filtering and mapping nodes)
 *
 * ```ts
 * import { Graph, Option } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "active")
 *   const b = Graph.addNode(mutable, "inactive")
 *   const c = Graph.addNode(mutable, "active")
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, c, 2)
 *
 *   // Keep only "active" nodes and transform to uppercase
 *   Graph.filterMapNodes(
 *     mutable,
 *     (data) =>
 *       data === "active" ? Option.some(data.toUpperCase()) : Option.none()
 *   )
 * })
 *
 * console.log(Graph.nodeCount(graph)) // 2 (only "active" nodes remain)
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const filterMapNodes = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  f: (data: N) => Option.Option<N>
): void => {
  const nodesToRemove: Array<NodeIndex> = []

  // First pass: identify nodes to remove and transform data for nodes to keep
  for (const [index, data] of mutable.nodes) {
    const result = f(data)
    if (Option.isSome(result)) {
      // Transform node data
      mutable.nodes.set(index, result.value)
    } else {
      // Mark for removal
      nodesToRemove.push(index)
    }
  }

  // Second pass: remove filtered out nodes and their edges
  for (const nodeIndex of nodesToRemove) {
    removeNode(mutable, nodeIndex)
  }
}

/**
 * Filters and optionally transforms edges in a mutable graph using a predicate function.
 * Edges that return Option.none are removed from the graph.
 *
 * **Example** (Filtering and mapping edges)
 *
 * ```ts
 * import { Graph, Option } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 5)
 *   Graph.addEdge(mutable, b, c, 15)
 *   Graph.addEdge(mutable, c, a, 25)
 *
 *   // Keep only edges with weight >= 10 and double their weight
 *   Graph.filterMapEdges(
 *     mutable,
 *     (data) => data >= 10 ? Option.some(data * 2) : Option.none()
 *   )
 * })
 *
 * console.log(Graph.edgeCount(graph)) // 2 (edges with weight 5 removed)
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const filterMapEdges = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  f: (data: E) => Option.Option<E>
): void => {
  const edgesToRemove: Array<EdgeIndex> = []

  // First pass: identify edges to remove and transform data for edges to keep
  for (const [index, edgeData] of mutable.edges) {
    const result = f(edgeData.data)
    if (Option.isSome(result)) {
      // Transform edge data
      mutable.edges.set(index, {
        ...edgeData,
        data: result.value
      })
    } else {
      // Mark for removal
      edgesToRemove.push(index)
    }
  }

  // Second pass: remove filtered out edges
  for (const edgeIndex of edgesToRemove) {
    removeEdge(mutable, edgeIndex)
  }
}

/**
 * Filters nodes by removing those that don't match the predicate.
 * This function modifies the mutable graph in place.
 *
 * **Example** (Filtering nodes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   Graph.addNode(mutable, "active")
 *   Graph.addNode(mutable, "inactive")
 *   Graph.addNode(mutable, "pending")
 *   Graph.addNode(mutable, "active")
 *
 *   // Keep only "active" nodes
 *   Graph.filterNodes(mutable, (data) => data === "active")
 * })
 *
 * console.log(Graph.nodeCount(graph)) // 2 (only "active" nodes remain)
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const filterNodes = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  predicate: (data: N) => boolean
): void => {
  const nodesToRemove: Array<NodeIndex> = []

  // Identify nodes to remove
  for (const [index, data] of mutable.nodes) {
    if (!predicate(data)) {
      nodesToRemove.push(index)
    }
  }

  // Remove filtered out nodes (this also removes connected edges)
  for (const nodeIndex of nodesToRemove) {
    removeNode(mutable, nodeIndex)
  }
}

/**
 * Filters edges by removing those that don't match the predicate.
 * This function modifies the mutable graph in place.
 *
 * **Example** (Filtering edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *
 *   Graph.addEdge(mutable, a, b, 5)
 *   Graph.addEdge(mutable, b, c, 15)
 *   Graph.addEdge(mutable, c, a, 25)
 *
 *   // Keep only edges with weight >= 10
 *   Graph.filterEdges(mutable, (data) => data >= 10)
 * })
 *
 * console.log(Graph.edgeCount(graph)) // 2 (edge with weight 5 removed)
 * ```
 *
 * @category transforming
 * @since 3.18.0
 */
export const filterEdges = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  predicate: (data: E) => boolean
): void => {
  const edgesToRemove: Array<EdgeIndex> = []

  // Identify edges to remove
  for (const [index, edgeData] of mutable.edges) {
    if (!predicate(edgeData.data)) {
      edgesToRemove.push(index)
    }
  }

  // Remove filtered out edges
  for (const edgeIndex of edgesToRemove) {
    removeEdge(mutable, edgeIndex)
  }
}

// =============================================================================
// Cycle Flag Management (Internal)
// =============================================================================

/** @internal */
const invalidateCycleFlagOnRemoval = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>
): void => {
  // Only invalidate if the graph had cycles (removing edges/nodes cannot introduce cycles in acyclic graphs).
  if (mutable.acyclic._tag === "Some" && mutable.acyclic.value === false) {
    mutable.acyclic = Option.none()
  }
}

/** @internal */
const invalidateCycleFlagOnAddition = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>
): void => {
  // Only invalidate if the graph was acyclic (adding edges cannot remove cycles from cyclic graphs).
  if (mutable.acyclic._tag === "Some" && mutable.acyclic.value === true) {
    mutable.acyclic = Option.none()
  }
}

// =============================================================================
// Edge Operations
// =============================================================================

/**
 * Adds a new edge to a mutable graph and returns its index.
 *
 * **When to use**
 *
 * Use to connect two existing nodes in a mutable graph while storing edge data
 * and receiving the new edge identifier.
 *
 * **Details**
 *
 * Creates an `Edge` with the source, target, and data at the next edge index,
 * updates adjacency indexes, and increments the graph's next edge index.
 * Undirected graphs register the same edge for both endpoints.
 *
 * **Gotchas**
 *
 * The source and target nodes must already exist in the mutable graph; missing
 * endpoints throw a `GraphError`.
 *
 * **Example** (Adding edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const result = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const edge = Graph.addEdge(mutable, nodeA, nodeB, 42)
 *   console.log(edge) // EdgeIndex with value 0
 * })
 * ```
 *
 * @see {@link mutate} for obtaining a mutable graph from an immutable graph
 * @see {@link addNode} for creating node indexes before connecting them
 * @see {@link getEdge} for reading the returned edge
 * @see {@link removeEdge} for removing an edge from a mutable graph
 *
 * @category mutations
 * @since 3.18.0
 */
export const addEdge = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  source: NodeIndex,
  target: NodeIndex,
  data: E
): EdgeIndex => {
  // Validate that both nodes exist
  if (!mutable.nodes.has(source)) {
    throw missingNode(source)
  }
  if (!mutable.nodes.has(target)) {
    throw missingNode(target)
  }

  const edgeIndex = mutable.nextEdgeIndex

  // Create edge data
  const edgeData = new Edge({ source, target, data })
  mutable.edges.set(edgeIndex, edgeData)

  // Update adjacency lists
  const sourceAdjacency = mutable.adjacency.get(source)
  if (sourceAdjacency !== undefined) {
    sourceAdjacency.push(edgeIndex)
  }

  const targetReverseAdjacency = mutable.reverseAdjacency.get(target)
  if (targetReverseAdjacency !== undefined) {
    targetReverseAdjacency.push(edgeIndex)
  }

  // For undirected graphs, add reverse connections
  if (mutable.type === "undirected") {
    const targetAdjacency = mutable.adjacency.get(target)
    if (targetAdjacency !== undefined) {
      targetAdjacency.push(edgeIndex)
    }

    const sourceReverseAdjacency = mutable.reverseAdjacency.get(source)
    if (sourceReverseAdjacency !== undefined) {
      sourceReverseAdjacency.push(edgeIndex)
    }
  }

  // Update allocators
  mutable.nextEdgeIndex = mutable.nextEdgeIndex + 1

  // Only invalidate cycle flag if the graph was acyclic
  // Adding edges cannot remove cycles from cyclic graphs
  invalidateCycleFlagOnAddition(mutable)

  return edgeIndex
}

/**
 * Removes a node and all its incident edges from a mutable graph.
 *
 * **Example** (Removing a node)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const result = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   Graph.addEdge(mutable, nodeA, nodeB, 42)
 *
 *   // Remove nodeA and all edges connected to it
 *   Graph.removeNode(mutable, nodeA)
 * })
 * ```
 *
 * @category mutations
 * @since 3.18.0
 */
export const removeNode = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): void => {
  // Check if node exists
  if (!mutable.nodes.has(nodeIndex)) {
    return // Node doesn't exist, nothing to remove
  }

  // Collect all incident edges for removal
  const edgesToRemove: Array<EdgeIndex> = []

  // Get outgoing edges
  const outgoingEdges = mutable.adjacency.get(nodeIndex)
  if (outgoingEdges !== undefined) {
    for (const edge of outgoingEdges) {
      edgesToRemove.push(edge)
    }
  }

  // Get incoming edges
  const incomingEdges = mutable.reverseAdjacency.get(nodeIndex)
  if (incomingEdges !== undefined) {
    for (const edge of incomingEdges) {
      edgesToRemove.push(edge)
    }
  }

  // Remove all incident edges
  for (const edgeIndex of edgesToRemove) {
    removeEdgeInternal(mutable, edgeIndex)
  }

  // Remove the node itself
  mutable.nodes.delete(nodeIndex)
  mutable.adjacency.delete(nodeIndex)
  mutable.reverseAdjacency.delete(nodeIndex)

  // Only invalidate cycle flag if the graph wasn't already known to be acyclic
  // Removing nodes cannot introduce cycles in an acyclic graph
  invalidateCycleFlagOnRemoval(mutable)
}

/**
 * Removes an edge from a mutable graph.
 *
 * **Example** (Removing an edge)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const result = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const edge = Graph.addEdge(mutable, nodeA, nodeB, 42)
 *
 *   // Remove the edge
 *   Graph.removeEdge(mutable, edge)
 * })
 * ```
 *
 * @category mutations
 * @since 3.18.0
 */
export const removeEdge = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  edgeIndex: EdgeIndex
): void => {
  const wasRemoved = removeEdgeInternal(mutable, edgeIndex)

  // Only invalidate cycle flag if an edge was actually removed
  // and only if the graph wasn't already known to be acyclic
  if (wasRemoved) {
    invalidateCycleFlagOnRemoval(mutable)
  }
}

/** @internal */
const removeEdgeInternal = <N, E, T extends Kind = "directed">(
  mutable: MutableGraph<N, E, T>,
  edgeIndex: EdgeIndex
): boolean => {
  // Get edge data
  const edge = mutable.edges.get(edgeIndex)
  if (edge === undefined) {
    return false // Edge doesn't exist, no mutation occurred
  }

  const { source, target } = edge

  // Remove from adjacency lists
  const sourceAdjacency = mutable.adjacency.get(source)
  if (sourceAdjacency !== undefined) {
    const index = sourceAdjacency.indexOf(edgeIndex)
    if (index !== -1) {
      sourceAdjacency.splice(index, 1)
    }
  }

  const targetReverseAdjacency = mutable.reverseAdjacency.get(target)
  if (targetReverseAdjacency !== undefined) {
    const index = targetReverseAdjacency.indexOf(edgeIndex)
    if (index !== -1) {
      targetReverseAdjacency.splice(index, 1)
    }
  }

  // For undirected graphs, remove reverse connections
  if (mutable.type === "undirected") {
    const targetAdjacency = mutable.adjacency.get(target)
    if (targetAdjacency !== undefined) {
      const index = targetAdjacency.indexOf(edgeIndex)
      if (index !== -1) {
        targetAdjacency.splice(index, 1)
      }
    }

    const sourceReverseAdjacency = mutable.reverseAdjacency.get(source)
    if (sourceReverseAdjacency !== undefined) {
      const index = sourceReverseAdjacency.indexOf(edgeIndex)
      if (index !== -1) {
        sourceReverseAdjacency.splice(index, 1)
      }
    }
  }

  // Remove edge data
  mutable.edges.delete(edgeIndex)

  return true // Edge was successfully removed
}

// =============================================================================
// Edge Query Operations
// =============================================================================

/**
 * Gets the edge data associated with an edge index safely, if it exists.
 *
 * **Example** (Getting edge data)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   Graph.addEdge(mutable, nodeA, nodeB, 42)
 * })
 *
 * const edgeIndex = 0
 * const edgeData = Graph.getEdge(graph, edgeIndex)
 *
 * if (edgeData._tag === "Some") {
 *   console.log(edgeData.value.data) // 42
 *   console.log(edgeData.value.source) // 0
 *   console.log(edgeData.value.target) // 1
 * }
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const getEdge: {
  <E>(
    edgeIndex: EdgeIndex
  ): <N, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<Edge<E>>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    edgeIndex: EdgeIndex
  ): Option.Option<Edge<E>>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  edgeIndex: EdgeIndex
): Option.Option<Edge<E>> => Option.fromUndefinedOr(graph.edges.get(edgeIndex)))

/**
 * Checks whether an edge exists between two nodes in the graph.
 *
 * **Example** (Checking edge existence)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const nodeC = Graph.addNode(mutable, "Node C")
 *   Graph.addEdge(mutable, nodeA, nodeB, 42)
 * })
 *
 * const nodeA = 0
 * const nodeB = 1
 * const nodeC = 2
 *
 * const hasAB = Graph.hasEdge(graph, nodeA, nodeB)
 * console.log(hasAB) // true
 *
 * const hasAC = Graph.hasEdge(graph, nodeA, nodeC)
 * console.log(hasAC) // false
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const hasEdge: {
  (
    source: NodeIndex,
    target: NodeIndex
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => boolean
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    source: NodeIndex,
    target: NodeIndex
  ): boolean
} = dual(3, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  source: NodeIndex,
  target: NodeIndex
): boolean => {
  const adjacencyList = graph.adjacency.get(source)
  if (adjacencyList === undefined) {
    return false
  }

  // Check if any edge in the adjacency list connects to the target
  for (const edgeIndex of adjacencyList) {
    const edge = graph.edges.get(edgeIndex)
    if (edge !== undefined && edge.target === target) {
      return true
    }
  }

  return false
})

/**
 * Returns the number of edges in the graph.
 *
 * **Example** (Counting edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const emptyGraph = Graph.directed<string, number>()
 * console.log(Graph.edgeCount(emptyGraph)) // 0
 *
 * const graphWithEdges = Graph.mutate(emptyGraph, (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const nodeC = Graph.addNode(mutable, "Node C")
 *   Graph.addEdge(mutable, nodeA, nodeB, 1)
 *   Graph.addEdge(mutable, nodeB, nodeC, 2)
 *   Graph.addEdge(mutable, nodeC, nodeA, 3)
 * })
 *
 * console.log(Graph.edgeCount(graphWithEdges)) // 3
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const edgeCount = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): number => graph.edges.size

/**
 * Returns the neighboring node indices for a node.
 *
 * **Details**
 *
 * For directed graphs, neighbors are the targets of outgoing edges. For
 * undirected graphs, neighbors are the other endpoints of incident edges.
 *
 * **Example** (Getting outgoing neighbors)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const nodeC = Graph.addNode(mutable, "Node C")
 *   Graph.addEdge(mutable, nodeA, nodeB, 1)
 *   Graph.addEdge(mutable, nodeA, nodeC, 2)
 * })
 *
 * const nodeA = 0
 * const nodeB = 1
 * const nodeC = 2
 *
 * const neighborsA = Graph.neighbors(graph, nodeA)
 * console.log(neighborsA) // [1, 2]
 *
 * const neighborsB = Graph.neighbors(graph, nodeB)
 * console.log(neighborsB) // []
 * ```
 *
 * @category getters
 * @since 3.18.0
 */
export const neighbors: {
  (
    nodeIndex: NodeIndex
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Array<NodeIndex>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    nodeIndex: NodeIndex
  ): Array<NodeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): Array<NodeIndex> => {
  // For undirected graphs, use the specialized helper that returns the other endpoint
  if (graph.type === "undirected") {
    return getUndirectedNeighbors(graph as any, nodeIndex)
  }

  const adjacencyList = graph.adjacency.get(nodeIndex)
  if (adjacencyList === undefined) {
    return []
  }

  const result: Array<NodeIndex> = []
  for (const edgeIndex of adjacencyList) {
    const edge = graph.edges.get(edgeIndex)
    if (edge !== undefined) {
      result.push(edge.target)
    }
  }

  return result
})

/**
 * Gets neighbors of a node in a specific direction for bidirectional traversal.
 *
 * **Example** (Traversing directed neighbors)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, "A->B")
 * })
 *
 * const nodeA = 0
 * const nodeB = 1
 *
 * // Get outgoing neighbors (nodes that nodeA points to)
 * const outgoing = Graph.neighborsDirected(graph, nodeA, "outgoing")
 *
 * // Get incoming neighbors (nodes that point to nodeB)
 * const incoming = Graph.neighborsDirected(graph, nodeB, "incoming")
 * ```
 *
 * @category queries
 * @since 3.18.0
 */
export const neighborsDirected: {
  (
    nodeIndex: NodeIndex,
    direction: Direction
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Array<NodeIndex>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    nodeIndex: NodeIndex,
    direction: Direction
  ): Array<NodeIndex>
} = dual(3, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex,
  direction: Direction
): Array<NodeIndex> => {
  const adjacencyMap = direction === "incoming"
    ? graph.reverseAdjacency
    : graph.adjacency

  const adjacencyList = adjacencyMap.get(nodeIndex)
  if (adjacencyList === undefined) {
    return []
  }

  const result: Array<NodeIndex> = []
  for (const edgeIndex of adjacencyList) {
    const edge = graph.edges.get(edgeIndex)
    if (edge !== undefined) {
      // For incoming direction, we want the source node instead of target
      const neighborNode = direction === "incoming"
        ? edge.source
        : edge.target
      result.push(neighborNode)
    }
  }

  return result
})

// =============================================================================
// GraphViz Export
// =============================================================================

/**
 * Configuration options for GraphViz DOT format generation from graphs.
 *
 * **Details**
 *
 * These options customize node labels, edge labels, and graph naming in DOT
 * format compatible with GraphViz tools.
 *
 * **Example** (Configuring GraphViz labels)
 *
 * ```ts
 * import type { Graph } from "effect"
 *
 * // Basic options with custom labels
 * const basicOptions: Graph.GraphVizOptions<string, number> = {
 *   nodeLabel: (data) => `Node: ${data}`,
 *   edgeLabel: (data) => `Weight: ${data}`
 * }
 *
 * // Complete options with graph naming
 * const namedOptions: Graph.GraphVizOptions<string, string> = {
 *   nodeLabel: (data) => data.toUpperCase(),
 *   edgeLabel: (data) => data,
 *   graphName: "MyDependencyGraph"
 * }
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export interface GraphVizOptions<N, E> {
  /**
   * Function to generate custom labels for nodes.
   * Defaults to String(data) if not provided.
   */
  readonly nodeLabel?: (data: N) => string

  /**
   * Function to generate custom labels for edges.
   * Defaults to String(data) if not provided.
   */
  readonly edgeLabel?: (data: E) => string

  /**
   * Name for the DOT graph.
   * Defaults to "G" if not provided.
   */
  readonly graphName?: string
}

/**
 * Exports a graph to GraphViz DOT format for visualization.
 *
 * **Example** (Exporting GraphViz DOT)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.mutate(Graph.directed<string, number>(), (mutable) => {
 *   const nodeA = Graph.addNode(mutable, "Node A")
 *   const nodeB = Graph.addNode(mutable, "Node B")
 *   const nodeC = Graph.addNode(mutable, "Node C")
 *   Graph.addEdge(mutable, nodeA, nodeB, 1)
 *   Graph.addEdge(mutable, nodeB, nodeC, 2)
 *   Graph.addEdge(mutable, nodeC, nodeA, 3)
 * })
 *
 * const dot = Graph.toGraphViz(graph)
 * console.log(dot)
 * // digraph G {
 * //   "0" [label="Node A"];
 * //   "1" [label="Node B"];
 * //   "2" [label="Node C"];
 * //   "0" -> "1" [label="1"];
 * //   "1" -> "2" [label="2"];
 * //   "2" -> "0" [label="3"];
 * // }
 * ```
 *
 * @category utils
 * @since 3.18.0
 */
export const toGraphViz: {
  <N, E>(
    options?: GraphVizOptions<N, E>
  ): <T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => string
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    options?: GraphVizOptions<N, E>
  ): string
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  options?: GraphVizOptions<N, E>
): string => {
  const {
    edgeLabel = (data: E) => String(data),
    graphName = "G",
    nodeLabel = (data: N) => String(data)
  } = options ?? {}

  const isDirected = graph.type === "directed"
  const graphType = isDirected ? "digraph" : "graph"
  const edgeOperator = isDirected ? "->" : "--"

  const lines: Array<string> = []
  lines.push(`${graphType} ${graphName} {`)

  // Add nodes
  for (const [nodeIndex, nodeData] of graph.nodes) {
    const label = nodeLabel(nodeData).replace(/"/g, "\\\"")
    lines.push(`  "${nodeIndex}" [label="${label}"];`)
  }

  // Add edges
  for (const [, edgeData] of graph.edges) {
    const label = edgeLabel(edgeData.data).replace(/"/g, "\\\"")
    lines.push(`  "${edgeData.source}" ${edgeOperator} "${edgeData.target}" [label="${label}"];`)
  }

  lines.push("}")
  return lines.join("\n")
})

// =============================================================================
// Mermaid Export
// =============================================================================

/**
 * Mermaid node shape types for diagram visualization.
 *
 * **Details**
 *
 * Each shape produces different visual representations in Mermaid diagrams:
 * - `rectangle`: Standard rectangular nodes `A["label"]`
 * - `rounded`: Rounded rectangular nodes `A("label")`
 * - `circle`: Circular nodes `A(("label"))`
 * - `diamond`: Diamond-shaped nodes `A{"label"}`
 * - `hexagon`: Hexagonal nodes `A{{"label"}}`
 * - `stadium`: Stadium-shaped nodes `A(["label"])`
 * - `subroutine`: Subroutine-style nodes `A[["label"]]`
 * - `cylindrical`: Cylindrical database-style nodes `A[("label")]`
 *
 * **Example** (Selecting Mermaid node shapes)
 *
 * ```ts
 * import type { Graph } from "effect"
 *
 * // Shape selector function for different node types
 * const shapeSelector = (nodeData: string): Graph.MermaidNodeShape => {
 *   if (nodeData.includes("start") || nodeData.includes("end")) return "circle"
 *   if (nodeData.includes("decision")) return "diamond"
 *   if (nodeData.includes("process")) return "rectangle"
 *   if (nodeData.includes("data")) return "cylindrical"
 *   return "rounded"
 * }
 *
 * const options: Graph.MermaidOptions<string, string> = {
 *   nodeShape: shapeSelector
 * }
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export type MermaidNodeShape =
  | "rectangle" // A["label"]
  | "rounded" // A("label")
  | "circle" // A(("label"))
  | "diamond" // A{"label"}
  | "hexagon" // A{{"label"}}
  | "stadium" // A(["label"])
  | "subroutine" // A[["label"]]
  | "cylindrical" // A[("label")]

/**
 * Mermaid diagram direction types for controlling layout orientation.
 *
 * **Details**
 *
 * Determines the flow direction of nodes and edges in the diagram:
 * - `TB`/`TD`: Top to Bottom (vertical layout, default)
 * - `BT`: Bottom to Top (reverse vertical)
 * - `LR`: Left to Right (horizontal layout)
 * - `RL`: Right to Left (reverse horizontal)
 *
 * **Example** (Configuring Mermaid directions)
 *
 * ```ts
 * import type { Graph } from "effect"
 *
 * // Horizontal workflow diagram
 * const horizontalOptions: Graph.MermaidOptions<string, string> = {
 *   direction: "LR"
 * }
 *
 * // Vertical hierarchy (default)
 * const verticalOptions: Graph.MermaidOptions<string, string> = {
 *   direction: "TB"
 * }
 *
 * // Bottom-up flow
 * const bottomUpOptions: Graph.MermaidOptions<string, string> = {
 *   direction: "BT"
 * }
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export type MermaidDirection =
  | "TB" // Top to Bottom (default)
  | "TD" // Top Down (same as TB)
  | "BT" // Bottom to Top
  | "RL" // Right to Left
  | "LR" // Left to Right

/**
 * Mermaid diagram types for different visualization formats.
 *
 * **Details**
 *
 * Specifies the Mermaid diagram syntax to use:
 * - `flowchart`: For directed graphs with arrows (`A --> B`)
 * - `graph`: For undirected graphs with lines (`A --- B`)
 *
 * When not specified, automatically selects based on graph type:
 * directed graphs use "flowchart", undirected graphs use "graph".
 *
 * **Example** (Selecting Mermaid diagram types)
 *
 * ```ts
 * import type { Graph } from "effect"
 *
 * // Force flowchart format (even for undirected graphs)
 * const flowchartOptions: Graph.MermaidOptions<string, string> = {
 *   diagramType: "flowchart"
 * }
 *
 * // Force graph format (shows undirected connections)
 * const graphOptions: Graph.MermaidOptions<string, string> = {
 *   diagramType: "graph"
 * }
 *
 * // Auto-detection (recommended, default behavior)
 * const autoOptions: Graph.MermaidOptions<string, string> = {}
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export type MermaidDiagramType =
  | "flowchart" // For directed graphs
  | "graph" // For undirected graphs

/**
 * Configuration options for Mermaid diagram generation, following GraphViz pattern.
 *
 * @category models
 * @since 4.0.0
 */
/**
 * Configuration options for Mermaid diagram generation from graphs.
 *
 * **Details**
 *
 * These options customize node labels, edge labels, diagram type, layout
 * direction, node shapes, and graph naming in Mermaid format.
 *
 * **Example** (Configuring Mermaid output)
 *
 * ```ts
 * import type { Graph } from "effect"
 *
 * // Basic options with custom labels
 * const basicOptions: Graph.MermaidOptions<string, number> = {
 *   nodeLabel: (data) => `Node: ${data}`,
 *   edgeLabel: (data) => `Weight: ${data}`
 * }
 *
 * // Advanced options with all features
 * const advancedOptions: Graph.MermaidOptions<string, string> = {
 *   nodeLabel: (data) => data.toUpperCase(),
 *   edgeLabel: (data) => data,
 *   diagramType: "flowchart",
 *   direction: "LR",
 *   nodeShape: (data) => data.includes("start") ? "circle" : "rectangle"
 * }
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export interface MermaidOptions<N, E> {
  /**
   * Function to generate custom labels for nodes.
   * Defaults to String(data) if not provided.
   */
  readonly nodeLabel?: (data: N) => string

  /**
   * Function to generate custom labels for edges.
   * Defaults to String(data) if not provided.
   */
  readonly edgeLabel?: (data: E) => string

  /**
   * Diagram type override. If not specified, automatically detects:
   * - "flowchart" for directed graphs
   * - "graph" for undirected graphs
   */
  readonly diagramType?: MermaidDiagramType

  /**
   * Direction for diagram layout.
   * Defaults to "TD" (Top Down) if not provided.
   */
  readonly direction?: MermaidDirection

  /**
   * Function to determine node shape for each node.
   * Defaults to "rectangle" for all nodes if not provided.
   */
  readonly nodeShape?: (data: N) => MermaidNodeShape
}

/**
 * Escapes special characters in labels for Mermaid syntax compatibility.
 */
const escapeMermaidLabel = (label: string): string => {
  // Escape special characters for Mermaid using HTML entity codes
  // According to: https://mermaid.js.org/syntax/flowchart.html#special-characters-that-break-syntax
  return label
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/&/g, "#amp;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;")
    .replace(/\(/g, "#40;")
    .replace(/\)/g, "#41;")
    .replace(/\|/g, "#124;")
    .replace(/\\/g, "#92;")
    .replace(/\n/g, "<br/>")
}

/**
 * Formats a Mermaid node with the specified shape and label.
 */
const formatMermaidNode = (
  nodeId: string,
  label: string,
  shape: MermaidNodeShape
): string => {
  switch (shape) {
    case "rectangle":
      return `${nodeId}["${label}"]`
    case "rounded":
      return `${nodeId}("${label}")`
    case "circle":
      return `${nodeId}(("${label}"))`
    case "diamond":
      return `${nodeId}{"${label}"}`
    case "hexagon":
      return `${nodeId}{{"${label}"}}`
    case "stadium":
      return `${nodeId}(["${label}"])`
    case "subroutine":
      return `${nodeId}[["${label}"]]`
    case "cylindrical":
      return `${nodeId}[("${label}")]`
    default:
      return `${nodeId}["${label}"]` // Default rectangle
  }
}

/**
 * Exports a graph to Mermaid diagram format for visualization.
 *
 * **Details**
 *
 * Mermaid is a popular diagram-as-code tool that generates flowcharts and other
 * visualizations from text-based definitions. This function converts Effect Graph
 * structures to valid Mermaid syntax for use in documentation, web applications,
 * and visualization tools.
 *
 * **Example** (Exporting a directed Mermaid diagram)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Basic directed graph export
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const app = Graph.addNode(mutable, "App")
 *   const db = Graph.addNode(mutable, "Database")
 *   const cache = Graph.addNode(mutable, "Cache")
 *   Graph.addEdge(mutable, app, db, 1)
 *   Graph.addEdge(mutable, app, cache, 2)
 * })
 *
 * const mermaid = Graph.toMermaid(graph)
 * console.log(mermaid)
 * // flowchart TD
 * //   0["App"]
 * //   1["Database"]
 * //   2["Cache"]
 * //   0 -->|"1"| 1
 * //   0 -->|"2"| 2
 * ```
 *
 * **Example** (Exporting an undirected Mermaid diagram)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Undirected graph with custom labels and direction
 * const socialGraph = Graph.undirected<{ name: string }, string>((mutable) => {
 *   const alice = Graph.addNode(mutable, { name: "Alice" })
 *   const bob = Graph.addNode(mutable, { name: "Bob" })
 *   const charlie = Graph.addNode(mutable, { name: "Charlie" })
 *   Graph.addEdge(mutable, alice, bob, "friends")
 *   Graph.addEdge(mutable, bob, charlie, "colleagues")
 * })
 *
 * const mermaid = Graph.toMermaid(socialGraph, {
 *   nodeLabel: (person) => person.name,
 *   edgeLabel: (relationship) => relationship,
 *   direction: "LR"
 * })
 * console.log(mermaid)
 * // graph LR
 * //   0["Alice"]
 * //   1["Bob"]
 * //   2["Charlie"]
 * //   0 ---|"friends"| 1
 * //   1 ---|"colleagues"| 2
 * ```
 *
 * **Example** (Customizing Mermaid node shapes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Advanced styling with node shapes for flowchart
 * const workflow = Graph.directed<{ type: string; name: string }, string>(
 *   (mutable) => {
 *     const start = Graph.addNode(mutable, { type: "start", name: "Begin" })
 *     const process = Graph.addNode(mutable, {
 *       type: "process",
 *       name: "Process Data"
 *     })
 *     const decision = Graph.addNode(mutable, {
 *       type: "decision",
 *       name: "Valid?"
 *     })
 *     const end = Graph.addNode(mutable, { type: "end", name: "Complete" })
 *     Graph.addEdge(mutable, start, process, "")
 *     Graph.addEdge(mutable, process, decision, "")
 *     Graph.addEdge(mutable, decision, end, "yes")
 *   }
 * )
 *
 * const mermaid = Graph.toMermaid(workflow, {
 *   nodeLabel: (node) => node.name,
 *   nodeShape: (node) => {
 *     switch (node.type) {
 *       case "start":
 *         return "stadium"
 *       case "process":
 *         return "rectangle"
 *       case "decision":
 *         return "diamond"
 *       case "end":
 *         return "stadium"
 *       default:
 *         return "rectangle"
 *     }
 *   }
 * })
 * console.log(mermaid)
 * // flowchart TD
 * //   0(["Begin"])
 * //   1["Process Data"]
 * //   2{"Valid?"}
 * //   3(["Complete"])
 * //   0 --> 1
 * //   1 --> 2
 * //   2 --> 3
 * ```
 *
 * **Example** (Visualizing dependency graphs)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Real-world example: Software dependency graph
 * interface Dependency {
 *   name: string
 *   version: string
 *   type: "library" | "framework" | "tool"
 * }
 *
 * const dependencyGraph = Graph.directed<Dependency, string>((mutable) => {
 *   const app = Graph.addNode(mutable, {
 *     name: "MyApp",
 *     version: "1.0.0",
 *     type: "library"
 *   })
 *   const react = Graph.addNode(mutable, {
 *     name: "React",
 *     version: "18.0.0",
 *     type: "framework"
 *   })
 *   const lodash = Graph.addNode(mutable, {
 *     name: "Lodash",
 *     version: "4.17.0",
 *     type: "library"
 *   })
 *   const webpack = Graph.addNode(mutable, {
 *     name: "Webpack",
 *     version: "5.0.0",
 *     type: "tool"
 *   })
 *
 *   Graph.addEdge(mutable, app, react, "depends on")
 *   Graph.addEdge(mutable, app, lodash, "depends on")
 *   Graph.addEdge(mutable, app, webpack, "builds with")
 * })
 *
 * const dependencyDiagram = Graph.toMermaid(dependencyGraph, {
 *   nodeLabel: (dep) => `${dep.name}\\nv${dep.version}`,
 *   edgeLabel: (edge) => edge,
 *   nodeShape: (dep) =>
 *     dep.type === "framework" ?
 *       "hexagon" :
 *       dep.type === "tool"
 *       ? "diamond"
 *       : "rectangle",
 *   direction: "TB"
 * })
 *
 * console.log(dependencyDiagram)
 * // flowchart TB
 * //   0["MyApp\nv1.0.0"]
 * //   1{{"React\nv18.0.0"}}
 * //   2["Lodash\nv4.17.0"]
 * //   3{"Webpack\nv5.0.0"}
 * //   0 -->|"depends on"| 1
 * //   0 -->|"depends on"| 2
 * //   0 -->|"builds with"| 3
 * ```
 *
 * @category utils
 * @since 3.18.0
 */
export const toMermaid: {
  <N, E>(
    options?: MermaidOptions<N, E>
  ): <T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => string
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    options?: MermaidOptions<N, E>
  ): string
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  options?: MermaidOptions<N, E>
): string => {
  // Extract and validate options with defaults
  const {
    diagramType,
    direction = "TD",
    edgeLabel = (data: E) => String(data),
    nodeLabel = (data: N) => String(data),
    nodeShape = () => "rectangle" as const
  } = options ?? {}

  // Auto-detect diagram type if not specified
  const finalDiagramType = diagramType ??
    (graph.type === "directed" ? "flowchart" : "graph")

  // Generate diagram header
  const lines: Array<string> = []
  lines.push(`${finalDiagramType} ${direction}`)

  // Add nodes
  for (const [nodeIndex, nodeData] of graph.nodes) {
    const nodeId = String(nodeIndex)
    const label = escapeMermaidLabel(nodeLabel(nodeData))
    const shape = nodeShape(nodeData)
    const formattedNode = formatMermaidNode(nodeId, label, shape)
    lines.push(`  ${formattedNode}`)
  }

  // Add edges
  const edgeOperator = finalDiagramType === "flowchart" ? "-->" : "---"
  for (const [, edgeData] of graph.edges) {
    const sourceId = String(edgeData.source)
    const targetId = String(edgeData.target)
    const label = escapeMermaidLabel(edgeLabel(edgeData.data))

    if (label) {
      lines.push(`  ${sourceId} ${edgeOperator}|"${label}"| ${targetId}`)
    } else {
      lines.push(`  ${sourceId} ${edgeOperator} ${targetId}`)
    }
  }

  return lines.join("\n")
})

// =============================================================================
// Direction Types for Bidirectional Traversal
// =============================================================================

/**
 * Direction for graph traversal, indicating which edges to follow.
 *
 * **Example** (Traversing by direction)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, "A->B")
 * })
 *
 * // Follow outgoing edges (normal direction)
 * const outgoingNodes = Array.from(
 *   Graph.indices(Graph.dfs(graph, { start: [0], direction: "outgoing" }))
 * )
 *
 * // Follow incoming edges (reverse direction)
 * const incomingNodes = Array.from(
 *   Graph.indices(Graph.dfs(graph, { start: [1], direction: "incoming" }))
 * )
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export type Direction = "outgoing" | "incoming"

// =============================================================================
// Graph Structure Analysis Algorithms
// =============================================================================

/**
 * Checks whether the graph is acyclic (contains no cycles).
 *
 * **Details**
 *
 * Uses depth-first search to detect back edges, which indicate cycles.
 * For directed graphs, any back edge creates a cycle. For undirected graphs,
 * a back edge that doesn't go to the immediate parent creates a cycle.
 *
 * **Example** (Checking cycles)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Acyclic directed graph (DAG)
 * const dag = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A->B")
 *   Graph.addEdge(mutable, b, c, "B->C")
 * })
 * console.log(Graph.isAcyclic(dag)) // true
 *
 * // Cyclic directed graph
 * const cyclic = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, "A->B")
 *   Graph.addEdge(mutable, b, a, "B->A") // Creates cycle
 * })
 * console.log(Graph.isAcyclic(cyclic)) // false
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const isAcyclic = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): boolean => {
  // Use existing cycle flag if available
  if (Option.isSome(graph.acyclic)) {
    return graph.acyclic.value
  }

  // Stack-safe DFS cycle detection using iterative approach
  const visited = new Set<NodeIndex>()
  const recursionStack = new Set<NodeIndex>()

  // Stack entry: [node, neighbors, neighborIndex, isFirstVisit]
  type DfsStackEntry = [NodeIndex, Array<NodeIndex>, number, boolean]

  // Get all nodes to handle disconnected components
  for (const startNode of graph.nodes.keys()) {
    if (visited.has(startNode)) {
      continue // Already processed this component
    }

    // Iterative DFS with explicit stack
    const stack: Array<DfsStackEntry> = [[startNode, [], 0, true]]

    while (stack.length > 0) {
      const [node, neighbors, neighborIndex, isFirstVisit] = stack[stack.length - 1]

      // First visit to this node
      if (isFirstVisit) {
        if (recursionStack.has(node)) {
          // Back edge found - cycle detected
          graph.acyclic = Option.some(false)
          return false
        }

        if (visited.has(node)) {
          stack.pop()
          continue
        }

        visited.add(node)
        recursionStack.add(node)

        // Get neighbors for this node
        const nodeNeighbors = Array.from(neighborsDirected(graph, node, "outgoing"))
        stack[stack.length - 1] = [node, nodeNeighbors, 0, false]
        continue
      }

      // Process next neighbor
      if (neighborIndex < neighbors.length) {
        const neighbor = neighbors[neighborIndex]
        stack[stack.length - 1] = [node, neighbors, neighborIndex + 1, false]

        if (recursionStack.has(neighbor)) {
          // Back edge found - cycle detected
          graph.acyclic = Option.some(false)
          return false
        }

        if (!visited.has(neighbor)) {
          stack.push([neighbor, [], 0, true])
        }
      } else {
        // Done with this node - backtrack
        recursionStack.delete(node)
        stack.pop()
      }
    }
  }

  // Cache the result
  graph.acyclic = Option.some(true)
  return true
}

/**
 * Checks whether an undirected graph is bipartite.
 *
 * **Details**
 *
 * A bipartite graph is one whose vertices can be divided into two disjoint sets
 * such that no two vertices within the same set are adjacent. Uses BFS coloring
 * to determine bipartiteness.
 *
 * **Example** (Checking bipartite graphs)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * // Bipartite graph (alternating coloring possible)
 * const bipartite = Graph.undirected<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   const d = Graph.addNode(mutable, "D")
 *   Graph.addEdge(mutable, a, b, "edge") // Set 1: {A, C}, Set 2: {B, D}
 *   Graph.addEdge(mutable, b, c, "edge")
 *   Graph.addEdge(mutable, c, d, "edge")
 * })
 * console.log(Graph.isBipartite(bipartite)) // true
 *
 * // Non-bipartite graph (odd cycle)
 * const triangle = Graph.undirected<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "edge")
 *   Graph.addEdge(mutable, b, c, "edge")
 *   Graph.addEdge(mutable, c, a, "edge") // Triangle (3-cycle)
 * })
 * console.log(Graph.isBipartite(triangle)) // false
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const isBipartite = <N, E>(
  graph: Graph<N, E, "undirected"> | MutableGraph<N, E, "undirected">
): boolean => {
  const coloring = new Map<NodeIndex, 0 | 1>()
  const discovered = new Set<NodeIndex>()
  let isBipartiteGraph = true

  // Get all nodes to handle disconnected components
  for (const startNode of graph.nodes.keys()) {
    if (!discovered.has(startNode)) {
      // Start BFS coloring from this component
      const queue: Array<NodeIndex> = [startNode]
      coloring.set(startNode, 0) // Color start node with 0
      discovered.add(startNode)

      while (queue.length > 0 && isBipartiteGraph) {
        const current = queue.shift()!
        const currentColor = coloring.get(current)!
        const neighborColor: 0 | 1 = currentColor === 0 ? 1 : 0

        // Get all neighbors for undirected graph
        const nodeNeighbors = getUndirectedNeighbors(graph, current)
        for (const neighbor of nodeNeighbors) {
          if (!discovered.has(neighbor)) {
            // Color unvisited neighbor with opposite color
            coloring.set(neighbor, neighborColor)
            discovered.add(neighbor)
            queue.push(neighbor)
          } else {
            // Check if neighbor has the same color (conflict)
            if (coloring.get(neighbor) === currentColor) {
              isBipartiteGraph = false
              break
            }
          }
        }
      }

      // Early exit if not bipartite
      if (!isBipartiteGraph) {
        break
      }
    }
  }

  return isBipartiteGraph
}

/**
 * Get neighbors for undirected graphs by checking both adjacency and reverse adjacency.
 * For undirected graphs, we need to find the other endpoint of each edge incident to the node.
 */
const getUndirectedNeighbors = <N, E>(
  graph: Graph<N, E, "undirected"> | MutableGraph<N, E, "undirected">,
  nodeIndex: NodeIndex
): Array<NodeIndex> => {
  const neighbors = new Set<NodeIndex>()

  // Check edges where this node is the source
  const adjacencyList = graph.adjacency.get(nodeIndex)
  if (adjacencyList !== undefined) {
    for (const edgeIndex of adjacencyList) {
      const edge = graph.edges.get(edgeIndex)
      if (edge !== undefined) {
        // For undirected graphs, the neighbor is the other endpoint
        const otherNode = edge.source === nodeIndex ? edge.target : edge.source
        neighbors.add(otherNode)
      }
    }
  }

  return Array.from(neighbors)
}

/**
 * Finds connected components in an undirected graph.
 * Each component is represented as an array of node indices.
 *
 * **Example** (Finding connected components)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.undirected<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   const d = Graph.addNode(mutable, "D")
 *   Graph.addEdge(mutable, a, b, "edge") // Component 1: A-B
 *   Graph.addEdge(mutable, c, d, "edge") // Component 2: C-D
 * })
 *
 * const components = Graph.connectedComponents(graph)
 * console.log(components) // [[0, 1], [2, 3]]
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const connectedComponents = <N, E>(
  graph: Graph<N, E, "undirected"> | MutableGraph<N, E, "undirected">
): Array<Array<NodeIndex>> => {
  const visited = new Set<NodeIndex>()
  const components: Array<Array<NodeIndex>> = []
  for (const startNode of graph.nodes.keys()) {
    if (!visited.has(startNode)) {
      // DFS to find all nodes in this component
      const component: Array<NodeIndex> = []
      const stack: Array<NodeIndex> = [startNode]

      while (stack.length > 0) {
        const current = stack.pop()!
        if (!visited.has(current)) {
          visited.add(current)
          component.push(current)

          // Add all unvisited neighbors to stack
          const nodeNeighbors = getUndirectedNeighbors(graph, current)
          for (const neighbor of nodeNeighbors) {
            if (!visited.has(neighbor)) {
              stack.push(neighbor)
            }
          }
        }
      }

      components.push(component)
    }
  }

  return components
}

/**
 * Finds strongly connected components in a directed graph using Kosaraju's algorithm.
 * Each SCC is represented as an array of node indices.
 *
 * **Example** (Finding strongly connected components)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A->B")
 *   Graph.addEdge(mutable, b, c, "B->C")
 *   Graph.addEdge(mutable, c, a, "C->A") // Creates SCC: A-B-C
 * })
 *
 * const sccs = Graph.stronglyConnectedComponents(graph)
 * console.log(sccs) // [[0, 1, 2]]
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const stronglyConnectedComponents = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): Array<Array<NodeIndex>> => {
  const visited = new Set<NodeIndex>()
  const finishOrder: Array<NodeIndex> = []
  // Iterate directly over node keys

  // Step 1: Stack-safe DFS on original graph to get finish times
  // Stack entry: [node, neighbors, neighborIndex, isFirstVisit]
  type DfsStackEntry = [NodeIndex, Array<NodeIndex>, number, boolean]

  for (const startNode of graph.nodes.keys()) {
    if (visited.has(startNode)) {
      continue
    }

    const stack: Array<DfsStackEntry> = [[startNode, [], 0, true]]

    while (stack.length > 0) {
      const [node, nodeNeighbors, neighborIndex, isFirstVisit] = stack[stack.length - 1]

      if (isFirstVisit) {
        if (visited.has(node)) {
          stack.pop()
          continue
        }

        visited.add(node)
        const nodeNeighborsList = neighbors(graph, node)
        stack[stack.length - 1] = [node, nodeNeighborsList, 0, false]
        continue
      }

      // Process next neighbor
      if (neighborIndex < nodeNeighbors.length) {
        const neighbor = nodeNeighbors[neighborIndex]
        stack[stack.length - 1] = [node, nodeNeighbors, neighborIndex + 1, false]

        if (!visited.has(neighbor)) {
          stack.push([neighbor, [], 0, true])
        }
      } else {
        // Done with this node - add to finish order (post-order)
        finishOrder.push(node)
        stack.pop()
      }
    }
  }

  // Step 2: Stack-safe DFS on transpose graph in reverse finish order
  visited.clear()
  const sccs: Array<Array<NodeIndex>> = []

  for (let i = finishOrder.length - 1; i >= 0; i--) {
    const startNode = finishOrder[i]
    if (visited.has(startNode)) {
      continue
    }

    const scc: Array<NodeIndex> = []
    const stack: Array<NodeIndex> = [startNode]

    while (stack.length > 0) {
      const node = stack.pop()!

      if (visited.has(node)) {
        continue
      }

      visited.add(node)
      scc.push(node)

      // Use reverse adjacency (transpose graph)
      const reverseAdjacency = graph.reverseAdjacency.get(node)
      if (reverseAdjacency !== undefined) {
        for (const edgeIndex of reverseAdjacency) {
          const edge = graph.edges.get(edgeIndex)
          if (edge !== undefined) {
            const predecessor = edge.source
            if (!visited.has(predecessor)) {
              stack.push(predecessor)
            }
          }
        }
      }
    }

    sccs.push(scc)
  }

  return sccs
}

// =============================================================================
// Path Finding Algorithms
// =============================================================================

/**
 * Result of a shortest path computation.
 *
 * **When to use**
 *
 * Use to read the successful source-to-target shortest path returned by
 * path-finding algorithms, including the ordered node indices, total distance,
 * and traversed edge data.
 *
 * **Details**
 *
 * Contains the node-index path, the total numeric distance, and the edge data
 * encountered along the path.
 *
 * **Gotchas**
 *
 * `costs` contains original edge data, not the numeric output of the cost
 * function unless the edge data is numeric.
 *
 * @see {@link dijkstra} for shortest paths with non-negative edge costs
 * @see {@link astar} for heuristic shortest-path search
 * @see {@link bellmanFord} for shortest paths that may include negative edge weights
 * @see {@link AllPairsResult} for the all-pairs shortest-path result shape
 *
 * @category models
 * @since 3.18.0
 */
export interface PathResult<E> {
  readonly path: Array<NodeIndex>
  readonly distance: number
  readonly costs: Array<E>
}

/**
 * Configuration for finding a shortest path with Dijkstra's algorithm.
 *
 * **When to use**
 *
 * Use when configuring `dijkstra` to find a shortest path between two existing
 * node indices with non-negative edge costs.
 *
 * **Details**
 *
 * Specifies the source and target node indices, plus a cost function that maps
 * each edge's data to a non-negative numeric weight.
 *
 * **Gotchas**
 *
 * `dijkstra` throws a `GraphError` when either endpoint does not exist or when
 * the cost function returns a negative weight.
 *
 * @see {@link dijkstra} for the algorithm that consumes this configuration
 * @see {@link AstarConfig} for heuristic shortest-path search
 * @see {@link BellmanFordConfig} for shortest paths that may include negative edge weights
 *
 * @category models
 * @since 3.18.0
 */
export interface DijkstraConfig<E> {
  source: NodeIndex
  target: NodeIndex
  cost: (edgeData: E) => number
}

/**
 * Finds the shortest path from the configured source node to the target node
 * using Dijkstra's algorithm.
 *
 * **Details**
 *
 * Edge costs must be non-negative. Returns `Option.none()` when the target is
 * not reachable, and throws a `GraphError` when either endpoint is missing or a
 * negative edge cost is encountered.
 *
 * **Example** (Finding shortest paths with Dijkstra)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 5)
 *   Graph.addEdge(mutable, a, c, 10)
 *   Graph.addEdge(mutable, b, c, 2)
 * })
 *
 * const result = Graph.dijkstra(graph, {
 *   source: 0,
 *   target: 2,
 *   cost: (edgeData) => edgeData
 * })
 *
 * if (result._tag === "Some") {
 *   console.log(result.value.path) // [0, 1, 2] - shortest path A->B->C
 *   console.log(result.value.distance) // 7 - total distance
 * }
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const dijkstra: {
  <E>(
    config: DijkstraConfig<E>
  ): <N, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<PathResult<E>>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config: DijkstraConfig<E>
  ): Option.Option<PathResult<E>>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: DijkstraConfig<E>
): Option.Option<PathResult<E>> => {
  // Validate that source and target nodes exist
  if (!graph.nodes.has(config.source)) {
    throw missingNode(config.source)
  }
  if (!graph.nodes.has(config.target)) {
    throw missingNode(config.target)
  }

  // Early return if source equals target
  if (config.source === config.target) {
    return Option.some({
      path: [config.source],
      distance: 0,
      costs: []
    })
  }

  // Distance tracking and priority queue simulation
  const distances = new Map<NodeIndex, number>()
  const previous = new Map<NodeIndex, { node: NodeIndex; edgeData: E } | null>()
  const visited = new Set<NodeIndex>()

  // Initialize distances
  // Iterate directly over node keys
  for (const node of graph.nodes.keys()) {
    distances.set(node, node === config.source ? 0 : Infinity)
    previous.set(node, null)
  }

  // Simple priority queue using array (can be optimized with proper heap)
  const priorityQueue: Array<{ node: NodeIndex; distance: number }> = [
    { node: config.source, distance: 0 }
  ]

  while (priorityQueue.length > 0) {
    // Find minimum distance node (priority queue extract-min)
    let minIndex = 0
    for (let i = 1; i < priorityQueue.length; i++) {
      if (priorityQueue[i].distance < priorityQueue[minIndex].distance) {
        minIndex = i
      }
    }

    const current = priorityQueue.splice(minIndex, 1)[0]
    const currentNode = current.node

    // Skip if already visited (can happen with duplicate entries)
    if (visited.has(currentNode)) {
      continue
    }

    visited.add(currentNode)

    // Early termination if we reached the target
    if (currentNode === config.target) {
      break
    }

    // Get current distance
    const currentDistance = distances.get(currentNode)!

    // Examine all outgoing edges
    const adjacencyList = graph.adjacency.get(currentNode)
    if (adjacencyList !== undefined) {
      for (const edgeIndex of adjacencyList) {
        const edge = graph.edges.get(edgeIndex)
        if (edge !== undefined) {
          const neighbor = edge.target
          const cost = config.cost(edge.data)

          // Validate non-negative weights
          if (cost < 0) {
            throw new GraphError({ message: "Dijkstra's algorithm requires non-negative edge weights" })
          }

          const newDistance = currentDistance + cost
          const neighborDistance = distances.get(neighbor)!

          // Relaxation step
          if (newDistance < neighborDistance) {
            distances.set(neighbor, newDistance)
            previous.set(neighbor, { node: currentNode, edgeData: edge.data })

            // Add to priority queue if not visited
            if (!visited.has(neighbor)) {
              priorityQueue.push({ node: neighbor, distance: newDistance })
            }
          }
        }
      }
    }
  }

  // Check if target is reachable
  const distance = distances.get(config.target)!
  if (distance === Infinity) {
    return Option.none() // No path exists
  }

  // Reconstruct path
  const path: Array<NodeIndex> = []
  const costs: Array<E> = []
  let currentNode: NodeIndex | null = config.target

  while (currentNode !== null) {
    path.unshift(currentNode)
    const prev: { node: NodeIndex; edgeData: E } | null = previous.get(currentNode)!
    if (prev !== null) {
      costs.unshift(prev.edgeData)
      currentNode = prev.node
    } else {
      currentNode = null
    }
  }

  return Option.some({
    path,
    distance,
    costs
  })
})

/**
 * Result of an all-pairs shortest path computation.
 *
 * **When to use**
 *
 * Use when storing or passing around the complete output of `floydWarshall` so
 * callers can look up shortest distances, node paths, and edge data for any
 * source and target node pair.
 *
 * **Details**
 *
 * Contains distance, node-path, and edge-data maps keyed by source and target
 * node indices.
 *
 * @see {@link floydWarshall} for computing an all-pairs shortest path result
 * @see {@link PathResult} for the single source-to-target result shape used by path-finding algorithms
 *
 * @category models
 * @since 3.18.0
 */
export interface AllPairsResult<E> {
  readonly distances: Map<NodeIndex, Map<NodeIndex, number>>
  readonly paths: Map<NodeIndex, Map<NodeIndex, Array<NodeIndex> | null>>
  readonly costs: Map<NodeIndex, Map<NodeIndex, Array<E>>>
}

/**
 * Finds shortest paths between all pairs of nodes using the Floyd-Warshall
 * algorithm.
 *
 * **Details**
 *
 * Computes distances, reconstructed node paths, and edge-data paths for every
 * source and target pair in O(V^3) time. Negative edge weights are allowed, but
 * a `GraphError` is thrown if any negative cycle is detected.
 *
 * **Example** (Finding all-pairs shortest paths)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 3)
 *   Graph.addEdge(mutable, b, c, 2)
 *   Graph.addEdge(mutable, a, c, 7)
 * })
 *
 * const result = Graph.floydWarshall(graph, (edgeData) => edgeData)
 * const distanceAToC = result.distances.get(0)?.get(2) // 5 (A->B->C)
 * const pathAToC = result.paths.get(0)?.get(2) // [0, 1, 2]
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const floydWarshall: {
  <E>(
    cost: (edgeData: E) => number
  ): <N, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => AllPairsResult<E>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    cost: (edgeData: E) => number
  ): AllPairsResult<E>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  cost: (edgeData: E) => number
): AllPairsResult<E> => {
  // Get all nodes for Floyd-Warshall algorithm (needs array for nested iteration)
  const allNodes = Array.from(graph.nodes.keys())

  // Initialize distance matrix
  const distances = new Map<NodeIndex, Map<NodeIndex, number>>()
  const next = new Map<NodeIndex, Map<NodeIndex, NodeIndex | null>>()
  const edgeMatrix = new Map<NodeIndex, Map<NodeIndex, E | null>>()

  // Initialize with infinity for all pairs
  for (const i of allNodes) {
    distances.set(i, new Map())
    next.set(i, new Map())
    edgeMatrix.set(i, new Map())

    for (const j of allNodes) {
      distances.get(i)!.set(j, i === j ? 0 : Infinity)
      next.get(i)!.set(j, null)
      edgeMatrix.get(i)!.set(j, null)
    }
  }

  // Set edge weights
  for (const [, edgeData] of graph.edges) {
    const weight = cost(edgeData.data)
    const i = edgeData.source
    const j = edgeData.target

    // Use minimum weight if multiple edges exist
    const currentWeight = distances.get(i)!.get(j)!
    if (weight < currentWeight) {
      distances.get(i)!.set(j, weight)
      next.get(i)!.set(j, j)
      edgeMatrix.get(i)!.set(j, edgeData.data)
    }
  }

  // Floyd-Warshall main loop
  for (const k of allNodes) {
    for (const i of allNodes) {
      for (const j of allNodes) {
        const distIK = distances.get(i)!.get(k)!
        const distKJ = distances.get(k)!.get(j)!
        const distIJ = distances.get(i)!.get(j)!

        if (distIK !== Infinity && distKJ !== Infinity && distIK + distKJ < distIJ) {
          distances.get(i)!.set(j, distIK + distKJ)
          next.get(i)!.set(j, next.get(i)!.get(k)!)
        }
      }
    }
  }

  // Check for negative cycles
  for (const i of allNodes) {
    if (distances.get(i)!.get(i)! < 0) {
      throw new GraphError({ message: `Negative cycle detected involving node ${i}` })
    }
  }

  // Build result paths and edge weights
  const paths = new Map<NodeIndex, Map<NodeIndex, Array<NodeIndex> | null>>()
  const costs = new Map<NodeIndex, Map<NodeIndex, Array<E>>>()

  for (const i of allNodes) {
    paths.set(i, new Map())
    costs.set(i, new Map())

    for (const j of allNodes) {
      if (i === j) {
        paths.get(i)!.set(j, [i])
        costs.get(i)!.set(j, [])
      } else if (distances.get(i)!.get(j)! === Infinity) {
        paths.get(i)!.set(j, null)
        costs.get(i)!.set(j, [])
      } else {
        // Reconstruct path iteratively
        const path: Array<NodeIndex> = []
        const weights: Array<E> = []
        let current = i

        path.push(current)
        while (current !== j) {
          const nextNode = next.get(current)!.get(j)!
          if (nextNode === null) break

          const edgeData = edgeMatrix.get(current)!.get(nextNode)!
          if (edgeData !== null) {
            weights.push(edgeData)
          }

          current = nextNode
          path.push(current)
        }

        paths.get(i)!.set(j, path)
        costs.get(i)!.set(j, weights)
      }
    }
  }

  return {
    distances,
    paths,
    costs
  }
})

/**
 * Configuration for finding a shortest path with the A* algorithm.
 *
 * **When to use**
 *
 * Use when configuring `astar` for point-to-point shortest-path searches where
 * node data can provide a heuristic estimate toward the target.
 *
 * **Details**
 *
 * Specifies the source and target node indices, an edge-cost function, and a
 * heuristic that estimates the remaining cost from a node to the target.
 *
 * @see {@link astar} for the algorithm that consumes this configuration
 * @see {@link DijkstraConfig} for shortest paths without a heuristic
 * @see {@link BellmanFordConfig} for shortest paths that may include negative edge weights
 *
 * @category models
 * @since 3.18.0
 */
export interface AstarConfig<E, N> {
  source: NodeIndex
  target: NodeIndex
  cost: (edgeData: E) => number
  heuristic: (sourceNodeData: N, targetNodeData: N) => number
}

/**
 * Finds the shortest path from the configured source node to the target node
 * using the A* pathfinding algorithm.
 *
 * **Details**
 *
 * The edge-cost function must return non-negative weights, and the heuristic
 * should be admissible to preserve shortest-path guarantees. Returns
 * `Option.none()` when the target is not reachable, and throws a `GraphError`
 * when either endpoint is missing or a negative edge cost is encountered.
 *
 * **Example** (Finding shortest paths with A-star)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<{ x: number; y: number }, number>((mutable) => {
 *   const a = Graph.addNode(mutable, { x: 0, y: 0 })
 *   const b = Graph.addNode(mutable, { x: 1, y: 0 })
 *   const c = Graph.addNode(mutable, { x: 2, y: 0 })
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, c, 1)
 * })
 *
 * // Manhattan distance heuristic
 * const heuristic = (
 *   nodeData: { x: number; y: number },
 *   targetData: { x: number; y: number }
 * ) => Math.abs(nodeData.x - targetData.x) + Math.abs(nodeData.y - targetData.y)
 *
 * const result = Graph.astar(graph, {
 *   source: 0,
 *   target: 2,
 *   cost: (edgeData) => edgeData,
 *   heuristic
 * })
 *
 * if (result._tag === "Some") {
 *   console.log(result.value.path) // [0, 1, 2] - shortest path
 *   console.log(result.value.distance) // 2 - total distance
 * }
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const astar: {
  <E, N>(
    config: AstarConfig<E, N>
  ): <T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<PathResult<E>>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config: AstarConfig<E, N>
  ): Option.Option<PathResult<E>>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: AstarConfig<E, N>
): Option.Option<PathResult<E>> => {
  // Validate that source and target nodes exist
  if (!graph.nodes.has(config.source)) {
    throw missingNode(config.source)
  }
  if (!graph.nodes.has(config.target)) {
    throw missingNode(config.target)
  }

  // Early return if source equals target
  if (config.source === config.target) {
    return Option.some({
      path: [config.source],
      distance: 0,
      costs: []
    })
  }

  // Get target node data for heuristic calculations
  const targetNodeData = getNode(graph, config.target)
  if (Option.isNone(targetNodeData)) {
    throw new GraphError({ message: `Missing node data for target node ${config.target}` })
  }

  // Distance tracking (g-score) and f-score (g + h)
  const gScore = new Map<NodeIndex, number>()
  const fScore = new Map<NodeIndex, number>()
  const previous = new Map<NodeIndex, { node: NodeIndex; edgeData: E } | null>()
  const visited = new Set<NodeIndex>()

  // Initialize scores
  // Iterate directly over node keys
  for (const node of graph.nodes.keys()) {
    gScore.set(node, node === config.source ? 0 : Infinity)
    fScore.set(node, Infinity)
    previous.set(node, null)
  }

  // Calculate initial f-score for source
  const sourceNodeData = getNode(graph, config.source)
  if (Option.isSome(sourceNodeData)) {
    const h = config.heuristic(sourceNodeData.value, targetNodeData.value)
    fScore.set(config.source, h)
  }

  // Priority queue using f-score (total estimated cost)
  const openSet: Array<{ node: NodeIndex; fScore: number }> = [
    { node: config.source, fScore: fScore.get(config.source)! }
  ]

  while (openSet.length > 0) {
    // Find node with lowest f-score
    let minIndex = 0
    for (let i = 1; i < openSet.length; i++) {
      if (openSet[i].fScore < openSet[minIndex].fScore) {
        minIndex = i
      }
    }

    const current = openSet.splice(minIndex, 1)[0]
    const currentNode = current.node

    // Skip if already visited
    if (visited.has(currentNode)) {
      continue
    }

    visited.add(currentNode)

    // Early termination if we reached the target
    if (currentNode === config.target) {
      break
    }

    // Get current g-score
    const currentGScore = gScore.get(currentNode)!

    // Examine all outgoing edges
    const adjacencyList = graph.adjacency.get(currentNode)
    if (adjacencyList !== undefined) {
      for (const edgeIndex of adjacencyList) {
        const edge = graph.edges.get(edgeIndex)
        if (edge !== undefined) {
          const neighbor = edge.target
          const weight = config.cost(edge.data)

          // Validate non-negative weights
          if (weight < 0) {
            throw new GraphError({ message: "A* algorithm requires non-negative edge weights" })
          }

          const tentativeGScore = currentGScore + weight
          const neighborGScore = gScore.get(neighbor)!

          // If this path to neighbor is better than any previous one
          if (tentativeGScore < neighborGScore) {
            // Update g-score and previous
            gScore.set(neighbor, tentativeGScore)
            previous.set(neighbor, { node: currentNode, edgeData: edge.data })

            // Calculate f-score using heuristic
            const neighborNodeData = getNode(graph, neighbor)
            if (Option.isSome(neighborNodeData)) {
              const h = config.heuristic(neighborNodeData.value, targetNodeData.value)
              const f = tentativeGScore + h
              fScore.set(neighbor, f)

              // Add to open set if not visited
              if (!visited.has(neighbor)) {
                openSet.push({ node: neighbor, fScore: f })
              }
            }
          }
        }
      }
    }
  }

  // Check if target is reachable
  const distance = gScore.get(config.target)!
  if (distance === Infinity) {
    return Option.none() // No path exists
  }

  // Reconstruct path
  const path: Array<NodeIndex> = []
  const costs: Array<E> = []
  let currentNode: NodeIndex | null = config.target

  while (currentNode !== null) {
    path.unshift(currentNode)
    const prev: { node: NodeIndex; edgeData: E } | null = previous.get(currentNode) ?? null
    if (prev !== null) {
      costs.unshift(prev.edgeData)
      currentNode = prev.node
    } else {
      currentNode = null
    }
  }

  return Option.some({
    path,
    distance,
    costs
  })
})

/**
 * Configuration for finding a shortest path with the Bellman-Ford algorithm.
 *
 * **When to use**
 *
 * Use when configuring `bellmanFord` to find a shortest path where edge
 * weights may be negative.
 *
 * **Details**
 *
 * Specifies the source and target node indices, plus a cost function that maps
 * each edge's data to a numeric weight.
 *
 * @see {@link bellmanFord} for the algorithm that consumes this configuration
 * @see {@link DijkstraConfig} for non-negative edge costs
 * @see {@link AstarConfig} for heuristic shortest-path search
 *
 * @category models
 * @since 3.18.0
 */
export interface BellmanFordConfig<E> {
  source: NodeIndex
  target: NodeIndex
  cost: (edgeData: E) => number
}

/**
 * Finds the shortest path from the configured source node to the target node
 * using the Bellman-Ford algorithm.
 *
 * **Details**
 *
 * Negative edge weights are allowed. Returns `Option.none()` when the target is
 * unreachable or when a negative cycle affects the path to the target. Throws a
 * `GraphError` when either endpoint is missing.
 *
 * **Example** (Finding shortest paths with Bellman-Ford)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, -1) // Negative weight allowed
 *   Graph.addEdge(mutable, b, c, 3)
 *   Graph.addEdge(mutable, a, c, 5)
 * })
 *
 * const result = Graph.bellmanFord(graph, {
 *   source: 0,
 *   target: 2,
 *   cost: (edgeData) => edgeData
 * })
 *
 * if (result._tag === "Some") {
 *   console.log(result.value.path) // [0, 1, 2] - shortest path A->B->C
 *   console.log(result.value.distance) // 2 - total distance
 * }
 * ```
 *
 * @category algorithms
 * @since 3.18.0
 */
export const bellmanFord: {
  <E>(
    config: BellmanFordConfig<E>
  ): <N, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => Option.Option<PathResult<E>>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config: BellmanFordConfig<E>
  ): Option.Option<PathResult<E>>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: BellmanFordConfig<E>
): Option.Option<PathResult<E>> => {
  // Validate that source and target nodes exist
  if (!graph.nodes.has(config.source)) {
    throw missingNode(config.source)
  }
  if (!graph.nodes.has(config.target)) {
    throw missingNode(config.target)
  }

  // Early return if source equals target
  if (config.source === config.target) {
    return Option.some({
      path: [config.source],
      distance: 0,
      costs: []
    })
  }

  // Initialize distances and predecessors
  const distances = new Map<NodeIndex, number>()
  const previous = new Map<NodeIndex, { node: NodeIndex; edgeData: E } | null>()

  // Iterate directly over node keys
  for (const node of graph.nodes.keys()) {
    distances.set(node, node === config.source ? 0 : Infinity)
    previous.set(node, null)
  }

  // Collect all edges for relaxation
  const edges: Array<{ source: NodeIndex; target: NodeIndex; weight: number; edgeData: E }> = []
  for (const [, edgeData] of graph.edges) {
    const weight = config.cost(edgeData.data)
    edges.push({
      source: edgeData.source,
      target: edgeData.target,
      weight,
      edgeData: edgeData.data
    })
  }

  // Relax edges up to V-1 times
  const nodeCount = graph.nodes.size
  for (let i = 0; i < nodeCount - 1; i++) {
    let hasUpdate = false

    for (const edge of edges) {
      const sourceDistance = distances.get(edge.source)!
      const targetDistance = distances.get(edge.target)!

      // Relaxation step
      if (sourceDistance !== Infinity && sourceDistance + edge.weight < targetDistance) {
        distances.set(edge.target, sourceDistance + edge.weight)
        previous.set(edge.target, { node: edge.source, edgeData: edge.edgeData })
        hasUpdate = true
      }
    }

    // Early termination if no updates
    if (!hasUpdate) {
      break
    }
  }

  // Check for negative cycles
  for (const edge of edges) {
    const sourceDistance = distances.get(edge.source)!
    const targetDistance = distances.get(edge.target)!

    if (sourceDistance !== Infinity && sourceDistance + edge.weight < targetDistance) {
      // Negative cycle detected - check if it affects the path to target
      const affectedNodes = new Set<NodeIndex>()
      const queue = [edge.target]

      while (queue.length > 0) {
        const node = queue.shift()!
        if (affectedNodes.has(node)) continue
        affectedNodes.add(node)

        // Add all nodes reachable from this node
        const adjacencyList = graph.adjacency.get(node)
        if (adjacencyList !== undefined) {
          for (const edgeIndex of adjacencyList) {
            const edge = graph.edges.get(edgeIndex)
            if (edge !== undefined) {
              queue.push(edge.target)
            }
          }
        }
      }

      // If target is affected by a negative cycle, no shortest path exists.
      if (affectedNodes.has(config.target)) {
        return Option.none()
      }
    }
  }

  // Check if target is reachable
  const distance = distances.get(config.target)!
  if (distance === Infinity) {
    return Option.none() // No path exists
  }

  // Reconstruct path
  const path: Array<NodeIndex> = []
  const costs: Array<E> = []
  let currentNode: NodeIndex | null = config.target

  while (currentNode !== null) {
    path.unshift(currentNode)
    const prev: { node: NodeIndex; edgeData: E } | null = previous.get(currentNode)!
    if (prev !== null) {
      costs.unshift(prev.edgeData)
      currentNode = prev.node
    } else {
      currentNode = null
    }
  }

  return Option.some({
    path,
    distance,
    costs
  })
})

/**
 * Represents an iterable wrapper used by graph traversal and listing APIs.
 *
 * **Details**
 *
 * A `Walker` yields `[index, data]` pairs lazily and can be viewed as just the
 * indices, just the values, or mapped entries with `indices`, `values`,
 * `entries`, and `visit`.
 *
 * **Example** (Working with node walkers)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, 1)
 * })
 *
 * // Both traversal and element iterators return NodeWalker
 * const dfsNodes: Graph.NodeWalker<string> = Graph.dfs(graph, { start: [0] })
 * const allNodes: Graph.NodeWalker<string> = Graph.nodes(graph)
 *
 * // Common interface for working with node iterables
 * function processNodes<N>(nodeIterable: Graph.NodeWalker<N>): Array<number> {
 *   return Array.from(Graph.indices(nodeIterable))
 * }
 *
 * // Access node data using values() or entries()
 * const nodeData = Array.from(Graph.values(dfsNodes)) // ["A", "B"]
 * const nodeEntries = Array.from(Graph.entries(allNodes)) // [[0, "A"], [1, "B"]]
 * ```
 *
 * @category models
 * @since 3.18.0
 */
export class Walker<T, N> implements Iterable<[T, N]> {
  // @ts-ignore
  readonly [Symbol.iterator]: () => Iterator<[T, N]>

  /**
   * Visits each element and maps it to a value using the provided function.
   *
   * **Details**
   *
   * Takes a function that receives the index and data,
   * and returns an iterable of the mapped values. Skips elements that
   * no longer exist in the graph.
   *
   * **Example** (Visiting walker elements)
   *
   * ```ts
   * import { Graph } from "effect"
   *
   * const graph = Graph.directed<string, number>((mutable) => {
   *   const a = Graph.addNode(mutable, "A")
   *   const b = Graph.addNode(mutable, "B")
   *   Graph.addEdge(mutable, a, b, 1)
   * })
   *
   * const dfs = Graph.dfs(graph, { start: [0] })
   *
   * // Map to just the node data
   * const values = Array.from(dfs.visit((index, data) => data))
   * console.log(values) // ["A", "B"]
   *
   * // Map to custom objects
   * const custom = Array.from(
   *   dfs.visit((index, data) => ({ id: index, name: data }))
   * )
   * console.log(custom) // [{ id: 0, name: "A" }, { id: 1, name: "B" }]
   * ```
   *
   * @since 4.0.0
   */
  readonly visit: <U>(f: (index: T, data: N) => U) => Iterable<U>

  constructor(
    /**
     * Visits each element and maps it to a value using the provided function.
     *
     * Takes a function that receives the index and data,
     * and returns an iterable of the mapped values. Skips elements that
     * no longer exist in the graph.
     *
     * **Example** (Visiting walker elements)
     *
     * ```ts
     * import { Graph } from "effect"
     *
     * const graph = Graph.directed<string, number>((mutable) => {
     *   const a = Graph.addNode(mutable, "A")
     *   const b = Graph.addNode(mutable, "B")
     *   Graph.addEdge(mutable, a, b, 1)
     * })
     *
     * const dfs = Graph.dfs(graph, { start: [0] })
     *
     * // Map to just the node data
     * const values = Array.from(dfs.visit((index, data) => data))
     * console.log(values) // ["A", "B"]
     *
     * // Map to custom objects
     * const custom = Array.from(
     *   dfs.visit((index, data) => ({ id: index, name: data }))
     * )
     * console.log(custom) // [{ id: 0, name: "A" }, { id: 1, name: "B" }]
     * ```
     *
     * @category iterators
     * @since 4.0.0
     */
    visit: <U>(f: (index: T, data: N) => U) => Iterable<U>
  ) {
    this.visit = visit
    this[Symbol.iterator] = visit((index, data) => [index, data] as [T, N])[Symbol.iterator]
  }
}

/**
 * Type alias for node iteration using Walker.
 * NodeWalker is represented as Walker<NodeIndex, N>.
 *
 * **When to use**
 *
 * Use as the shared node walker type returned by graph traversal and node
 * listing APIs.
 *
 * @see {@link Walker} for the generic lazy iterator wrapper
 * @see {@link EdgeWalker} for edge iterators
 *
 * @category models
 * @since 3.18.0
 */
export type NodeWalker<N> = Walker<NodeIndex, N>

/**
 * Type alias for edge iteration using Walker.
 * EdgeWalker is represented as Walker<EdgeIndex, Edge<E>>.
 *
 * **When to use**
 *
 * Use to type helpers or parameters that consume edge iterators returned by
 * `Graph` APIs, where each item is keyed by an `EdgeIndex` and carries the
 * full `Edge`.
 *
 * @see {@link Walker} for the generic lazy iterator wrapper
 * @see {@link NodeWalker} for node iterators
 * @see {@link edges} for creating edge walkers
 *
 * @category models
 * @since 3.18.0
 */
export type EdgeWalker<E> = Walker<EdgeIndex, Edge<E>>

/**
 * Returns an iterator over the indices in the walker.
 *
 * **Example** (Iterating walker indices)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, 1)
 * })
 *
 * const dfs = Graph.dfs(graph, { start: [0] })
 * const indices = Array.from(Graph.indices(dfs))
 * console.log(indices) // [0, 1]
 * ```
 *
 * @category utils
 * @since 3.18.0
 */
export const indices = <T, N>(walker: Walker<T, N>): Iterable<T> => walker.visit((index, _) => index)

/**
 * Returns an iterator over the values (data) in the walker.
 *
 * **Example** (Iterating walker values)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, 1)
 * })
 *
 * const dfs = Graph.dfs(graph, { start: [0] })
 * const values = Array.from(Graph.values(dfs))
 * console.log(values) // ["A", "B"]
 * ```
 *
 * @category utils
 * @since 3.18.0
 */
export const values = <T, N>(walker: Walker<T, N>): Iterable<N> => walker.visit((_, data) => data)

/**
 * Returns an iterator over [index, data] entries in the walker.
 *
 * **Example** (Iterating walker entries)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, 1)
 * })
 *
 * const dfs = Graph.dfs(graph, { start: [0] })
 * const entries = Array.from(Graph.entries(dfs))
 * console.log(entries) // [[0, "A"], [1, "B"]]
 * ```
 *
 * @category utils
 * @since 3.18.0
 */
export const entries = <T, N>(walker: Walker<T, N>): Iterable<[T, N]> =>
  walker.visit((index, data) => [index, data] as [T, N])

/**
 * Configuration for DFS, BFS, and postorder graph traversals.
 *
 * **When to use**
 *
 * Use to configure the starting node indices and edge-following direction for
 * lazy graph traversals.
 *
 * **Details**
 *
 * `start` supplies the node indices where traversal begins. If it is omitted,
 * the iterator is empty. `direction` chooses whether traversal follows
 * outgoing or incoming edges.
 *
 * **Gotchas**
 *
 * Traversal creation throws a `GraphError` when any configured `start` node
 * does not exist.
 *
 * @see {@link dfs} for depth-first traversal
 * @see {@link bfs} for breadth-first traversal
 * @see {@link dfsPostOrder} for depth-first postorder traversal
 *
 * @category models
 * @since 3.18.0
 */
export interface SearchConfig {
  readonly start?: Array<NodeIndex>
  readonly direction?: Direction
}

/**
 * Creates a lazy depth-first traversal iterator from the configured start
 * nodes.
 *
 * **Details**
 *
 * If no start nodes are supplied, the iterator is empty. The `direction` option
 * chooses whether to follow outgoing or incoming edges. Throws a `GraphError`
 * if any configured start node does not exist.
 *
 * **Example** (Traversing depth-first)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, c, 1)
 * })
 *
 * // Start from a specific node
 * const dfs1 = Graph.dfs(graph, { start: [0] })
 * for (const nodeIndex of Graph.indices(dfs1)) {
 *   console.log(nodeIndex) // Traverses in DFS order: 0, 1, 2
 * }
 *
 * // Empty iterator (no starting nodes)
 * const dfs2 = Graph.dfs(graph)
 * // Can be used programmatically
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const dfs: {
  (
    config?: SearchConfig
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => NodeWalker<N>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config?: SearchConfig
  ): NodeWalker<N>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: SearchConfig = {}
): NodeWalker<N> => {
  const start = config.start ?? []
  const direction = config.direction ?? "outgoing"

  // Validate that all start nodes exist
  for (const nodeIndex of start) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const stack = [...start]
      const discovered = new Set<NodeIndex>()

      const nextMapped = () => {
        while (stack.length > 0) {
          const current = stack.pop()!

          if (discovered.has(current)) {
            continue
          }

          discovered.add(current)

          const nodeDataOption = getNode(graph, current)
          if (Option.isNone(nodeDataOption)) {
            continue
          }

          const neighbors = neighborsDirected(graph, current, direction)
          for (let i = neighbors.length - 1; i >= 0; i--) {
            const neighbor = neighbors[i]
            if (!discovered.has(neighbor)) {
              stack.push(neighbor)
            }
          }

          return { done: false, value: f(current, nodeDataOption.value) }
        }

        return { done: true, value: undefined } as const
      }

      return { next: nextMapped }
    }
  }))
})

/**
 * Creates a lazy breadth-first traversal iterator from the configured start
 * nodes.
 *
 * **Details**
 *
 * If no start nodes are supplied, the iterator is empty. The `direction` option
 * chooses whether to follow outgoing or incoming edges. Throws a `GraphError`
 * if any configured start node does not exist.
 *
 * **Example** (Traversing breadth-first)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, c, 1)
 * })
 *
 * // Start from a specific node
 * const bfs1 = Graph.bfs(graph, { start: [0] })
 * for (const nodeIndex of Graph.indices(bfs1)) {
 *   console.log(nodeIndex) // Traverses in BFS order: 0, 1, 2
 * }
 *
 * // Empty iterator (no starting nodes)
 * const bfs2 = Graph.bfs(graph)
 * // Can be used programmatically
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const bfs: {
  (
    config?: SearchConfig
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => NodeWalker<N>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config?: SearchConfig
  ): NodeWalker<N>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: SearchConfig = {}
): NodeWalker<N> => {
  const start = config.start ?? []
  const direction = config.direction ?? "outgoing"

  // Validate that all start nodes exist
  for (const nodeIndex of start) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const queue = [...start]
      const discovered = new Set<NodeIndex>()

      const nextMapped = () => {
        while (queue.length > 0) {
          const current = queue.shift()!

          if (!discovered.has(current)) {
            discovered.add(current)

            const neighbors = neighborsDirected(graph, current, direction)
            for (const neighbor of neighbors) {
              if (!discovered.has(neighbor)) {
                queue.push(neighbor)
              }
            }

            const nodeData = getNode(graph, current)
            if (Option.isSome(nodeData)) {
              return { done: false, value: f(current, nodeData.value) }
            }
            return nextMapped()
          }
        }

        return { done: true, value: undefined } as const
      }

      return { next: nextMapped }
    }
  }))
})

/**
 * Configuration for the topological sort iterator.
 *
 * **When to use**
 *
 * Use to seed a topological sort with specific initial node indices instead of
 * starting from every zero in-degree node.
 *
 * **Details**
 *
 * `initials` optionally supplies the node indices used as initial queue
 * entries. When omitted, topological sorting starts from all nodes with zero
 * in-degree.
 *
 * @see {@link topo} for the iterator that consumes this configuration
 *
 * @category models
 * @since 3.18.0
 */
export interface TopoConfig {
  readonly initials?: Array<NodeIndex>
}

/**
 * Creates a new topological sort iterator with optional configuration.
 *
 * **Details**
 *
 * The iterator uses Kahn's algorithm to lazily produce nodes in topological order.
 * Throws an error if the graph contains cycles.
 *
 * **Example** (Sorting topologically)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, c, 1)
 * })
 *
 * // Standard topological sort
 * const topo1 = Graph.topo(graph)
 * for (const nodeIndex of Graph.indices(topo1)) {
 *   console.log(nodeIndex) // 0, 1, 2 (topological order)
 * }
 *
 * // With initial nodes
 * const topo2 = Graph.topo(graph, { initials: [0] })
 *
 * // Check before sorting a cyclic graph
 * const cyclicGraph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, a, 2) // Creates cycle
 * })
 *
 * if (!Graph.isAcyclic(cyclicGraph)) {
 *   console.log("cyclic graph") // cyclic graph
 * }
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const topo: {
  (
    config?: TopoConfig
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => NodeWalker<N>
  <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>, config?: TopoConfig): NodeWalker<N>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: TopoConfig = {}
): NodeWalker<N> => {
  // Check if graph is acyclic first
  if (!isAcyclic(graph)) {
    throw new GraphError({ message: "Cannot perform topological sort on cyclic graph" })
  }

  const initials = config.initials ?? []

  // Validate that all initial nodes exist
  for (const nodeIndex of initials) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const inDegree = new Map<NodeIndex, number>()
      const remaining = new Set<NodeIndex>()
      const queue = [...initials]

      // Initialize in-degree counts
      for (const [nodeIndex] of graph.nodes) {
        inDegree.set(nodeIndex, 0)
        remaining.add(nodeIndex)
      }

      // Calculate in-degrees
      for (const [, edgeData] of graph.edges) {
        const currentInDegree = inDegree.get(edgeData.target) || 0
        inDegree.set(edgeData.target, currentInDegree + 1)
      }

      // Add nodes with zero in-degree to queue if no initials provided
      if (initials.length === 0) {
        for (const [nodeIndex, degree] of inDegree) {
          if (degree === 0) {
            queue.push(nodeIndex)
          }
        }
      }

      const nextMapped = () => {
        while (queue.length > 0) {
          const current = queue.shift()!

          if (remaining.has(current)) {
            remaining.delete(current)

            // Process outgoing edges, reducing in-degree of targets
            const neighbors = neighborsDirected(graph, current, "outgoing")
            for (const neighbor of neighbors) {
              if (remaining.has(neighbor)) {
                const currentInDegree = inDegree.get(neighbor) || 0
                const newInDegree = currentInDegree - 1
                inDegree.set(neighbor, newInDegree)

                // If in-degree becomes 0, add to queue
                if (newInDegree === 0) {
                  queue.push(neighbor)
                }
              }
            }

            const nodeData = getNode(graph, current)
            if (Option.isSome(nodeData)) {
              return { done: false, value: f(current, nodeData.value) }
            }
            return nextMapped()
          }
        }

        return { done: true, value: undefined } as const
      }

      return { next: nextMapped }
    }
  }))
})

/**
 * Creates a lazy depth-first postorder traversal iterator from the configured
 * start nodes.
 *
 * **Details**
 *
 * Nodes are emitted after their reachable descendants have been processed. If
 * no start nodes are supplied, the iterator is empty. The `direction` option
 * chooses whether to follow outgoing or incoming edges.
 *
 * **Example** (Traversing in postorder)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const root = Graph.addNode(mutable, "root")
 *   const child1 = Graph.addNode(mutable, "child1")
 *   const child2 = Graph.addNode(mutable, "child2")
 *   Graph.addEdge(mutable, root, child1, 1)
 *   Graph.addEdge(mutable, root, child2, 1)
 * })
 *
 * // Postorder: children before parents
 * const postOrder = Graph.dfsPostOrder(graph, { start: [0] })
 * for (const node of postOrder) {
 *   console.log(node) // 1, 2, 0
 * }
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const dfsPostOrder: {
  (
    config?: SearchConfig
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => NodeWalker<N>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config?: SearchConfig
  ): NodeWalker<N>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: SearchConfig = {}
): NodeWalker<N> => {
  const start = config.start ?? []
  const direction = config.direction ?? "outgoing"

  // Validate that all start nodes exist
  for (const nodeIndex of start) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const stack: Array<{ node: NodeIndex; visitedChildren: boolean }> = []
      const discovered = new Set<NodeIndex>()
      const finished = new Set<NodeIndex>()

      // Initialize stack with start nodes
      for (let i = start.length - 1; i >= 0; i--) {
        stack.push({ node: start[i], visitedChildren: false })
      }

      const nextMapped = () => {
        while (stack.length > 0) {
          const current = stack[stack.length - 1]

          if (!discovered.has(current.node)) {
            discovered.add(current.node)
            current.visitedChildren = false
          }

          if (!current.visitedChildren) {
            current.visitedChildren = true
            const neighbors = neighborsDirected(graph, current.node, direction)

            for (let i = neighbors.length - 1; i >= 0; i--) {
              const neighbor = neighbors[i]
              if (!discovered.has(neighbor) && !finished.has(neighbor)) {
                stack.push({ node: neighbor, visitedChildren: false })
              }
            }
          } else {
            const nodeToEmit = stack.pop()!.node

            if (!finished.has(nodeToEmit)) {
              finished.add(nodeToEmit)

              const nodeData = getNode(graph, nodeToEmit)
              if (Option.isSome(nodeData)) {
                return { done: false, value: f(nodeToEmit, nodeData.value) }
              }
              return nextMapped()
            }
          }
        }

        return { done: true, value: undefined } as const
      }

      return { next: nextMapped }
    }
  }))
})

/**
 * Creates an iterator over all node indices in the graph.
 *
 * **Details**
 *
 * The iterator produces node indices in the order they were added to the graph.
 * This provides access to all nodes regardless of connectivity.
 *
 * **Example** (Iterating all nodes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 1)
 * })
 *
 * const indices = Array.from(Graph.indices(Graph.nodes(graph)))
 * console.log(indices) // [0, 1, 2]
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const nodes = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): NodeWalker<N> =>
  new Walker((f) => ({
    [Symbol.iterator]() {
      const nodeMap = graph.nodes
      const iterator = nodeMap.entries()

      return {
        next() {
          const result = iterator.next()
          if (result.done) {
            return { done: true, value: undefined }
          }
          const [nodeIndex, nodeData] = result.value
          return { done: false, value: f(nodeIndex, nodeData) }
        }
      }
    }
  }))

/**
 * Creates an iterator over all edge indices in the graph.
 *
 * **Details**
 *
 * The iterator produces edge indices in the order they were added to the graph.
 * This provides access to all edges regardless of connectivity.
 *
 * **Example** (Iterating all edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, 1)
 *   Graph.addEdge(mutable, b, c, 2)
 * })
 *
 * const indices = Array.from(Graph.indices(Graph.edges(graph)))
 * console.log(indices) // [0, 1]
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const edges = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): EdgeWalker<E> =>
  new Walker((f) => ({
    [Symbol.iterator]() {
      const edgeMap = graph.edges
      const iterator = edgeMap.entries()

      return {
        next() {
          const result = iterator.next()
          if (result.done) {
            return { done: true, value: undefined }
          }
          const [edgeIndex, edgeData] = result.value
          return { done: false, value: f(edgeIndex, edgeData) }
        }
      }
    }
  }))

/**
 * Configuration for selecting external nodes.
 *
 * **When to use**
 *
 * Use to configure how `externals` identifies graph boundary nodes when you
 * need sinks with no outgoing edges or sources with no incoming edges.
 *
 * **Details**
 *
 * `direction` chooses which missing edge direction makes a node external:
 * `"outgoing"` selects nodes with no outgoing edges, and `"incoming"` selects
 * nodes with no incoming edges. If omitted, `direction` defaults to
 * `"outgoing"`.
 *
 * @see {@link externals} for the iterator that consumes this configuration
 *
 * @category models
 * @since 3.18.0
 */
export interface ExternalsConfig {
  readonly direction?: Direction
}

/**
 * Creates an iterator over external nodes (nodes without edges in the specified direction).
 *
 * **Details**
 *
 * External nodes have no outgoing edges (`direction: "outgoing"`) or no
 * incoming edges (`direction: "incoming"`). These are useful for finding
 * sources, sinks, or isolated nodes.
 *
 * **Example** (Iterating external nodes)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, number>((mutable) => {
 *   const source = Graph.addNode(mutable, "source") // 0 - no incoming
 *   const middle = Graph.addNode(mutable, "middle") // 1 - has both
 *   const sink = Graph.addNode(mutable, "sink") // 2 - no outgoing
 *   const isolated = Graph.addNode(mutable, "isolated") // 3 - no edges
 *
 *   Graph.addEdge(mutable, source, middle, 1)
 *   Graph.addEdge(mutable, middle, sink, 2)
 * })
 *
 * // Nodes with no outgoing edges (sinks + isolated)
 * const sinks = Array.from(
 *   Graph.indices(Graph.externals(graph, { direction: "outgoing" }))
 * )
 * console.log(sinks) // [2, 3]
 *
 * // Nodes with no incoming edges (sources + isolated)
 * const sources = Array.from(
 *   Graph.indices(Graph.externals(graph, { direction: "incoming" }))
 * )
 * console.log(sources) // [0, 3]
 * ```
 *
 * @category iterators
 * @since 3.18.0
 */
export const externals: {
  (
    config?: ExternalsConfig
  ): <N, E, T extends Kind = "directed">(graph: Graph<N, E, T> | MutableGraph<N, E, T>) => NodeWalker<N>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    config?: ExternalsConfig
  ): NodeWalker<N>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: ExternalsConfig = {}
): NodeWalker<N> => {
  const direction = config.direction ?? "outgoing"

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const nodeMap = graph.nodes
      const adjacencyMap = direction === "incoming"
        ? graph.reverseAdjacency
        : graph.adjacency

      const nodeIterator = nodeMap.entries()

      const nextMapped = () => {
        let current = nodeIterator.next()
        while (!current.done) {
          const [nodeIndex, nodeData] = current.value
          const adjacencyList = adjacencyMap.get(nodeIndex)

          // Node is external if it has no edges in the specified direction
          if (adjacencyList === undefined || adjacencyList.length === 0) {
            return { done: false, value: f(nodeIndex, nodeData) }
          }
          current = nodeIterator.next()
        }

        return { done: true, value: undefined } as const
      }

      return { next: nextMapped }
    }
  }))
})
