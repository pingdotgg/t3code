/**
 * Models relationships between indexed nodes and edges.
 *
 * This module provides immutable and scoped-mutable graph data structures. A
 * graph can be directed or undirected, and it can store user-defined data on
 * both nodes and edges. The module includes traversal, analysis, path-finding,
 * transformation, and diagram export utilities.
 *
 * @since 4.0.0
 */

import * as Data from "./Data.ts"
import * as Equal from "./Equal.ts"
import { dual } from "./Function.ts"
import * as Hash from "./Hash.ts"
import type { Inspectable } from "./Inspectable.ts"
import { NodeInspectSymbol } from "./Inspectable.ts"
import * as MutableHashMap from "./MutableHashMap.ts"
import * as Option from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import type { Covariant, Invariant, Mutable } from "./Types.ts"

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
 * Use as the graph edge value that carries source node, target node, and stored
 * edge data together.
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
 * Common public protocol for graph values.
 *
 * **Details**
 *
 * Contains only the runtime marker and shared protocols. Graph storage is kept
 * internal; use module functions such as `nodes`, `edges`, `getNode`, and
 * `getEdge` to inspect graph contents.
 *
 * @category models
 * @since 3.18.0
 */
export interface Proto<out N, out E> extends Iterable<readonly [NodeIndex, N]>, Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: Graph.Variance<N, E>
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
 * Companion namespace containing type-level metadata for immutable graphs.
 *
 * @category models
 * @since 4.0.0
 */
export declare namespace Graph {
  /**
   * Type-level variance marker for immutable graphs.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<out N, out E> {
    readonly _N: Covariant<N>
    readonly _E: Covariant<E>
  }
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
export interface MutableGraph<in out N, in out E, T extends Kind = "directed">
  extends Iterable<readonly [NodeIndex, N]>, Equal.Equal, Pipeable, Inspectable
{
  readonly [TypeId]: MutableGraph.Variance<N, E>
  readonly type: T
  readonly mutable: true
}

/**
 * Companion namespace containing type-level metadata for scoped mutable graphs.
 *
 * @category models
 * @since 4.0.0
 */
export declare namespace MutableGraph {
  /**
   * Type-level variance marker for scoped mutable graphs.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Variance<in out N, in out E> {
    readonly _N: Invariant<N>
    readonly _E: Invariant<E>
  }
}

/** @internal */
interface GraphImpl<in out N, in out E, T extends Kind = "directed">
  extends Iterable<readonly [NodeIndex, N]>, Equal.Equal, Pipeable, Inspectable
{
  readonly [TypeId]: unknown
  readonly type: T
  mutable: boolean
  nodes: Map<NodeIndex, N>
  edges: Map<EdgeIndex, Edge<E>>
  adjacency: Map<NodeIndex, Array<EdgeIndex>>
  reverseAdjacency: Map<NodeIndex, Array<EdgeIndex>>
  nextNodeIndex: NodeIndex
  nextEdgeIndex: EdgeIndex
  acyclic: Option.Option<boolean>
}

/** @internal */
const graphImpl = <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): GraphImpl<N, E, T> => graph as unknown as GraphImpl<N, E, T>

/** @internal */
const cloneAdjacency = (adjacency: Map<NodeIndex, Array<EdgeIndex>>): Map<NodeIndex, Array<EdgeIndex>> => {
  const cloned = new Map<NodeIndex, Array<EdgeIndex>>()
  for (const [nodeIndex, edges] of adjacency) {
    cloned.set(nodeIndex, [...edges])
  }
  return cloned
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
const edgeEquals = (type: Kind, self: Edge<any>, that: Edge<any>): boolean =>
  (type === "directed"
    ? self.source === that.source && self.target === that.target
    : (self.source === that.source && self.target === that.target) ||
      (self.source === that.target && self.target === that.source)) &&
  Equal.equals(self.data, that.data)

/** @internal */
const edgeHash = (type: Kind, edge: Edge<any>): number =>
  type === "directed"
    ? Hash.hash(edge)
    : Hash.optimize(Hash.hash(edge.data) ^ (Hash.hash(edge.source) + Hash.hash(edge.target)))

/** @internal */
const ProtoGraph = {
  [TypeId]: {
    _N: (_: never) => _,
    _E: (_: never) => _
  },
  [Symbol.iterator](this: GraphImpl<any, any>) {
    return this.nodes[Symbol.iterator]()
  },
  [NodeInspectSymbol](this: GraphImpl<any, any>) {
    return this.toJSON()
  },
  [Equal.symbol](this: GraphImpl<any, any>, that: Equal.Equal): boolean {
    if (isGraph(that)) {
      const thatImpl = graphImpl(that)
      if (
        this.nodes.size !== thatImpl.nodes.size ||
        this.edges.size !== thatImpl.edges.size ||
        this.nextNodeIndex !== thatImpl.nextNodeIndex ||
        this.nextEdgeIndex !== thatImpl.nextEdgeIndex ||
        this.type !== thatImpl.type
      ) {
        return false
      }
      // Compare nodes
      for (const [nodeIndex, nodeData] of this.nodes) {
        if (!thatImpl.nodes.has(nodeIndex)) {
          return false
        }
        const otherNodeData = thatImpl.nodes.get(nodeIndex)!
        if (!Equal.equals(nodeData, otherNodeData)) {
          return false
        }
      }
      // Compare edges
      for (const [edgeIndex, edgeData] of this.edges) {
        if (!thatImpl.edges.has(edgeIndex)) {
          return false
        }
        const otherEdge = thatImpl.edges.get(edgeIndex)!
        if (!edgeEquals(this.type, edgeData, otherEdge)) {
          return false
        }
      }
      return true
    }
    return false
  },
  [Hash.symbol](this: GraphImpl<any, any>): number {
    let hash = Hash.string("Graph")
    hash = hash ^ Hash.string(this.type)
    hash = hash ^ Hash.number(this.nodes.size)
    hash = hash ^ Hash.number(this.edges.size)
    hash = hash ^ Hash.number(this.nextNodeIndex)
    hash = hash ^ Hash.number(this.nextEdgeIndex)
    for (const [nodeIndex, nodeData] of this.nodes) {
      hash = hash ^ (Hash.hash(nodeIndex) + Hash.hash(nodeData))
    }
    for (const [edgeIndex, edgeData] of this.edges) {
      hash = hash ^ (Hash.hash(edgeIndex) + edgeHash(this.type, edgeData))
    }
    return hash
  },
  toJSON(this: GraphImpl<any, any>) {
    return {
      _id: "Graph",
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      type: this.type
    }
  },
  toString(this: GraphImpl<any, any>) {
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

/** @internal */
function assertMutable<N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>
): asserts graph is MutableGraph<N, E, T> {
  if (!graph.mutable) {
    throw new GraphError({ message: "Graph is not mutable" })
  }
}

// =============================================================================
// Constructors
// =============================================================================

/**
 * Returns `true` if a value has the graph runtime type identifier, narrowing
 * it to an immutable or mutable graph.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before treating it as a graph value.
 *
 * **Gotchas**
 *
 * This guard checks the shared graph runtime type identifier and does not
 * distinguish immutable graphs from mutable graphs or directed graphs from
 * undirected graphs.
 *
 * @category guards
 * @since 4.0.0
 */
export const isGraph = <N = unknown, E = unknown, T extends Kind = Kind, U = never>(
  u: U | Graph<N, E, T> | MutableGraph<N, E, T>
): u is Graph<N, E, T> | MutableGraph<N, E, T> => hasProperty(u, TypeId)

/**
 * Creates a graph constructor for the specified graph kind.
 *
 * **When to use**
 *
 * Use when the graph kind is selected dynamically. Prefer `directed` or
 * `undirected` when the kind is known statically.
 *
 * **Example** (Constructing by kind)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const makeGraph = Graph.make("directed")
 * const graph = makeGraph<string, number>((mutable) => {
 *   Graph.addNode(mutable, "A")
 * })
 *
 * console.log(graph.type) // "directed"
 * ```
 *
 * @see {@link directed} for constructing a directed graph directly
 * @see {@link undirected} for constructing an undirected graph directly
 * @category constructors
 * @since 4.0.0
 */
export const make =
  <T extends Kind>(type: T) => <N, E>(mutate?: (mutable: MutableGraph<N, E, T>) => undefined): Graph<N, E, T> => {
    const graph: Mutable<GraphImpl<N, E, T>> = Object.create(ProtoGraph)
    graph.type = type
    graph.nodes = new Map()
    graph.edges = new Map()
    graph.adjacency = new Map()
    graph.reverseAdjacency = new Map()
    graph.nextNodeIndex = 0
    graph.nextEdgeIndex = 0
    graph.acyclic = Option.some(true)

    if (mutate === undefined) {
      graph.mutable = false
      return graph as unknown as Graph<N, E, T>
    }

    graph.mutable = true
    const mutable = Equal.byReferenceUnsafe(graph as unknown as MutableGraph<N, E, T>)
    return mutateScoped(mutable, mutate)
  }

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
export const directed: <N, E>(
  mutate?: (mutable: MutableDirectedGraph<N, E>) => undefined
) => DirectedGraph<N, E> = make("directed")

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
export const undirected: <N, E>(
  mutate?: (mutable: MutableUndirectedGraph<N, E>) => undefined
) => UndirectedGraph<N, E> = make("undirected")

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
  const source = graphImpl(graph)
  const adjacency = cloneAdjacency(source.adjacency)
  const reverseAdjacency = cloneAdjacency(source.reverseAdjacency)

  const mutable: Mutable<GraphImpl<N, E, T>> = Object.create(ProtoGraph)
  mutable.type = source.type
  mutable.nodes = new Map(source.nodes)
  mutable.edges = new Map(source.edges)
  mutable.adjacency = adjacency
  mutable.reverseAdjacency = reverseAdjacency
  mutable.nextNodeIndex = source.nextNodeIndex
  mutable.nextEdgeIndex = source.nextEdgeIndex
  mutable.acyclic = source.acyclic
  mutable.mutable = true

  return Equal.byReferenceUnsafe(mutable as unknown as MutableGraph<N, E, T>)
}

/**
 * Converts a mutable graph back to an immutable graph, ending the mutation scope.
 *
 * **Details**
 *
 * Finalizes the mutable handle. Later public mutation operations on that handle
 * fail with a `GraphError`.
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
  assertMutable(mutable)
  const source = graphImpl(mutable)

  const graph: Mutable<GraphImpl<N, E, T>> = Object.create(ProtoGraph)
  graph.type = source.type
  graph.nodes = new Map(source.nodes)
  graph.edges = new Map(source.edges)
  graph.adjacency = cloneAdjacency(source.adjacency)
  graph.reverseAdjacency = cloneAdjacency(source.reverseAdjacency)
  graph.nextNodeIndex = source.nextNodeIndex
  graph.nextEdgeIndex = source.nextEdgeIndex
  graph.acyclic = source.acyclic
  graph.mutable = false
  source.mutable = false

  return graph as unknown as Graph<N, E, T>
}

/** @internal */
const mutateScoped = <N, E, T extends Kind>(
  mutable: MutableGraph<N, E, T>,
  f: (mutable: MutableGraph<N, E, T>) => undefined
): Graph<N, E, T> => {
  let graph: Graph<N, E, T>
  try {
    f(mutable)
  } finally {
    graph = endMutation(mutable)
  }
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
    f: (mutable: MutableGraph<N, E, T>) => undefined
  ): (graph: Graph<N, E, T>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T>,
    f: (mutable: MutableGraph<N, E, T>) => undefined
  ): Graph<N, E, T>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T>,
  f: (mutable: MutableGraph<N, E, T>) => undefined
): Graph<N, E, T> => {
  const mutable = beginMutation(graph)
  return mutateScoped(mutable, f)
})

// =============================================================================
// Set Operations
// =============================================================================

/** @internal */
type NodeMaps<N, I> = {
  readonly byIdentity: MutableHashMap.MutableHashMap<I, N>
  readonly byIndex: Map<NodeIndex, I>
}

/** @internal */
class EdgeIdentity<NI, EI> implements Equal.Equal {
  readonly type: Kind
  readonly source: NI
  readonly target: NI
  readonly identity: EI

  constructor(
    type: Kind,
    source: NI,
    target: NI,
    identity: EI
  ) {
    this.type = type
    this.source = source
    this.target = target
    this.identity = identity
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    if (!(that instanceof EdgeIdentity) || this.type !== that.type || !Equal.equals(this.identity, that.identity)) {
      return false
    }

    if (this.type === "directed") {
      return Equal.equals(this.source, that.source) && Equal.equals(this.target, that.target)
    }

    return (
      (Equal.equals(this.source, that.source) && Equal.equals(this.target, that.target)) ||
      (Equal.equals(this.source, that.target) && Equal.equals(this.target, that.source))
    )
  }

  [Hash.symbol](): number {
    const hash = Hash.hash(this.identity)
    return this.type === "directed"
      ? Hash.combine(Hash.hash(this.target))(Hash.combine(Hash.hash(this.source))(hash))
      : Hash.optimize(hash ^ (Hash.hash(this.source) + Hash.hash(this.target)))
  }
}

/**
 * Configures node and edge identity for graph set operations.
 *
 * **Details**
 *
 * Both functions default to using the complete node or edge data. Edge identity
 * also includes the identities of its endpoint nodes and the graph kind.
 *
 * **Gotchas**
 *
 * Edge identity defines set membership, not edge multiplicity. Parallel edges
 * with the same endpoint identities and projected edge identity are treated as
 * the same member by graph set operations.
 *
 * @category models
 * @since 4.0.0
 */
export interface IdentityOptions<N, E, NI = N, EI = E> {
  readonly nodeIdentity?: (node: N) => NI
  readonly edgeIdentity?: (edge: E) => EI
}

/** @internal */
const buildNodeMaps = <N, E, T extends Kind, I>(
  graph: Graph<N, E, T>,
  identity: (node: N) => I
): NodeMaps<N, I> => {
  const impl = graphImpl(graph)
  const byIdentity = MutableHashMap.empty<I, N>()
  const byIndex = new Map<NodeIndex, I>()

  for (const [index, data] of impl.nodes) {
    const nodeIdentity = identity(data)
    MutableHashMap.set(byIdentity, nodeIdentity, data)
    byIndex.set(index, nodeIdentity)
  }

  return { byIdentity, byIndex }
}

/** @internal */
const nodeIdentityAt = <N, I>(maps: NodeMaps<N, I>, index: NodeIndex): I => maps.byIndex.get(index) as I

/** @internal */
const buildEdgeMap = <N, E, T extends Kind, NI, EI>(
  graph: Graph<N, E, T>,
  nodeMaps: NodeMaps<N, NI>,
  identity: (edge: E) => EI
): MutableHashMap.MutableHashMap<EdgeIdentity<NI, EI>, E> => {
  const impl = graphImpl(graph)
  const edges = MutableHashMap.empty<EdgeIdentity<NI, EI>, E>()
  for (const edge of impl.edges.values()) {
    const sourceIdentity = nodeIdentityAt(nodeMaps, edge.source)
    const targetIdentity = nodeIdentityAt(nodeMaps, edge.target)
    MutableHashMap.set(
      edges,
      new EdgeIdentity(graph.type, sourceIdentity, targetIdentity, identity(edge.data)),
      edge.data
    )
  }
  return edges
}

/** @internal */
const addNodesByIdentity = <N, E, T extends Kind, NI>(
  mutable: MutableGraph<N, E, T>,
  nodes: Iterable<readonly [NI, N]>
): MutableHashMap.MutableHashMap<NI, NodeIndex> => {
  const indexByIdentity = MutableHashMap.empty<NI, NodeIndex>()
  for (const [identity, data] of nodes) {
    MutableHashMap.set(indexByIdentity, identity, addNode(mutable, data))
  }
  return indexByIdentity
}

/** @internal */
const addEdgeByIdentity = <N, E, T extends Kind, NI, EI>(
  mutable: MutableGraph<N, E, T>,
  indexByIdentity: MutableHashMap.MutableHashMap<NI, NodeIndex>,
  identity: EdgeIdentity<NI, EI>,
  data: E
): void => {
  const sourceIndex = Option.getOrUndefined(MutableHashMap.get(indexByIdentity, identity.source))
  const targetIndex = Option.getOrUndefined(MutableHashMap.get(indexByIdentity, identity.target))
  if (sourceIndex !== undefined && targetIndex !== undefined) {
    addEdge(mutable, sourceIndex, targetIndex, data)
  }
}

/** @internal */
const assertSameKind = <N, E>(self: Graph<N, E, Kind>, that: Graph<N, E, Kind>): void => {
  if (self.type !== that.type) {
    throw new GraphError({ message: `Cannot combine ${self.type} and ${that.type} graphs` })
  }
}

/**
 * Composes two graphs, merging nodes by identity.
 *
 * **Details**
 *
 * Nodes and edges present in both graphs use data from `that`. The result has
 * the same graph kind as `self`. Throws a `GraphError` when the graph kinds do
 * not match. `nodeIdentity` and `edgeIdentity` default to the complete node and
 * edge data. Edge identity also includes the endpoint identities.
 *
 * `G1 ∪ G2 = {V1 ∪ V2, E1 ∪ E2}`
 *
 * **Gotchas**
 *
 * Nodes with equal identities in one input graph are coalesced. The last node
 * supplies the data, and redirected edges can collapse or become self-loops.
 * Parallel edges with equal identities are also coalesced, with the last edge
 * supplying the data.
 *
 * **Example** (Combining graphs)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const left = Graph.directed<{ id: string }, string>((mutable) => {
 *   const a = Graph.addNode(mutable, { id: "A" })
 *   const b = Graph.addNode(mutable, { id: "B" })
 *   Graph.addEdge(mutable, a, b, "A-B")
 * })
 *
 * const right = Graph.directed<{ id: string }, string>((mutable) => {
 *   const b = Graph.addNode(mutable, { id: "B" })
 *   const c = Graph.addNode(mutable, { id: "C" })
 *   Graph.addEdge(mutable, b, c, "B-C")
 * })
 *
 * const result = Graph.compose(left, right, {
 *   nodeIdentity: (node) => node.id
 * })
 *
 * console.log(Graph.nodeCount(result)) // 3
 * console.log(Graph.edgeCount(result)) // 2
 * ```
 *
 * @category set operations
 * @since 4.0.0
 */
export const compose: {
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    that: Graph<N, E, T>,
    options?: IdentityOptions<N, E, NI, EI>
  ): (self: Graph<N, E, NoInfer<T>>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    self: Graph<N, E, T>,
    that: Graph<N, E, NoInfer<T>>,
    options?: IdentityOptions<N, E, NI, EI>
  ): Graph<N, E, T>
} = dual(
  (args) => isGraph(args[0]) && isGraph(args[1]),
  <N, E, T extends Kind, NI, EI>(
    self: Graph<N, E, T>,
    that: Graph<N, E, T>,
    options?: IdentityOptions<N, E, NI, EI>
  ): Graph<N, E, T> => {
    assertSameKind(self, that)
    const getNodeIdentity = options?.nodeIdentity ?? ((node: N) => node as unknown as NI)
    const getEdgeIdentity = options?.edgeIdentity ?? ((edge: E) => edge as unknown as EI)
    const selfMaps = buildNodeMaps(self, getNodeIdentity)
    const thatMaps = buildNodeMaps(that, getNodeIdentity)
    const nodes = MutableHashMap.empty<NI, N>()
    const edges = buildEdgeMap(self, selfMaps, getEdgeIdentity)

    for (const [identity, data] of selfMaps.byIdentity) {
      MutableHashMap.set(nodes, identity, data)
    }
    for (const [identity, data] of thatMaps.byIdentity) {
      MutableHashMap.set(nodes, identity, data)
    }

    for (const [identity, data] of buildEdgeMap(that, thatMaps, getEdgeIdentity)) {
      MutableHashMap.set(edges, identity, data)
    }

    return make(self.type)<N, E>((mutable) => {
      const indexByIdentity = addNodesByIdentity(mutable, nodes)

      for (const [identity, data] of edges) {
        addEdgeByIdentity(mutable, indexByIdentity, identity, data)
      }
    })
  }
)

/**
 * Returns the intersection of two graphs, matching nodes by identity.
 *
 * **Details**
 *
 * Node data comes from `self`, and edge data comes from `that`. The result has
 * the same graph kind as `self`. Throws a `GraphError` when the graph kinds do
 * not match. `nodeIdentity` and `edgeIdentity` default to the complete node and
 * edge data. Edge identity also includes the endpoint identities.
 *
 * `G1 ∩ G2 = {V1 ∩ V2, E1 ∩ E2}`
 *
 * **Gotchas**
 *
 * Nodes with equal identities in one input graph are coalesced. The last node
 * supplies the data, and redirected edges can collapse or become self-loops.
 * The result contains at most one edge for each shared edge identity.
 *
 * **Example** (Finding shared structure)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const left = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, "shared")
 * })
 *
 * const right = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, "shared")
 * })
 *
 * const result = Graph.intersection(left, right)
 *
 * console.log(Graph.nodeCount(result)) // 2
 * console.log(Graph.edgeCount(result)) // 1
 * ```
 *
 * @category set operations
 * @since 4.0.0
 */
export const intersection: {
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    that: Graph<N, E, T>,
    options?: IdentityOptions<N, E, NI, EI>
  ): (self: Graph<N, E, NoInfer<T>>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    self: Graph<N, E, T>,
    that: Graph<N, E, NoInfer<T>>,
    options?: IdentityOptions<N, E, NI, EI>
  ): Graph<N, E, T>
} = dual((args) => isGraph(args[0]) && isGraph(args[1]), <N, E, T extends Kind, NI, EI>(
  self: Graph<N, E, T>,
  that: Graph<N, E, T>,
  options?: IdentityOptions<N, E, NI, EI>
): Graph<N, E, T> => {
  assertSameKind(self, that)
  const thatImpl = graphImpl(that)
  const getNodeIdentity = options?.nodeIdentity ?? ((node: N) => node as unknown as NI)
  const getEdgeIdentity = options?.edgeIdentity ?? ((edge: E) => edge as unknown as EI)
  const selfMaps = buildNodeMaps(self, getNodeIdentity)
  const thatMaps = buildNodeMaps(that, getNodeIdentity)
  const nodes = MutableHashMap.empty<NI, N>()
  const selfEdges = buildEdgeMap(self, selfMaps, getEdgeIdentity)
  const thatEdges = MutableHashMap.empty<EdgeIdentity<NI, EI>, E>()

  for (const [identity, data] of selfMaps.byIdentity) {
    if (MutableHashMap.has(thatMaps.byIdentity, identity)) {
      MutableHashMap.set(nodes, identity, data)
    }
  }

  for (const edge of thatImpl.edges.values()) {
    const sourceIdentity = nodeIdentityAt(thatMaps, edge.source)
    const targetIdentity = nodeIdentityAt(thatMaps, edge.target)
    if (MutableHashMap.has(nodes, sourceIdentity) && MutableHashMap.has(nodes, targetIdentity)) {
      const edgeIdentity = new EdgeIdentity(that.type, sourceIdentity, targetIdentity, getEdgeIdentity(edge.data))
      MutableHashMap.set(thatEdges, edgeIdentity, edge.data)
    }
  }

  return make(self.type)<N, E>((mutable) => {
    const indexByIdentity = addNodesByIdentity(mutable, nodes)

    for (const [identity, data] of thatEdges) {
      if (MutableHashMap.has(selfEdges, identity)) {
        addEdgeByIdentity(mutable, indexByIdentity, identity, data)
      }
    }
  })
})

/**
 * Returns `self` without edges also present in `that`.
 *
 * **Details**
 *
 * All nodes from `self` are preserved. Edges are matched by endpoint and edge
 * identities. The result has the same graph kind as `self`. Throws a
 * `GraphError` when the graph kinds do not match. `nodeIdentity` and
 * `edgeIdentity` default to the complete node and edge data.
 *
 * `G1 \ G2 = {V1, E1 \ E2}`
 *
 * **Gotchas**
 *
 * Nodes with equal identities in one input graph are coalesced. The last node
 * supplies the data, and redirected edges can collapse or become self-loops.
 * If `that` contains an edge identity, every parallel edge with that identity
 * is removed from `self`.
 *
 * **Example** (Removing shared edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const left = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A-B")
 *   Graph.addEdge(mutable, b, c, "B-C")
 * })
 *
 * const right = Graph.directed<string, string>((mutable) => {
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, b, c, "B-C")
 * })
 *
 * const result = Graph.difference(left, right)
 *
 * console.log(Graph.nodeCount(result)) // 3
 * console.log(Graph.edgeCount(result)) // 1
 * ```
 *
 * @category set operations
 * @since 4.0.0
 */
export const difference: {
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    that: Graph<N, E, T>,
    options?: IdentityOptions<N, E, NI, EI>
  ): (self: Graph<N, E, NoInfer<T>>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    self: Graph<N, E, T>,
    that: Graph<N, E, NoInfer<T>>,
    options?: IdentityOptions<N, E, NI, EI>
  ): Graph<N, E, T>
} = dual((args) => isGraph(args[0]) && isGraph(args[1]), <N, E, T extends Kind, NI, EI>(
  self: Graph<N, E, T>,
  that: Graph<N, E, T>,
  options?: IdentityOptions<N, E, NI, EI>
): Graph<N, E, T> => {
  assertSameKind(self, that)
  const selfImpl = graphImpl(self)
  const getNodeIdentity = options?.nodeIdentity ?? ((node: N) => node as unknown as NI)
  const getEdgeIdentity = options?.edgeIdentity ?? ((edge: E) => edge as unknown as EI)
  const selfMaps = buildNodeMaps(self, getNodeIdentity)
  const thatMaps = buildNodeMaps(that, getNodeIdentity)
  const thatEdges = buildEdgeMap(that, thatMaps, getEdgeIdentity)

  return make(self.type)<N, E>((mutable) => {
    const indexByIdentity = addNodesByIdentity(mutable, selfMaps.byIdentity)

    for (const edge of selfImpl.edges.values()) {
      const sourceIdentity = nodeIdentityAt(selfMaps, edge.source)
      const targetIdentity = nodeIdentityAt(selfMaps, edge.target)
      const edgeIdentity = new EdgeIdentity(self.type, sourceIdentity, targetIdentity, getEdgeIdentity(edge.data))
      if (!MutableHashMap.has(thatEdges, edgeIdentity)) {
        addEdgeByIdentity(mutable, indexByIdentity, edgeIdentity, edge.data)
      }
    }
  })
})

/**
 * Returns edges present in exactly one of two graphs.
 *
 * **Details**
 *
 * Keeps nodes from both graphs. Overlapping nodes use data from `that`. The
 * result has the same graph kind as `self`. Throws a `GraphError` when the
 * graph kinds do not match. `nodeIdentity` and `edgeIdentity` default to the
 * complete node and edge data. Edge identity also includes the endpoint
 * identities.
 *
 * `G1 Δ G2 = {V1 ∪ V2, (E1 ∪ E2) \ (E1 ∩ E2)}`
 *
 * **Gotchas**
 *
 * Edges with different projected identities are distinct.
 * Nodes with equal identities in one input graph are coalesced. The last node
 * supplies the data, and redirected edges can collapse or become self-loops.
 * Parallel edges with equal identities are coalesced before the graphs are
 * compared.
 *
 * **Example** (Finding differing edges)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const left = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A-B")
 *   Graph.addEdge(mutable, b, c, "B-C")
 * })
 *
 * const right = Graph.directed<string, string>((mutable) => {
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   const d = Graph.addNode(mutable, "D")
 *   Graph.addEdge(mutable, b, c, "B-C")
 *   Graph.addEdge(mutable, c, d, "C-D")
 * })
 *
 * const result = Graph.symmetricDifference(left, right)
 *
 * console.log(Graph.nodeCount(result)) // 4
 * console.log(Graph.edgeCount(result)) // 2
 * ```
 *
 * @category set operations
 * @since 4.0.0
 */
export const symmetricDifference: {
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    that: Graph<N, E, T>,
    options?: IdentityOptions<N, E, NI, EI>
  ): (self: Graph<N, E, NoInfer<T>>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed", NI = N, EI = E>(
    self: Graph<N, E, T>,
    that: Graph<N, E, NoInfer<T>>,
    options?: IdentityOptions<N, E, NI, EI>
  ): Graph<N, E, T>
} = dual((args) => isGraph(args[0]) && isGraph(args[1]), <N, E, T extends Kind, NI, EI>(
  self: Graph<N, E, T>,
  that: Graph<N, E, T>,
  options?: IdentityOptions<N, E, NI, EI>
): Graph<N, E, T> => {
  assertSameKind(self, that)
  const getNodeIdentity = options?.nodeIdentity ?? ((node: N) => node as unknown as NI)
  const getEdgeIdentity = options?.edgeIdentity ?? ((edge: E) => edge as unknown as EI)
  const selfMaps = buildNodeMaps(self, getNodeIdentity)
  const thatMaps = buildNodeMaps(that, getNodeIdentity)
  const nodes = MutableHashMap.empty<NI, N>()
  const selfEdges = buildEdgeMap(self, selfMaps, getEdgeIdentity)
  const thatEdges = buildEdgeMap(that, thatMaps, getEdgeIdentity)

  for (const [identity, data] of selfMaps.byIdentity) {
    MutableHashMap.set(nodes, identity, data)
  }

  for (const [identity, data] of thatMaps.byIdentity) {
    MutableHashMap.set(nodes, identity, data)
  }

  return make(self.type)<N, E>((mutable) => {
    const indexByIdentity = addNodesByIdentity(mutable, nodes)

    for (const [identity, data] of selfEdges) {
      if (!MutableHashMap.has(thatEdges, identity)) {
        addEdgeByIdentity(mutable, indexByIdentity, identity, data)
      }
    }

    for (const [identity, data] of thatEdges) {
      if (!MutableHashMap.has(selfEdges, identity)) {
        addEdgeByIdentity(mutable, indexByIdentity, identity, data)
      }
    }
  })
})

/**
 * Returns the complement over the existing node set.
 *
 * **Details**
 *
 * Adds every missing edge between distinct nodes. The `createEdge` function
 * receives the source and target node data for each added edge. The result has
 * the same graph kind as `self`.
 *
 * `G' = {V, (V x V) \ E}`
 *
 * **Example** (Finding missing relationships)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   Graph.addEdge(mutable, a, b, "A-B")
 * })
 *
 * const result = Graph.complement(graph, (source, target) => `${source}-${target}`)
 *
 * console.log(Graph.edgeCount(result)) // 1
 * ```
 *
 * @category set operations
 * @since 4.0.0
 */
export const complement: {
  <N, E>(
    createEdge: (source: N, target: N) => E
  ): <T extends Kind = "directed">(self: Graph<N, E, T>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed">(
    self: Graph<N, E, T>,
    createEdge: (source: N, target: N) => E
  ): Graph<N, E, T>
} = dual(2, <N, E, T extends Kind>(
  self: Graph<N, E, T>,
  createEdge: (source: N, target: N) => E
): Graph<N, E, T> => {
  const selfImpl = graphImpl(self)
  const nodeEntries = Array.from(selfImpl.nodes)

  return make(self.type)<N, E>((mutable) => {
    const newIndexMap = new Map<NodeIndex, NodeIndex>()

    for (const [oldIndex, data] of nodeEntries) {
      newIndexMap.set(oldIndex, addNode(mutable, data))
    }

    for (let i = 0; i < nodeEntries.length; i++) {
      const [sourceOldIndex, sourceData] = nodeEntries[i]
      const start = self.type === "undirected" ? i + 1 : 0

      for (let j = start; j < nodeEntries.length; j++) {
        const [targetOldIndex, targetData] = nodeEntries[j]
        if (sourceOldIndex === targetOldIndex || hasEdge(self, sourceOldIndex, targetOldIndex)) {
          continue
        }

        const sourceIndex = newIndexMap.get(sourceOldIndex)
        const targetIndex = newIndexMap.get(targetOldIndex)
        if (sourceIndex !== undefined && targetIndex !== undefined) {
          addEdge(mutable, sourceIndex, targetIndex, createEdge(sourceData, targetData))
        }
      }
    }
  })
})

/**
 * Configuration for selecting a graph neighborhood.
 *
 * **Details**
 *
 * `radius` limits the edge distance from the center node and defaults to `1`.
 * `direction` controls how directed edges are traversed and defaults to
 * `"outgoing"`.
 *
 * @category models
 * @since 4.0.0
 */
export interface NeighborhoodConfig {
  readonly radius?: number
  readonly direction?: TraversalDirection
}

/**
 * Returns the induced subgraph containing nodes within a radius of a node.
 *
 * **Details**
 *
 * The `radius` option is the maximum edge distance from `nodeIndex` and
 * defaults to `1`. The `direction` option controls directed graph traversal and
 * defaults to `"outgoing"`. The result has the same graph kind as `self` and
 * keeps all original edges whose endpoints are both reached. `"undirected"`
 * ignores edge direction while finding reachable nodes.
 *
 * **Example** (Getting a local neighborhood)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A-B")
 *   Graph.addEdge(mutable, b, c, "B-C")
 * })
 *
 * const result = Graph.neighborhood(graph, 1, { radius: 1 })
 *
 * console.log(Graph.nodeCount(result)) // 2
 * ```
 *
 * @category set operations
 * @since 4.0.0
 */
export const neighborhood: {
  (
    nodeIndex: NodeIndex,
    options?: NeighborhoodConfig
  ): <N, E, T extends Kind = "directed">(self: Graph<N, E, T>) => Graph<N, E, T>
  <N, E, T extends Kind = "directed">(
    self: Graph<N, E, T>,
    nodeIndex: NodeIndex,
    options?: NeighborhoodConfig
  ): Graph<N, E, T>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind>(
  self: Graph<N, E, T>,
  nodeIndex: NodeIndex,
  options?: NeighborhoodConfig
): Graph<N, E, T> => {
  const selfImpl = graphImpl(self)
  const radius = options?.radius ?? 1
  const direction = options?.direction ?? "outgoing"
  const reached = new Set<NodeIndex>()

  for (const index of indices(bfs(self, { start: [nodeIndex], direction, radius }))) {
    reached.add(index)
  }

  return make(self.type)<N, E>((mutable) => {
    const newIndexMap = new Map<NodeIndex, NodeIndex>()

    for (const oldIndex of reached) {
      newIndexMap.set(oldIndex, addNode(mutable, Option.getOrThrow(getNode(self, oldIndex))))
    }

    for (const edge of selfImpl.edges.values()) {
      if (reached.has(edge.source) && reached.has(edge.target)) {
        const sourceIndex = newIndexMap.get(edge.source)
        const targetIndex = newIndexMap.get(edge.target)
        if (sourceIndex !== undefined && targetIndex !== undefined) {
          addEdge(mutable, sourceIndex, targetIndex, edge.data)
        }
      }
    }
  })
})

/**
 * Returns the disjoint union of two graphs.
 *
 * **Details**
 *
 * Copies all nodes and edges from both graphs without merging equal node data.
 * The result has the same graph kind as `self`. Throws a `GraphError` when the
 * graph kinds do not match.
 *
 * `G1 + G2 = {disjoint V1 + V2, disjoint E1 + E2}`
 *
 * @category set operations
 * @since 4.0.0
 */
export const sum: {
  <N, E, T extends Kind>(that: Graph<N, E, T>): (self: Graph<N, E, NoInfer<T>>) => Graph<N, E, T>
  <N, E, T extends Kind>(self: Graph<N, E, T>, that: Graph<N, E, NoInfer<T>>): Graph<N, E, T>
} = dual(2, <N, E, T extends Kind>(self: Graph<N, E, T>, that: Graph<N, E, T>): Graph<N, E, T> => {
  assertSameKind(self, that)
  return make(self.type)<N, E>((mutable) => {
    const copyInto = (graph: Graph<N, E, T>) => {
      const impl = graphImpl(graph)
      const indexMap = new Map<NodeIndex, NodeIndex>()

      for (const [oldIndex, data] of impl.nodes) {
        indexMap.set(oldIndex, addNode(mutable, data))
      }

      for (const edge of impl.edges.values()) {
        const sourceIndex = indexMap.get(edge.source)
        const targetIndex = indexMap.get(edge.target)
        if (sourceIndex !== undefined && targetIndex !== undefined) {
          addEdge(mutable, sourceIndex, targetIndex, edge.data)
        }
      }
    }

    copyInto(self)
    copyInto(that)
  })
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  const nodeIndex = impl.nextNodeIndex

  // Add node data
  impl.nodes.set(nodeIndex, data)

  // Initialize empty adjacency lists
  impl.adjacency.set(nodeIndex, [])
  impl.reverseAdjacency.set(nodeIndex, [])

  // Update graph allocators
  impl.nextNodeIndex = impl.nextNodeIndex + 1

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
  (nodeIndex: NodeIndex): <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>
  ) => Option.Option<N>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    nodeIndex: NodeIndex
  ): Option.Option<N>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): Option.Option<N> => {
  const impl = graphImpl(graph)
  return impl.nodes.has(nodeIndex) ? Option.some(impl.nodes.get(nodeIndex)!) : Option.none()
})

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
): boolean => graphImpl(graph).nodes.has(nodeIndex))

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
): number => graphImpl(graph).nodes.size

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
  const impl = graphImpl(graph)
  for (const [index, data] of impl.nodes) {
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
  const impl = graphImpl(graph)
  const results: Array<NodeIndex> = []
  for (const [index, data] of impl.nodes) {
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
  const impl = graphImpl(graph)
  for (const [edgeIndex, edgeData] of impl.edges) {
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
  const impl = graphImpl(graph)
  const results: Array<EdgeIndex> = []
  for (const [edgeIndex, edgeData] of impl.edges) {
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  if (!impl.nodes.has(index)) {
    return
  }

  const currentData = impl.nodes.get(index)!
  const newData = f(currentData)
  impl.nodes.set(index, newData)
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  if (!impl.edges.has(edgeIndex)) {
    return
  }

  const currentEdge = impl.edges.get(edgeIndex)!
  const newData = f(currentEdge.data)
  impl.edges.set(edgeIndex, new Edge({ ...currentEdge, data: newData }))
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  // Transform existing node data in place
  for (const [index, data] of impl.nodes) {
    const newData = f(data)
    impl.nodes.set(index, newData)
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  // Transform existing edge data in place
  for (const [index, edgeData] of impl.edges) {
    const newData = f(edgeData.data)
    impl.edges.set(
      index,
      new Edge({
        ...edgeData,
        data: newData
      })
    )
  }
}

/**
 * @internal
 */
const rebuildAdjacency = <N, E, T extends Kind = "directed">(
  mutable: GraphImpl<N, E, T>
): void => {
  mutable.adjacency.clear()
  mutable.reverseAdjacency.clear()

  for (const nodeIndex of mutable.nodes.keys()) {
    mutable.adjacency.set(nodeIndex, [])
    mutable.reverseAdjacency.set(nodeIndex, [])
  }

  for (const [edgeIndex, edgeData] of mutable.edges) {
    mutable.adjacency.get(edgeData.source)!.push(edgeIndex)
    mutable.reverseAdjacency.get(edgeData.target)!.push(edgeIndex)

    if (mutable.type === "undirected") {
      mutable.adjacency.get(edgeData.target)!.push(edgeIndex)
      mutable.reverseAdjacency.get(edgeData.source)!.push(edgeIndex)
    }
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  if (impl.type === "undirected") {
    return
  }

  // Reverse all edges by swapping source and target
  for (const [index, edgeData] of impl.edges) {
    impl.edges.set(
      index,
      new Edge({
        source: edgeData.target,
        target: edgeData.source,
        data: edgeData.data
      })
    )
  }

  rebuildAdjacency(impl)

  // Invalidate cycle flag since edge directions changed
  impl.acyclic = Option.none()
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  const nodesToRemove: Array<NodeIndex> = []

  // First pass: identify nodes to remove and transform data for nodes to keep
  for (const [index, data] of impl.nodes) {
    const result = f(data)
    if (Option.isSome(result)) {
      // Transform node data
      impl.nodes.set(index, result.value)
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  const edgesToRemove: Array<EdgeIndex> = []

  // First pass: identify edges to remove and transform data for edges to keep
  for (const [index, edgeData] of impl.edges) {
    const result = f(edgeData.data)
    if (Option.isSome(result)) {
      // Transform edge data
      impl.edges.set(
        index,
        new Edge({
          ...edgeData,
          data: result.value
        })
      )
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  const nodesToRemove: Array<NodeIndex> = []

  // Identify nodes to remove
  for (const [index, data] of impl.nodes) {
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  const edgesToRemove: Array<EdgeIndex> = []

  // Identify edges to remove
  for (const [index, edgeData] of impl.edges) {
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
  mutable: GraphImpl<N, E, T>
): void => {
  // Only invalidate if the graph had cycles (removing edges/nodes cannot introduce cycles in acyclic graphs).
  if (mutable.acyclic._tag === "Some" && mutable.acyclic.value === false) {
    mutable.acyclic = Option.none()
  }
}

/** @internal */
const invalidateCycleFlagOnAddition = <N, E, T extends Kind = "directed">(
  mutable: GraphImpl<N, E, T>
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  // Validate that both nodes exist
  if (!impl.nodes.has(source)) {
    throw missingNode(source)
  }
  if (!impl.nodes.has(target)) {
    throw missingNode(target)
  }

  const edgeIndex = impl.nextEdgeIndex

  // Create edge data
  const edgeData = new Edge({ source, target, data })
  impl.edges.set(edgeIndex, edgeData)

  // Update adjacency lists
  const sourceAdjacency = impl.adjacency.get(source)
  if (sourceAdjacency !== undefined) {
    sourceAdjacency.push(edgeIndex)
  }

  const targetReverseAdjacency = impl.reverseAdjacency.get(target)
  if (targetReverseAdjacency !== undefined) {
    targetReverseAdjacency.push(edgeIndex)
  }

  // For undirected graphs, add reverse connections
  if (impl.type === "undirected") {
    const targetAdjacency = impl.adjacency.get(target)
    if (targetAdjacency !== undefined) {
      targetAdjacency.push(edgeIndex)
    }

    const sourceReverseAdjacency = impl.reverseAdjacency.get(source)
    if (sourceReverseAdjacency !== undefined) {
      sourceReverseAdjacency.push(edgeIndex)
    }
  }

  // Update allocators
  impl.nextEdgeIndex = impl.nextEdgeIndex + 1

  // Only invalidate cycle flag if the graph was acyclic
  // Adding edges cannot remove cycles from cyclic graphs
  invalidateCycleFlagOnAddition(impl)

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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  // Check if node exists
  if (!impl.nodes.has(nodeIndex)) {
    return // Node doesn't exist, nothing to remove
  }

  // Collect all incident edges for removal
  const edgesToRemove: Array<EdgeIndex> = []

  // Get outgoing edges
  const outgoingEdges = impl.adjacency.get(nodeIndex)
  if (outgoingEdges !== undefined) {
    for (const edge of outgoingEdges) {
      edgesToRemove.push(edge)
    }
  }

  // Get incoming edges
  const incomingEdges = impl.reverseAdjacency.get(nodeIndex)
  if (incomingEdges !== undefined) {
    for (const edge of incomingEdges) {
      edgesToRemove.push(edge)
    }
  }

  // Remove all incident edges
  for (const edgeIndex of edgesToRemove) {
    removeEdgeInternal(impl, edgeIndex)
  }

  // Remove the node itself
  impl.nodes.delete(nodeIndex)
  impl.adjacency.delete(nodeIndex)
  impl.reverseAdjacency.delete(nodeIndex)

  // Only invalidate cycle flag if the graph wasn't already known to be acyclic
  // Removing nodes cannot introduce cycles in an acyclic graph
  invalidateCycleFlagOnRemoval(impl)
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
  assertMutable(mutable)
  const impl = graphImpl(mutable)

  const wasRemoved = removeEdgeInternal(impl, edgeIndex)

  // Only invalidate cycle flag if an edge was actually removed
  // and only if the graph wasn't already known to be acyclic
  if (wasRemoved) {
    invalidateCycleFlagOnRemoval(impl)
  }
}

/** @internal */
const removeEdgeInternal = <N, E, T extends Kind = "directed">(
  mutable: GraphImpl<N, E, T>,
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
  (edgeIndex: EdgeIndex): <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>
  ) => Option.Option<Edge<E>>
  <N, E, T extends Kind = "directed">(
    graph: Graph<N, E, T> | MutableGraph<N, E, T>,
    edgeIndex: EdgeIndex
  ): Option.Option<Edge<E>>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  edgeIndex: EdgeIndex
): Option.Option<Edge<E>> => Option.fromUndefinedOr(graphImpl(graph).edges.get(edgeIndex)))

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
  const impl = graphImpl(graph)
  const adjacencyList = impl.adjacency.get(source)
  if (adjacencyList === undefined) {
    return false
  }

  // Check if any edge in the adjacency list connects to the target
  for (const edgeIndex of adjacencyList) {
    const edge = impl.edges.get(edgeIndex)
    if (edge !== undefined) {
      const neighbor = graph.type === "undirected" && edge.target === source ? edge.source : edge.target
      if (neighbor === target) {
        return true
      }
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
): number => graphImpl(graph).edges.size

const getDirectedNeighbors = <N, E>(
  graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
  nodeIndex: NodeIndex,
  direction: Direction
): Array<NodeIndex> => {
  const impl = graphImpl(graph)
  const adjacencyMap = direction === "incoming"
    ? impl.reverseAdjacency
    : impl.adjacency

  const adjacencyList = adjacencyMap.get(nodeIndex)
  if (adjacencyList === undefined) {
    return []
  }

  const result: Array<NodeIndex> = []
  for (const edgeIndex of adjacencyList) {
    const edge = impl.edges.get(edgeIndex)
    if (edge !== undefined) {
      result.push(direction === "incoming" ? edge.source : edge.target)
    }
  }

  return result
}

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

  return getDirectedNeighbors(graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">, nodeIndex, "outgoing")
})

/**
 * Returns the outgoing neighbor node indices for a node in a directed graph.
 *
 * **When to use**
 *
 * Use when you need the nodes reached by following outgoing edges from a node in
 * a directed graph.
 *
 * **Gotchas**
 *
 * Throws a `GraphError` when used with an undirected graph.
 *
 * @see {@link predecessors} for incoming neighbors in a directed graph
 * @see {@link neighbors} for generic neighbor lookup across graph kinds
 *
 * @category queries
 * @since 4.0.0
 */
export const successors: {
  (
    nodeIndex: NodeIndex
  ): <N, E>(graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">) => Array<NodeIndex>
  <N, E>(
    graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
    nodeIndex: NodeIndex
  ): Array<NodeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): Array<NodeIndex> => {
  if (graph.type === "undirected") {
    throw new GraphError({ message: "Cannot get successors of undirected graph" })
  }
  return getDirectedNeighbors(graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">, nodeIndex, "outgoing")
})

/**
 * Returns the incoming neighbor node indices for a node in a directed graph.
 *
 * **When to use**
 *
 * Use when you need the nodes that reach a node by following incoming edges in a
 * directed graph.
 *
 * **Gotchas**
 *
 * Throws a `GraphError` when used with an undirected graph.
 *
 * @see {@link successors} for outgoing neighbors in a directed graph
 * @see {@link neighbors} for generic neighbor lookup across graph kinds
 *
 * @category queries
 * @since 4.0.0
 */
export const predecessors: {
  (
    nodeIndex: NodeIndex
  ): <N, E>(graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">) => Array<NodeIndex>
  <N, E>(
    graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
    nodeIndex: NodeIndex
  ): Array<NodeIndex>
} = dual(2, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex
): Array<NodeIndex> => {
  if (graph.type === "undirected") {
    throw new GraphError({ message: "Cannot get predecessors of undirected graph" })
  }
  return getDirectedNeighbors(graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">, nodeIndex, "incoming")
})

/**
 * Gets directed neighbors of a node in a specific direction.
 *
 * **When to use**
 *
 * Use when maintaining existing code that already passes an explicit traversal
 * direction. New code should prefer `successors` or `predecessors`.
 *
 * **Gotchas**
 *
 * Throws a `GraphError` when used with an undirected graph.
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
 * @deprecated Use {@link successors} for outgoing neighbors or {@link predecessors} for incoming neighbors.
 * @see {@link successors} for outgoing neighbors in a directed graph
 * @see {@link predecessors} for incoming neighbors in a directed graph
 * @category queries
 * @since 3.18.0
 */
export const neighborsDirected: {
  (
    nodeIndex: NodeIndex,
    direction: Direction
  ): <N, E>(graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">) => Array<NodeIndex>
  <N, E>(
    graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
    nodeIndex: NodeIndex,
    direction: Direction
  ): Array<NodeIndex>
} = dual(3, <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex,
  direction: Direction
): Array<NodeIndex> => {
  if (graph.type === "undirected") {
    throw new GraphError({ message: "Cannot get directed neighbors of undirected graph" })
  }
  return getDirectedNeighbors(graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">, nodeIndex, direction)
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
 * @category options
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

const escapeGraphVizString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r\n|\r|\n/g, "\\n")

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
 * // digraph "G" {
 * //   "0" [label="Node A"];
 * //   "1" [label="Node B"];
 * //   "2" [label="Node C"];
 * //   "0" -> "1" [label="1"];
 * //   "1" -> "2" [label="2"];
 * //   "2" -> "0" [label="3"];
 * // }
 * ```
 *
 * @category converting
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
  const impl = graphImpl(graph)
  const {
    edgeLabel = (data: E) => String(data),
    graphName = "G",
    nodeLabel = (data: N) => String(data)
  } = options ?? {}

  const isDirected = graph.type === "directed"
  const graphType = isDirected ? "digraph" : "graph"
  const edgeOperator = isDirected ? "->" : "--"
  const graphId = `"${escapeGraphVizString(graphName)}"`

  const lines: Array<string> = []
  lines.push(`${graphType} ${graphId} {`)

  // Add nodes
  for (const [nodeIndex, nodeData] of impl.nodes) {
    const label = escapeGraphVizString(nodeLabel(nodeData))
    lines.push(`  "${nodeIndex}" [label="${label}"];`)
  }

  // Add edges
  for (const [, edgeData] of impl.edges) {
    const label = escapeGraphVizString(edgeLabel(edgeData.data))
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
 * @category options
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
 *   } satisfies Dependency)
 *   const react = Graph.addNode(mutable, {
 *     name: "React",
 *     version: "18.0.0",
 *     type: "framework"
 *   } satisfies Dependency)
 *   const lodash = Graph.addNode(mutable, {
 *     name: "Lodash",
 *     version: "4.17.0",
 *     type: "library"
 *   } satisfies Dependency)
 *   const webpack = Graph.addNode(mutable, {
 *     name: "Webpack",
 *     version: "5.0.0",
 *     type: "tool"
 *   } satisfies Dependency)
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
 * @category converting
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
  const impl = graphImpl(graph)
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
  for (const [nodeIndex, nodeData] of impl.nodes) {
    const nodeId = String(nodeIndex)
    const label = escapeMermaidLabel(nodeLabel(nodeData))
    const shape = nodeShape(nodeData)
    const formattedNode = formatMermaidNode(nodeId, label, shape)
    lines.push(`  ${formattedNode}`)
  }

  // Add edges
  const edgeOperator = finalDiagramType === "flowchart" ? "-->" : "---"
  for (const [, edgeData] of impl.edges) {
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
// Edge Direction Types
// =============================================================================

/**
 * Direction of directed edges relative to a node.
 *
 * **Details**
 *
 * `"outgoing"` selects edges whose source is the node, while `"incoming"`
 * selects edges whose target is the node.
 *
 * @category models
 * @since 3.18.0
 */
export type Direction = "outgoing" | "incoming"

/**
 * Controls how traversal follows directed edges.
 *
 * **Details**
 *
 * `"outgoing"` follows edges from source to target, `"incoming"` follows them
 * from target to source, and `"undirected"` allows traversal in either
 * direction.
 *
 * **Example** (Traversing by direction)
 *
 * ```ts
 * import { Graph } from "effect"
 *
 * const graph = Graph.directed<string, string>((mutable) => {
 *   const a = Graph.addNode(mutable, "A")
 *   const b = Graph.addNode(mutable, "B")
 *   const c = Graph.addNode(mutable, "C")
 *   Graph.addEdge(mutable, a, b, "A-B")
 *   Graph.addEdge(mutable, a, c, "A-C")
 * })
 *
 * const outgoing = Array.from(
 *   Graph.indices(Graph.bfs(graph, { start: [0], direction: "outgoing" }))
 * ) // [0, 1, 2]
 *
 * const incoming = Array.from(
 *   Graph.indices(Graph.bfs(graph, { start: [1], direction: "incoming" }))
 * ) // [1, 0]
 *
 * const undirected = Array.from(
 *   Graph.indices(Graph.bfs(graph, { start: [1], direction: "undirected" }))
 * ) // [1, 0, 2]
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export type TraversalDirection = Direction | "undirected"

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
 * a back edge that doesn't use the same edge used to enter the current node
 * creates a cycle.
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
  const impl = graphImpl(graph)
  // Use existing cycle flag if available
  if (Option.isSome(impl.acyclic)) {
    return impl.acyclic.value
  }

  if (graph.type === "undirected") {
    const visited = new Set<NodeIndex>()

    for (const startNode of impl.nodes.keys()) {
      if (visited.has(startNode)) {
        continue
      }

      visited.add(startNode)
      const stack: Array<{ node: NodeIndex; incoming: EdgeIndex | null }> = [{ node: startNode, incoming: null }]

      while (stack.length > 0) {
        const { node, incoming } = stack.pop()!
        const adjacencyList = impl.adjacency.get(node)
        if (adjacencyList === undefined) {
          continue
        }

        for (const edgeIndex of adjacencyList) {
          if (edgeIndex === incoming) {
            continue
          }
          const edge = impl.edges.get(edgeIndex)
          if (edge === undefined) {
            continue
          }
          const neighbor = getTraversableNeighbor(graph, node, edge)
          if (!visited.has(neighbor)) {
            visited.add(neighbor)
            stack.push({ node: neighbor, incoming: edgeIndex })
          } else {
            impl.acyclic = Option.some(false)
            return false
          }
        }
      }
    }

    impl.acyclic = Option.some(true)
    return true
  }

  // Stack-safe DFS cycle detection using iterative approach
  const visited = new Set<NodeIndex>()
  const recursionStack = new Set<NodeIndex>()

  // Stack entry: [node, neighbors, neighborIndex, isFirstVisit]
  type DfsStackEntry = [NodeIndex, Array<NodeIndex>, number, boolean]

  // Get all nodes to handle disconnected components
  for (const startNode of impl.nodes.keys()) {
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
          impl.acyclic = Option.some(false)
          return false
        }

        if (visited.has(node)) {
          stack.pop()
          continue
        }

        visited.add(node)
        recursionStack.add(node)

        // Get neighbors for this node
        const nodeNeighbors = getDirectedNeighbors(
          graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
          node,
          "outgoing"
        )
        stack[stack.length - 1] = [node, nodeNeighbors, 0, false]
        continue
      }

      // Process next neighbor
      if (neighborIndex < neighbors.length) {
        const neighbor = neighbors[neighborIndex]
        stack[stack.length - 1] = [node, neighbors, neighborIndex + 1, false]

        if (recursionStack.has(neighbor)) {
          // Back edge found - cycle detected
          impl.acyclic = Option.some(false)
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
  impl.acyclic = Option.some(true)
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
  const impl = graphImpl(graph)
  const coloring = new Map<NodeIndex, 0 | 1>()
  const discovered = new Set<NodeIndex>()
  let isBipartiteGraph = true

  // Get all nodes to handle disconnected components
  for (const startNode of impl.nodes.keys()) {
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
  const impl = graphImpl(graph)
  const neighbors = new Set<NodeIndex>()

  // Check edges where this node is the source
  const adjacencyList = impl.adjacency.get(nodeIndex)
  if (adjacencyList !== undefined) {
    for (const edgeIndex of adjacencyList) {
      const edge = impl.edges.get(edgeIndex)
      if (edge !== undefined) {
        // For undirected graphs, the neighbor is the other endpoint
        const otherNode = edge.source === nodeIndex ? edge.target : edge.source
        neighbors.add(otherNode)
      }
    }
  }

  return Array.from(neighbors)
}

const getTraversalNeighbors = <N, E, T extends Kind>(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  nodeIndex: NodeIndex,
  direction: TraversalDirection
): Array<NodeIndex> => {
  if (graph.type === "undirected") {
    return getUndirectedNeighbors(graph as any, nodeIndex)
  }
  const directed = graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">
  if (direction !== "undirected") {
    return getDirectedNeighbors(directed, nodeIndex, direction)
  }
  const neighbors = new Set(getDirectedNeighbors(directed, nodeIndex, "outgoing"))
  for (const neighbor of getDirectedNeighbors(directed, nodeIndex, "incoming")) {
    neighbors.add(neighbor)
  }
  return Array.from(neighbors)
}

const getTraversableNeighbor = <N, E, T extends Kind>(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  current: NodeIndex,
  edge: Edge<E>
): NodeIndex => graph.type === "undirected" && edge.target === current ? edge.source : edge.target

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
  const impl = graphImpl(graph)
  const visited = new Set<NodeIndex>()
  const components: Array<Array<NodeIndex>> = []
  for (const startNode of impl.nodes.keys()) {
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
 * **Gotchas**
 *
 * Throws a `GraphError` when used with an undirected graph.
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
export const stronglyConnectedComponents = <N, E>(
  graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">
): Array<Array<NodeIndex>> => {
  if ((graph as Graph<N, E, Kind> | MutableGraph<N, E, Kind>).type === "undirected") {
    throw new GraphError({ message: "Cannot find strongly connected components of undirected graph" })
  }

  const impl = graphImpl(graph)
  const visited = new Set<NodeIndex>()
  const finishOrder: Array<NodeIndex> = []
  // Iterate directly over node keys

  // Step 1: Stack-safe DFS on original graph to get finish times
  // Stack entry: [node, neighbors, neighborIndex, isFirstVisit]
  type DfsStackEntry = [NodeIndex, Array<NodeIndex>, number, boolean]

  for (const startNode of impl.nodes.keys()) {
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
        const nodeNeighborsList = getDirectedNeighbors(graph, node, "outgoing")
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
      const reverseAdjacency = impl.reverseAdjacency.get(node)
      if (reverseAdjacency !== undefined) {
        for (const edgeIndex of reverseAdjacency) {
          const edge = impl.edges.get(edgeIndex)
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

interface MinHeapEntry {
  readonly node: NodeIndex
  readonly priority: number
  readonly sequence: number
}

const minHeapLessThan = (self: MinHeapEntry, that: MinHeapEntry): boolean =>
  self.priority < that.priority || (self.priority === that.priority && self.sequence < that.sequence)

const minHeapPush = (heap: Array<MinHeapEntry>, entry: MinHeapEntry): void => {
  let index = heap.length
  heap.push(entry)
  while (index > 0) {
    const parent = (index - 1) >>> 1
    if (!minHeapLessThan(entry, heap[parent])) {
      break
    }
    heap[index] = heap[parent]
    index = parent
  }
  heap[index] = entry
}

const minHeapPop = (heap: Array<MinHeapEntry>): MinHeapEntry | undefined => {
  const first = heap[0]
  const last = heap.pop()
  if (last === undefined || heap.length === 0) {
    return first
  }
  let index = 0
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) {
      break
    }
    const right = left + 1
    const child = right < heap.length && minHeapLessThan(heap[right], heap[left]) ? right : left
    if (!minHeapLessThan(heap[child], last)) {
      break
    }
    heap[index] = heap[child]
    index = child
  }
  heap[index] = last
  return first
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
 * each edge's data to a non-negative numeric weight. `Infinity` is allowed and
 * behaves like an impassable edge.
 *
 * **Gotchas**
 *
 * `dijkstra` throws a `GraphError` when either endpoint does not exist or when
 * the cost function returns a negative weight or `NaN`.
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
 * Edge costs must be non-negative and not `NaN`. `Infinity` is allowed and
 * behaves like an impassable edge. Returns `Option.none()` when the target is
 * not reachable, and throws a `GraphError` when either endpoint is missing or an
 * edge cost is negative or `NaN`.
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
  const impl = graphImpl(graph)
  // Validate that source and target nodes exist
  if (!impl.nodes.has(config.source)) {
    throw missingNode(config.source)
  }
  if (!impl.nodes.has(config.target)) {
    throw missingNode(config.target)
  }

  const edgeWeights = new Map<EdgeIndex, number>()
  for (const [edgeIndex, edgeData] of impl.edges) {
    const weight = config.cost(edgeData.data)
    if (Number.isNaN(weight) || weight < 0) {
      throw new GraphError({ message: "Dijkstra's algorithm requires non-negative edge weights" })
    }
    edgeWeights.set(edgeIndex, weight)
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
  for (const node of impl.nodes.keys()) {
    distances.set(node, node === config.source ? 0 : Infinity)
    previous.set(node, null)
  }

  const priorityQueue: Array<MinHeapEntry> = []
  let sequence = 0
  minHeapPush(priorityQueue, { node: config.source, priority: 0, sequence: sequence++ })

  while (priorityQueue.length > 0) {
    const current = minHeapPop(priorityQueue)!
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
    const adjacencyList = impl.adjacency.get(currentNode)
    if (adjacencyList !== undefined) {
      for (const edgeIndex of adjacencyList) {
        const edge = impl.edges.get(edgeIndex)
        if (edge !== undefined) {
          const neighbor = getTraversableNeighbor(graph, currentNode, edge)
          const cost = edgeWeights.get(edgeIndex)!

          const newDistance = currentDistance + cost
          const neighborDistance = distances.get(neighbor)!

          // Relaxation step
          if (newDistance < neighborDistance) {
            distances.set(neighbor, newDistance)
            previous.set(neighbor, { node: currentNode, edgeData: edge.data })

            // Add to priority queue if not visited
            if (!visited.has(neighbor)) {
              minHeapPush(priorityQueue, { node: neighbor, priority: newDistance, sequence: sequence++ })
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
 * source and target pair in O(V^3) time. Negative edge weights are allowed, and
 * `Infinity` behaves like an impassable edge. A `GraphError` is thrown if any
 * edge weight is `NaN` or `-Infinity`, or if any negative cycle is detected.
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
  const impl = graphImpl(graph)
  // Get all nodes for Floyd-Warshall algorithm (needs array for nested iteration)
  const allNodes = Array.from(impl.nodes.keys())

  // Initialize distance matrix
  const distances = new Map<NodeIndex, Map<NodeIndex, number>>()
  const next = new Map<NodeIndex, Map<NodeIndex, NodeIndex>>()
  const edgeMatrix = new Map<NodeIndex, Map<NodeIndex, E>>()

  // Initialize with infinity for all pairs
  for (const i of allNodes) {
    distances.set(i, new Map())
    next.set(i, new Map())
    edgeMatrix.set(i, new Map())

    for (const j of allNodes) {
      distances.get(i)!.set(j, i === j ? 0 : Infinity)
    }
  }

  // Set edge weights
  for (const [, edgeData] of impl.edges) {
    const weight = cost(edgeData.data)
    if (Number.isNaN(weight) || weight === -Infinity) {
      throw new GraphError({ message: "Floyd-Warshall algorithm does not support NaN or -Infinity edge weights" })
    }
    const i = edgeData.source
    const j = edgeData.target

    // Use minimum weight if multiple edges exist
    const currentWeight = distances.get(i)!.get(j)!
    if (weight < currentWeight) {
      distances.get(i)!.set(j, weight)
      next.get(i)!.set(j, j)
      edgeMatrix.get(i)!.set(j, edgeData.data)
    }

    if (graph.type === "undirected") {
      const reverseWeight = distances.get(j)!.get(i)!
      if (weight < reverseWeight) {
        distances.get(j)!.set(i, weight)
        next.get(j)!.set(i, i)
        edgeMatrix.get(j)!.set(i, edgeData.data)
      }
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
          const nextIK = next.get(i)!.get(k)
          if (nextIK !== undefined) {
            distances.get(i)!.set(j, distIK + distKJ)
            next.get(i)!.set(j, nextIK)
          }
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
          const nextNode = next.get(current)!.get(j)
          if (nextNode === undefined) break

          const edgeRow = edgeMatrix.get(current)!
          if (edgeRow.has(nextNode)) {
            weights.push(edgeRow.get(nextNode) as E)
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
 * Specifies the source and target node indices, an edge-cost function that maps
 * edge data to non-negative weights, and a heuristic that estimates the
 * remaining cost from a node to the target.
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
 * The edge-cost function must return non-negative weights and not `NaN`.
 * `Infinity` is allowed and behaves like an impassable edge. The heuristic
 * should be consistent to preserve shortest-path guarantees. Returns
 * `Option.none()` when the target is not reachable, and throws a `GraphError`
 * when either endpoint is missing or an edge cost is negative or `NaN`.
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
  const impl = graphImpl(graph)
  // Validate that source and target nodes exist
  if (!impl.nodes.has(config.source)) {
    throw missingNode(config.source)
  }
  if (!impl.nodes.has(config.target)) {
    throw missingNode(config.target)
  }

  const edgeWeights = new Map<EdgeIndex, number>()
  for (const [edgeIndex, edgeData] of impl.edges) {
    const weight = config.cost(edgeData.data)
    if (Number.isNaN(weight) || weight < 0) {
      throw new GraphError({ message: "A* algorithm requires non-negative edge weights" })
    }
    edgeWeights.set(edgeIndex, weight)
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
  for (const node of impl.nodes.keys()) {
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

  const openSet: Array<MinHeapEntry> = []
  let sequence = 0
  minHeapPush(openSet, {
    node: config.source,
    priority: fScore.get(config.source)!,
    sequence: sequence++
  })

  while (openSet.length > 0) {
    const current = minHeapPop(openSet)!
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
    const adjacencyList = impl.adjacency.get(currentNode)
    if (adjacencyList !== undefined) {
      for (const edgeIndex of adjacencyList) {
        const edge = impl.edges.get(edgeIndex)
        if (edge !== undefined) {
          const neighbor = getTraversableNeighbor(graph, currentNode, edge)
          const weight = edgeWeights.get(edgeIndex)!

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
                minHeapPush(openSet, { node: neighbor, priority: f, sequence: sequence++ })
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
 * Negative edge weights are allowed, and `Infinity` behaves like an impassable
 * edge. Returns `Option.none()` when the target is unreachable or when a
 * negative cycle affects the path to the target. Throws a `GraphError` when
 * either endpoint is missing or an edge weight is `NaN` or `-Infinity`.
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
  const impl = graphImpl(graph)
  // Validate that source and target nodes exist
  if (!impl.nodes.has(config.source)) {
    throw missingNode(config.source)
  }
  if (!impl.nodes.has(config.target)) {
    throw missingNode(config.target)
  }

  // Initialize distances and predecessors
  const distances = new Map<NodeIndex, number>()
  const previous = new Map<NodeIndex, { node: NodeIndex; edgeData: E } | null>()

  // Iterate directly over node keys
  for (const node of impl.nodes.keys()) {
    distances.set(node, node === config.source ? 0 : Infinity)
    previous.set(node, null)
  }

  // Collect all edges for relaxation
  const edges: Array<{ source: NodeIndex; target: NodeIndex; weight: number; edgeData: E }> = []
  for (const [, edgeData] of impl.edges) {
    const weight = config.cost(edgeData.data)
    if (Number.isNaN(weight) || weight === -Infinity) {
      throw new GraphError({ message: "Bellman-Ford algorithm does not support NaN or -Infinity edge weights" })
    }
    edges.push({
      source: edgeData.source,
      target: edgeData.target,
      weight,
      edgeData: edgeData.data
    })
    if (graph.type === "undirected" && edgeData.source !== edgeData.target) {
      edges.push({
        source: edgeData.target,
        target: edgeData.source,
        weight,
        edgeData: edgeData.data
      })
    }
  }

  // Relax edges up to V-1 times
  const nodeCount = impl.nodes.size
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
        for (const neighbor of getTraversalNeighbors(graph, node, "outgoing")) {
          queue.push(neighbor)
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
    this[Symbol.iterator] = () => visit((index, data) => [index, data] as [T, N])[Symbol.iterator]()
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
 * @category iterators
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
 * @category iterators
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
 * @category iterators
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
 * outgoing edges, incoming edges, or ignores edge direction. `radius` limits
 * traversal by edge distance from the nearest start node.
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
  readonly direction?: TraversalDirection
  readonly radius?: number
}

/**
 * Creates a lazy depth-first traversal iterator from the configured start
 * nodes.
 *
 * **Details**
 *
 * If no start nodes are supplied, the iterator is empty. The `direction` option
 * chooses whether to follow outgoing or incoming edges. The `radius` option
 * limits traversal by edge distance from the start nodes. Throws a `GraphError`
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
  const radius = config.radius ?? Infinity

  // Validate that all start nodes exist
  for (const nodeIndex of start) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const depths = radius === Infinity ? undefined : new Map<NodeIndex, number>()
      const stack: Array<readonly [NodeIndex, number]> = []
      const yielded = new Set<NodeIndex>()

      if (depths === undefined) {
        for (const node of start) {
          stack.push([node, 0])
        }
      } else {
        const starts = new Set<NodeIndex>()
        for (let i = start.length - 1; i >= 0; i--) {
          const node = start[i]
          if (!starts.has(node)) {
            starts.add(node)
            stack.push([node, 0])
            depths.set(node, 0)
          }
        }
        stack.reverse()
      }

      const nextMapped = () => {
        while (stack.length > 0) {
          const [current, depth] = stack.pop()!

          if (depths === undefined) {
            if (yielded.has(current)) {
              continue
            }
          } else if (depths.get(current) !== depth) {
            continue
          }

          const nodeDataOption = getNode(graph, current)
          if (Option.isNone(nodeDataOption)) {
            continue
          }

          if (depth < radius) {
            const neighbors = getTraversalNeighbors(graph, current, direction)
            for (let i = neighbors.length - 1; i >= 0; i--) {
              const neighbor = neighbors[i]
              const nextDepth = depth + 1
              if (depths === undefined) {
                if (!yielded.has(neighbor)) {
                  stack.push([neighbor, nextDepth])
                }
                continue
              }
              const neighborDepth = depths.get(neighbor)
              if (neighborDepth === undefined || nextDepth < neighborDepth) {
                depths.set(neighbor, nextDepth)
                stack.push([neighbor, nextDepth])
              }
            }
          }

          if (yielded.has(current)) {
            continue
          }

          yielded.add(current)

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
 * chooses whether to follow outgoing or incoming edges. The `radius` option
 * limits traversal by edge distance from the start nodes. Throws a `GraphError`
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
  const radius = config.radius ?? Infinity

  // Validate that all start nodes exist
  for (const nodeIndex of start) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const queue: Array<readonly [NodeIndex, number]> = start.map((node) => [node, 0])
      const discovered = new Set<NodeIndex>()

      const nextMapped = () => {
        while (queue.length > 0) {
          const [current, depth] = queue.shift()!

          if (!discovered.has(current)) {
            discovered.add(current)

            if (depth < radius) {
              const neighbors = getTraversalNeighbors(graph, current, direction)
              for (const neighbor of neighbors) {
                if (!discovered.has(neighbor)) {
                  queue.push([neighbor, depth + 1])
                }
              }
            }

            const nodeData = getNode(graph, current)
            if (Option.isSome(nodeData)) {
              return { done: false, value: f(current, nodeData.value) }
            }
            continue
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
 * Use to prioritize specific zero in-degree nodes in a topological sort.
 *
 * **Details**
 *
 * `initials` optionally supplies zero in-degree node indices used as
 * prioritized initial queue entries. Topological sorting still includes the
 * other zero in-degree nodes and produces a complete topological order.
 *
 * **Gotchas**
 *
 * Throws a `GraphError` when any initial node has incoming edges.
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
  ): <N, E>(graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">) => NodeWalker<N>
  <N, E>(
    graph: Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
    config?: TopoConfig
  ): NodeWalker<N>
} = dual((args) => isGraph(args[0]), <N, E, T extends Kind = "directed">(
  graph: Graph<N, E, T> | MutableGraph<N, E, T>,
  config: TopoConfig = {}
): NodeWalker<N> => {
  if (graph.type === "undirected") {
    throw new GraphError({ message: "Cannot perform topological sort on undirected graph" })
  }

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
      const impl = graphImpl(graph)
      const inDegree = new Map<NodeIndex, number>()
      const remaining = new Set<NodeIndex>()
      const initialSet = new Set(initials)
      const queue = [...initials]

      // Initialize in-degree counts
      for (const [nodeIndex] of impl.nodes) {
        inDegree.set(nodeIndex, 0)
        remaining.add(nodeIndex)
      }

      // Calculate in-degrees
      for (const [, edgeData] of impl.edges) {
        const currentInDegree = inDegree.get(edgeData.target) || 0
        inDegree.set(edgeData.target, currentInDegree + 1)
      }

      for (const nodeIndex of initials) {
        if (inDegree.get(nodeIndex)! !== 0) {
          throw new GraphError({ message: `Initial node ${nodeIndex} has incoming edges` })
        }
      }

      // Add remaining zero in-degree nodes after prioritized initials.
      for (const [nodeIndex, degree] of inDegree) {
        if (degree === 0 && !initialSet.has(nodeIndex)) {
          queue.push(nodeIndex)
        }
      }

      const nextMapped = () => {
        while (queue.length > 0) {
          const current = queue.shift()!

          if (remaining.has(current)) {
            remaining.delete(current)

            // Process outgoing edges, reducing in-degree of targets
            const neighbors = getDirectedNeighbors(
              graph as Graph<N, E, "directed"> | MutableGraph<N, E, "directed">,
              current,
              "outgoing"
            )
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
            continue
          }
        }

        if (remaining.size > 0) {
          throw new GraphError({ message: "Cannot perform topological sort on cyclic graph" })
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
 * chooses whether to follow outgoing or incoming edges. The `radius` option
 * limits traversal by edge distance from the start nodes.
 *
 * **Gotchas**
 *
 * With a finite `radius`, iteration first performs a bounded breadth-first
 * traversal to determine shortest-distance membership before emitting nodes in
 * postorder.
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
  const radius = config.radius ?? Infinity

  // Validate that all start nodes exist
  for (const nodeIndex of start) {
    if (!hasNode(graph, nodeIndex)) {
      throw missingNode(nodeIndex)
    }
  }

  return new Walker((f) => ({
    [Symbol.iterator]: () => {
      const reached = radius === Infinity
        ? undefined
        : new Set(indices(bfs(graph, { start, direction, radius })))
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
            const neighbors = getTraversalNeighbors(graph, current.node, direction)

            for (let i = neighbors.length - 1; i >= 0; i--) {
              const neighbor = neighbors[i]
              if (
                (reached === undefined || reached.has(neighbor)) &&
                !discovered.has(neighbor) &&
                !finished.has(neighbor)
              ) {
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
              continue
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
      const nodeMap = graphImpl(graph).nodes
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
      const edgeMap = graphImpl(graph).edges
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
      const impl = graphImpl(graph)
      const nodeMap = impl.nodes
      const adjacencyMap = direction === "incoming"
        ? impl.reverseAdjacency
        : impl.adjacency

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
