# v3 to v4 Import and API Rename Maps

Mapped modules: 290
No counterpart: 43
API renames: 53

This file is intended for migration agents. It contains user-facing import
specifier mappings and API rename mappings.

Use the import map when rewriting import declarations. Use the API renames when
rewriting renamed symbols.

## Import Map

Each line is `v3 import -> v4 direct module import`. When a grouped v4 barrel
exists, the suggested barrel import is shown in parentheses.

```text
@effect/platform/ChannelSchema -> effect/ChannelSchema (barrel: effect)
@effect/platform/FileSystem -> effect/FileSystem (barrel: effect)
effect/JSONSchema -> effect/JsonSchema (barrel: effect)
@effect/platform/Path -> effect/Path (barrel: effect)
@effect/platform/Error -> effect/PlatformError (barrel: effect)
effect/Either -> effect/Result (barrel: effect)
@effect/platform/Terminal -> effect/Terminal (barrel: effect)
effect/TDeferred -> effect/TxDeferred (barrel: effect)
effect/TMap -> effect/TxHashMap (barrel: effect)
effect/TSet -> effect/TxHashSet (barrel: effect)
effect/TPriorityQueue -> effect/TxPriorityQueue (barrel: effect)
effect/TPubSub -> effect/TxPubSub (barrel: effect)
effect/TQueue -> effect/TxQueue (barrel: effect)
effect/TReentrantLock -> effect/TxReentrantLock (barrel: effect)
effect/TRef -> effect/TxRef (barrel: effect)
effect/TSemaphore -> effect/TxSemaphore (barrel: effect)
effect/TSubscriptionRef -> effect/TxSubscriptionRef (barrel: effect)
effect/FastCheck -> effect/testing/FastCheck (barrel: effect/testing)
effect/TestClock -> effect/testing/TestClock (barrel: effect/testing)
@effect/cli/Args -> effect/unstable/cli/Argument (barrel: effect/unstable/cli)
@effect/cli/ValidationError -> effect/unstable/cli/CliError (barrel: effect/unstable/cli)
@effect/cli/Command -> effect/unstable/cli/Command (barrel: effect/unstable/cli)
@effect/cli/CommandDescriptor -> effect/unstable/cli/Completions (barrel: effect/unstable/cli)
@effect/cli/Options -> effect/unstable/cli/Flag (barrel: effect/unstable/cli)
@effect/cli/BuiltInOptions -> effect/unstable/cli/GlobalFlag (barrel: effect/unstable/cli)
@effect/cli/HelpDoc -> effect/unstable/cli/HelpDoc (barrel: effect/unstable/cli)
@effect/cli/Primitive -> effect/unstable/cli/Primitive (barrel: effect/unstable/cli)
@effect/cli/Prompt -> effect/unstable/cli/Prompt (barrel: effect/unstable/cli)
@effect/cluster/ClusterCron -> effect/unstable/cluster/ClusterCron (barrel: effect/unstable/cluster)
@effect/cluster/ClusterError -> effect/unstable/cluster/ClusterError (barrel: effect/unstable/cluster)
@effect/cluster/ClusterMetrics -> effect/unstable/cluster/ClusterMetrics (barrel: effect/unstable/cluster)
@effect/cluster/ClusterSchema -> effect/unstable/cluster/ClusterSchema (barrel: effect/unstable/cluster)
@effect/cluster/ClusterWorkflowEngine -> effect/unstable/cluster/ClusterWorkflowEngine (barrel: effect/unstable/cluster)
@effect/cluster/DeliverAt -> effect/unstable/cluster/DeliverAt (barrel: effect/unstable/cluster)
@effect/cluster/Entity -> effect/unstable/cluster/Entity (barrel: effect/unstable/cluster)
@effect/cluster/EntityAddress -> effect/unstable/cluster/EntityAddress (barrel: effect/unstable/cluster)
@effect/cluster/EntityId -> effect/unstable/cluster/EntityId (barrel: effect/unstable/cluster)
@effect/cluster/EntityProxy -> effect/unstable/cluster/EntityProxy (barrel: effect/unstable/cluster)
@effect/cluster/EntityProxyServer -> effect/unstable/cluster/EntityProxyServer (barrel: effect/unstable/cluster)
@effect/cluster/EntityResource -> effect/unstable/cluster/EntityResource (barrel: effect/unstable/cluster)
@effect/cluster/EntityType -> effect/unstable/cluster/EntityType (barrel: effect/unstable/cluster)
@effect/cluster/Envelope -> effect/unstable/cluster/Envelope (barrel: effect/unstable/cluster)
@effect/cluster/HttpRunner -> effect/unstable/cluster/HttpRunner (barrel: effect/unstable/cluster)
@effect/cluster/K8sHttpClient -> effect/unstable/cluster/K8sHttpClient (barrel: effect/unstable/cluster)
@effect/cluster/MachineId -> effect/unstable/cluster/MachineId (barrel: effect/unstable/cluster)
@effect/cluster/Message -> effect/unstable/cluster/Message (barrel: effect/unstable/cluster)
@effect/cluster/MessageStorage -> effect/unstable/cluster/MessageStorage (barrel: effect/unstable/cluster)
@effect/cluster/Reply -> effect/unstable/cluster/Reply (barrel: effect/unstable/cluster)
@effect/cluster/Runner -> effect/unstable/cluster/Runner (barrel: effect/unstable/cluster)
@effect/cluster/RunnerAddress -> effect/unstable/cluster/RunnerAddress (barrel: effect/unstable/cluster)
@effect/cluster/RunnerHealth -> effect/unstable/cluster/RunnerHealth (barrel: effect/unstable/cluster)
@effect/cluster/RunnerServer -> effect/unstable/cluster/RunnerServer (barrel: effect/unstable/cluster)
@effect/cluster/RunnerStorage -> effect/unstable/cluster/RunnerStorage (barrel: effect/unstable/cluster)
@effect/cluster/Runners -> effect/unstable/cluster/Runners (barrel: effect/unstable/cluster)
@effect/cluster/ShardId -> effect/unstable/cluster/ShardId (barrel: effect/unstable/cluster)
@effect/cluster/Sharding -> effect/unstable/cluster/Sharding (barrel: effect/unstable/cluster)
@effect/cluster/ShardingConfig -> effect/unstable/cluster/ShardingConfig (barrel: effect/unstable/cluster)
@effect/cluster/ShardingRegistrationEvent -> effect/unstable/cluster/ShardingRegistrationEvent (barrel: effect/unstable/cluster)
@effect/cluster/SingleRunner -> effect/unstable/cluster/SingleRunner (barrel: effect/unstable/cluster)
@effect/cluster/Singleton -> effect/unstable/cluster/Singleton (barrel: effect/unstable/cluster)
@effect/cluster/SingletonAddress -> effect/unstable/cluster/SingletonAddress (barrel: effect/unstable/cluster)
@effect/cluster/Snowflake -> effect/unstable/cluster/Snowflake (barrel: effect/unstable/cluster)
@effect/cluster/SocketRunner -> effect/unstable/cluster/SocketRunner (barrel: effect/unstable/cluster)
@effect/cluster/SqlMessageStorage -> effect/unstable/cluster/SqlMessageStorage (barrel: effect/unstable/cluster)
@effect/cluster/SqlRunnerStorage -> effect/unstable/cluster/SqlRunnerStorage (barrel: effect/unstable/cluster)
@effect/cluster/TestRunner -> effect/unstable/cluster/TestRunner (barrel: effect/unstable/cluster)
@effect/experimental/DevTools -> effect/unstable/devtools/DevTools (barrel: effect/unstable/devtools)
@effect/experimental/DevTools/Client -> effect/unstable/devtools/DevToolsClient (barrel: effect/unstable/devtools)
@effect/experimental/DevTools/Domain -> effect/unstable/devtools/DevToolsSchema (barrel: effect/unstable/devtools)
@effect/experimental/DevTools/Server -> effect/unstable/devtools/DevToolsServer (barrel: effect/unstable/devtools)
@effect/platform/MsgPack -> effect/unstable/encoding/Msgpack (barrel: effect/unstable/encoding)
@effect/platform/Ndjson -> effect/unstable/encoding/Ndjson (barrel: effect/unstable/encoding)
@effect/experimental/Sse -> effect/unstable/encoding/Sse (barrel: effect/unstable/encoding)
@effect/ai/AiError -> effect/unstable/ai/AiError (barrel: effect/unstable/ai)
@effect/ai/Chat -> effect/unstable/ai/Chat (barrel: effect/unstable/ai)
@effect/ai/EmbeddingModel -> effect/unstable/ai/EmbeddingModel (barrel: effect/unstable/ai)
@effect/ai/IdGenerator -> effect/unstable/ai/IdGenerator (barrel: effect/unstable/ai)
@effect/ai/LanguageModel -> effect/unstable/ai/LanguageModel (barrel: effect/unstable/ai)
@effect/ai/McpSchema -> effect/unstable/ai/McpSchema (barrel: effect/unstable/ai)
@effect/ai/McpServer -> effect/unstable/ai/McpServer (barrel: effect/unstable/ai)
@effect/ai/Model -> effect/unstable/ai/Model (barrel: effect/unstable/ai)
@effect/ai/Prompt -> effect/unstable/ai/Prompt (barrel: effect/unstable/ai)
@effect/ai/Response -> effect/unstable/ai/Response (barrel: effect/unstable/ai)
@effect/ai/Telemetry -> effect/unstable/ai/Telemetry (barrel: effect/unstable/ai)
@effect/ai/Tokenizer -> effect/unstable/ai/Tokenizer (barrel: effect/unstable/ai)
@effect/ai/Tool -> effect/unstable/ai/Tool (barrel: effect/unstable/ai)
@effect/ai/Toolkit -> effect/unstable/ai/Toolkit (barrel: effect/unstable/ai)
@effect/experimental/Event -> effect/unstable/eventlog/Event (barrel: effect/unstable/eventlog)
@effect/experimental/EventGroup -> effect/unstable/eventlog/EventGroup (barrel: effect/unstable/eventlog)
@effect/experimental/EventJournal -> effect/unstable/eventlog/EventJournal (barrel: effect/unstable/eventlog)
@effect/experimental/EventLog -> effect/unstable/eventlog/EventLog (barrel: effect/unstable/eventlog)
@effect/experimental/EventLogEncryption -> effect/unstable/eventlog/EventLogEncryption (barrel: effect/unstable/eventlog)
@effect/experimental/EventLogRemote -> effect/unstable/eventlog/EventLogMessage (barrel: effect/unstable/eventlog)
@effect/experimental/EventLogRemote -> effect/unstable/eventlog/EventLogRemote (barrel: effect/unstable/eventlog)
@effect/experimental/EventLogServer -> effect/unstable/eventlog/EventLogServer (barrel: effect/unstable/eventlog)
@effect/experimental/EventLogServer -> effect/unstable/eventlog/EventLogServerEncrypted (barrel: effect/unstable/eventlog)
@effect/sql/SqlEventJournal -> effect/unstable/eventlog/SqlEventJournal (barrel: effect/unstable/eventlog)
@effect/sql/SqlEventLogServer -> effect/unstable/eventlog/SqlEventLogServerEncrypted (barrel: effect/unstable/eventlog)
@effect/platform/Cookies -> effect/unstable/http/Cookies (barrel: effect/unstable/http)
@effect/platform/Etag -> effect/unstable/http/Etag (barrel: effect/unstable/http)
@effect/platform/FetchHttpClient -> effect/unstable/http/FetchHttpClient (barrel: effect/unstable/http)
@effect/platform/Headers -> effect/unstable/http/Headers (barrel: effect/unstable/http)
@effect/platform/HttpBody -> effect/unstable/http/HttpBody (barrel: effect/unstable/http)
@effect/platform/HttpClient -> effect/unstable/http/HttpClient (barrel: effect/unstable/http)
@effect/platform/HttpClientError -> effect/unstable/http/HttpClientError (barrel: effect/unstable/http)
@effect/platform/HttpClientRequest -> effect/unstable/http/HttpClientRequest (barrel: effect/unstable/http)
@effect/platform/HttpClientResponse -> effect/unstable/http/HttpClientResponse (barrel: effect/unstable/http)
@effect/platform/HttpApp -> effect/unstable/http/HttpEffect (barrel: effect/unstable/http)
@effect/platform/HttpIncomingMessage -> effect/unstable/http/HttpIncomingMessage (barrel: effect/unstable/http)
@effect/platform/HttpMethod -> effect/unstable/http/HttpMethod (barrel: effect/unstable/http)
@effect/platform/HttpMiddleware -> effect/unstable/http/HttpMiddleware (barrel: effect/unstable/http)
@effect/platform/HttpPlatform -> effect/unstable/http/HttpPlatform (barrel: effect/unstable/http)
@effect/platform/HttpRouter -> effect/unstable/http/HttpRouter (barrel: effect/unstable/http)
@effect/platform/HttpServer -> effect/unstable/http/HttpServer (barrel: effect/unstable/http)
@effect/platform/HttpServerError -> effect/unstable/http/HttpServerError (barrel: effect/unstable/http)
@effect/platform/HttpServerRequest -> effect/unstable/http/HttpServerRequest (barrel: effect/unstable/http)
@effect/platform/HttpServerRespondable -> effect/unstable/http/HttpServerRespondable (barrel: effect/unstable/http)
@effect/platform/HttpServerResponse -> effect/unstable/http/HttpServerResponse (barrel: effect/unstable/http)
@effect/platform/HttpTraceContext -> effect/unstable/http/HttpTraceContext (barrel: effect/unstable/http)
@effect/platform/Multipart -> effect/unstable/http/Multipart (barrel: effect/unstable/http)
@effect/platform/Template -> effect/unstable/http/Template (barrel: effect/unstable/http)
@effect/platform/Url -> effect/unstable/http/Url (barrel: effect/unstable/http)
@effect/platform/UrlParams -> effect/unstable/http/UrlParams (barrel: effect/unstable/http)
@effect/platform/HttpApi -> effect/unstable/httpapi/HttpApi (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiBuilder -> effect/unstable/httpapi/HttpApiBuilder (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiClient -> effect/unstable/httpapi/HttpApiClient (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiEndpoint -> effect/unstable/httpapi/HttpApiEndpoint (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiError -> effect/unstable/httpapi/HttpApiError (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiGroup -> effect/unstable/httpapi/HttpApiGroup (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiMiddleware -> effect/unstable/httpapi/HttpApiMiddleware (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiScalar -> effect/unstable/httpapi/HttpApiScalar (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiSchema -> effect/unstable/httpapi/HttpApiSchema (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiSecurity -> effect/unstable/httpapi/HttpApiSecurity (barrel: effect/unstable/httpapi)
@effect/platform/HttpApiSwagger -> effect/unstable/httpapi/HttpApiSwagger (barrel: effect/unstable/httpapi)
@effect/platform/OpenApi -> effect/unstable/httpapi/OpenApi (barrel: effect/unstable/httpapi)
@effect/opentelemetry/Otlp -> effect/unstable/observability/Otlp (barrel: effect/unstable/observability)
@effect/opentelemetry/internal/otlpExporter -> effect/unstable/observability/OtlpExporter (barrel: effect/unstable/observability)
@effect/opentelemetry/OtlpLogger -> effect/unstable/observability/OtlpLogger (barrel: effect/unstable/observability)
@effect/opentelemetry/OtlpMetrics -> effect/unstable/observability/OtlpMetrics (barrel: effect/unstable/observability)
@effect/opentelemetry/OtlpResource -> effect/unstable/observability/OtlpResource (barrel: effect/unstable/observability)
@effect/opentelemetry/OtlpSerialization -> effect/unstable/observability/OtlpSerialization (barrel: effect/unstable/observability)
@effect/opentelemetry/OtlpTracer -> effect/unstable/observability/OtlpTracer (barrel: effect/unstable/observability)
@effect/platform/KeyValueStore -> effect/unstable/persistence/KeyValueStore (barrel: effect/unstable/persistence)
@effect/experimental/Persistence -> effect/unstable/persistence/Persistable (barrel: effect/unstable/persistence)
@effect/experimental/PersistedCache -> effect/unstable/persistence/PersistedCache (barrel: effect/unstable/persistence)
@effect/experimental/PersistedQueue -> effect/unstable/persistence/PersistedQueue (barrel: effect/unstable/persistence)
@effect/experimental/Persistence -> effect/unstable/persistence/Persistence (barrel: effect/unstable/persistence)
@effect/experimental/RateLimiter -> effect/unstable/persistence/RateLimiter (barrel: effect/unstable/persistence)
@effect/platform/Command -> effect/unstable/process/ChildProcess (barrel: effect/unstable/process)
@effect/platform/CommandExecutor -> effect/unstable/process/ChildProcessSpawner (barrel: effect/unstable/process)
@effect/experimental/Reactivity -> effect/unstable/reactivity/Reactivity (barrel: effect/unstable/reactivity)
@effect/rpc/Rpc -> effect/unstable/rpc/Rpc (barrel: effect/unstable/rpc)
@effect/rpc/RpcClient -> effect/unstable/rpc/RpcClient (barrel: effect/unstable/rpc)
@effect/rpc/RpcClientError -> effect/unstable/rpc/RpcClientError (barrel: effect/unstable/rpc)
@effect/rpc/RpcGroup -> effect/unstable/rpc/RpcGroup (barrel: effect/unstable/rpc)
@effect/rpc/RpcMessage -> effect/unstable/rpc/RpcMessage (barrel: effect/unstable/rpc)
@effect/rpc/RpcMiddleware -> effect/unstable/rpc/RpcMiddleware (barrel: effect/unstable/rpc)
@effect/rpc/RpcSchema -> effect/unstable/rpc/RpcSchema (barrel: effect/unstable/rpc)
@effect/rpc/RpcSerialization -> effect/unstable/rpc/RpcSerialization (barrel: effect/unstable/rpc)
@effect/rpc/RpcServer -> effect/unstable/rpc/RpcServer (barrel: effect/unstable/rpc)
@effect/rpc/RpcTest -> effect/unstable/rpc/RpcTest (barrel: effect/unstable/rpc)
@effect/rpc/RpcWorker -> effect/unstable/rpc/RpcWorker (barrel: effect/unstable/rpc)
@effect/sql/Model -> effect/unstable/schema/Model (barrel: effect/unstable/schema)
@effect/experimental/VariantSchema -> effect/unstable/schema/VariantSchema (barrel: effect/unstable/schema)
@effect/platform/Socket -> effect/unstable/socket/Socket (barrel: effect/unstable/socket)
@effect/platform/SocketServer -> effect/unstable/socket/SocketServer (barrel: effect/unstable/socket)
@effect/sql/Migrator -> effect/unstable/sql/Migrator (barrel: effect/unstable/sql)
@effect/sql/SqlClient -> effect/unstable/sql/SqlClient (barrel: effect/unstable/sql)
@effect/sql/SqlConnection -> effect/unstable/sql/SqlConnection (barrel: effect/unstable/sql)
@effect/sql/SqlError -> effect/unstable/sql/SqlError (barrel: effect/unstable/sql)
@effect/sql/Model -> effect/unstable/sql/SqlModel (barrel: effect/unstable/sql)
@effect/sql/SqlResolver -> effect/unstable/sql/SqlResolver (barrel: effect/unstable/sql)
@effect/sql/SqlSchema -> effect/unstable/sql/SqlSchema (barrel: effect/unstable/sql)
@effect/sql/SqlStream -> effect/unstable/sql/SqlStream (barrel: effect/unstable/sql)
@effect/sql/Statement -> effect/unstable/sql/Statement (barrel: effect/unstable/sql)
@effect/platform/Transferable -> effect/unstable/workers/Transferable (barrel: effect/unstable/workers)
@effect/platform/Worker -> effect/unstable/workers/Worker (barrel: effect/unstable/workers)
@effect/platform/WorkerError -> effect/unstable/workers/WorkerError (barrel: effect/unstable/workers)
@effect/platform/WorkerRunner -> effect/unstable/workers/WorkerRunner (barrel: effect/unstable/workers)
@effect/workflow/Activity -> effect/unstable/workflow/Activity (barrel: effect/unstable/workflow)
@effect/workflow/DurableClock -> effect/unstable/workflow/DurableClock (barrel: effect/unstable/workflow)
@effect/workflow/DurableDeferred -> effect/unstable/workflow/DurableDeferred (barrel: effect/unstable/workflow)
@effect/workflow/DurableQueue -> effect/unstable/workflow/DurableQueue (barrel: effect/unstable/workflow)
@effect/workflow/Workflow -> effect/unstable/workflow/Workflow (barrel: effect/unstable/workflow)
@effect/workflow/WorkflowEngine -> effect/unstable/workflow/WorkflowEngine (barrel: effect/unstable/workflow)
@effect/workflow/WorkflowProxy -> effect/unstable/workflow/WorkflowProxy (barrel: effect/unstable/workflow)
@effect/workflow/WorkflowProxyServer -> effect/unstable/workflow/WorkflowProxyServer (barrel: effect/unstable/workflow)
effect/Array -> effect/Array (barrel: effect)
effect/BigDecimal -> effect/BigDecimal (barrel: effect)
effect/BigInt -> effect/BigInt (barrel: effect)
effect/Boolean -> effect/Boolean (barrel: effect)
effect/Brand -> effect/Brand (barrel: effect)
effect/Cache -> effect/Cache (barrel: effect)
effect/Cause -> effect/Cause (barrel: effect)
effect/Channel -> effect/Channel (barrel: effect)
effect/Chunk -> effect/Chunk (barrel: effect)
effect/Clock -> effect/Clock (barrel: effect)
@effect/typeclass/Semigroup -> effect/Combiner (barrel: effect)
effect/Config -> effect/Config (barrel: effect)
effect/ConfigProvider -> effect/ConfigProvider (barrel: effect)
effect/Console -> effect/Console (barrel: effect)
effect/Context -> effect/Context (barrel: effect)
effect/Cron -> effect/Cron (barrel: effect)
effect/Data -> effect/Data (barrel: effect)
effect/DateTime -> effect/DateTime (barrel: effect)
effect/Deferred -> effect/Deferred (barrel: effect)
effect/Differ -> effect/Differ (barrel: effect)
effect/Duration -> effect/Duration (barrel: effect)
effect/Effect -> effect/Effect (barrel: effect)
effect/Effectable -> effect/Effectable (barrel: effect)
effect/Encoding -> effect/Encoding (barrel: effect)
effect/Equal -> effect/Equal (barrel: effect)
effect/Equivalence -> effect/Equivalence (barrel: effect)
effect/ExecutionPlan -> effect/ExecutionPlan (barrel: effect)
effect/Exit -> effect/Exit (barrel: effect)
effect/Fiber -> effect/Fiber (barrel: effect)
effect/FiberHandle -> effect/FiberHandle (barrel: effect)
effect/FiberMap -> effect/FiberMap (barrel: effect)
effect/FiberSet -> effect/FiberSet (barrel: effect)
effect/Inspectable -> effect/Formatter (barrel: effect)
effect/Function -> effect/Function (barrel: effect)
effect/Graph -> effect/Graph (barrel: effect)
effect/HKT -> effect/HKT (barrel: effect)
effect/Hash -> effect/Hash (barrel: effect)
effect/HashMap -> effect/HashMap (barrel: effect)
effect/HashRing -> effect/HashRing (barrel: effect)
effect/HashSet -> effect/HashSet (barrel: effect)
effect/Inspectable -> effect/Inspectable (barrel: effect)
effect/Iterable -> effect/Iterable (barrel: effect)
effect/Layer -> effect/Layer (barrel: effect)
effect/LayerMap -> effect/LayerMap (barrel: effect)
effect/LogLevel -> effect/LogLevel (barrel: effect)
effect/Logger -> effect/Logger (barrel: effect)
effect/ManagedRuntime -> effect/ManagedRuntime (barrel: effect)
effect/Match -> effect/Match (barrel: effect)
effect/Metric -> effect/Metric (barrel: effect)
effect/MutableHashMap -> effect/MutableHashMap (barrel: effect)
effect/MutableHashSet -> effect/MutableHashSet (barrel: effect)
effect/MutableList -> effect/MutableList (barrel: effect)
effect/MutableRef -> effect/MutableRef (barrel: effect)
effect/NonEmptyIterable -> effect/NonEmptyIterable (barrel: effect)
effect/Number -> effect/Number (barrel: effect)
effect/Option -> effect/Option (barrel: effect)
effect/Order -> effect/Order (barrel: effect)
effect/Ordering -> effect/Ordering (barrel: effect)
effect/PartitionedSemaphore -> effect/PartitionedSemaphore (barrel: effect)
effect/Pipeable -> effect/Pipeable (barrel: effect)
effect/Pool -> effect/Pool (barrel: effect)
effect/Predicate -> effect/Predicate (barrel: effect)
effect/PrimaryKey -> effect/PrimaryKey (barrel: effect)
effect/PubSub -> effect/PubSub (barrel: effect)
effect/Queue -> effect/Queue (barrel: effect)
effect/Random -> effect/Random (barrel: effect)
effect/RcMap -> effect/RcMap (barrel: effect)
effect/RcRef -> effect/RcRef (barrel: effect)
effect/Record -> effect/Record (barrel: effect)
effect/Inspectable -> effect/Redactable (barrel: effect)
effect/Redacted -> effect/Redacted (barrel: effect)
@effect/typeclass/Monoid -> effect/Reducer (barrel: effect)
effect/Ref -> effect/Ref (barrel: effect)
effect/FiberRef -> effect/References (barrel: effect)
effect/RegExp -> effect/RegExp (barrel: effect)
effect/Request -> effect/Request (barrel: effect)
effect/RequestResolver -> effect/RequestResolver (barrel: effect)
effect/Resource -> effect/Resource (barrel: effect)
effect/Runtime -> effect/Runtime (barrel: effect)
effect/Schedule -> effect/Schedule (barrel: effect)
effect/Scheduler -> effect/Scheduler (barrel: effect)
effect/Schema -> effect/Schema (barrel: effect)
effect/SchemaAST -> effect/SchemaAST (barrel: effect)
effect/ParseResult -> effect/SchemaIssue (barrel: effect)
effect/ParseResult -> effect/SchemaParser (barrel: effect)
effect/Schema -> effect/SchemaTransformation (barrel: effect)
effect/Scope -> effect/Scope (barrel: effect)
effect/ScopedCache -> effect/ScopedCache (barrel: effect)
effect/ScopedRef -> effect/ScopedRef (barrel: effect)
effect/Sink -> effect/Sink (barrel: effect)
effect/Stream -> effect/Stream (barrel: effect)
effect/String -> effect/String (barrel: effect)
effect/Struct -> effect/Struct (barrel: effect)
effect/SubscriptionRef -> effect/SubscriptionRef (barrel: effect)
effect/Symbol -> effect/Symbol (barrel: effect)
effect/SynchronizedRef -> effect/SynchronizedRef (barrel: effect)
effect/Take -> effect/Take (barrel: effect)
effect/Tracer -> effect/Tracer (barrel: effect)
effect/Trie -> effect/Trie (barrel: effect)
effect/Tuple -> effect/Tuple (barrel: effect)
effect/Types -> effect/Types (barrel: effect)
effect/Unify -> effect/Unify (barrel: effect)
effect/Utils -> effect/Utils (barrel: effect)
```

## No Counterpart Imports

These v4 modules did not have a mapped v3 module. Treat them as v4-only unless a
more specific migration guide says otherwise.

```text
effect/ErrorReporter (barrel: effect)
effect/Filter (barrel: effect)
effect/JsonPatch (barrel: effect)
effect/JsonPointer (barrel: effect)
effect/Latch (barrel: effect)
effect/Newtype (barrel: effect)
effect/Optic (barrel: effect)
effect/Pull (barrel: effect)
effect/SchemaGetter (barrel: effect)
effect/SchemaRepresentation (barrel: effect)
effect/SchemaUtils (barrel: effect)
effect/Semaphore (barrel: effect)
effect/Stdio (barrel: effect)
effect/TxChunk (barrel: effect)
effect/UndefinedOr (barrel: effect)
effect/testing/TestConsole (barrel: effect/testing)
effect/testing/TestSchema (barrel: effect/testing)
effect/unstable/ai/AnthropicStructuredOutput (barrel: effect/unstable/ai)
effect/unstable/ai/OpenAiStructuredOutput (barrel: effect/unstable/ai)
effect/unstable/ai/ResponseIdTracker (barrel: effect/unstable/ai)
effect/unstable/cli/CliOutput (barrel: effect/unstable/cli)
effect/unstable/cli/Param (barrel: effect/unstable/cli)
effect/unstable/eventlog/EventLogServerUnencrypted (barrel: effect/unstable/eventlog)
effect/unstable/eventlog/EventLogSessionAuth (barrel: effect/unstable/eventlog)
effect/unstable/eventlog/SqlEventLogServerUnencrypted (barrel: effect/unstable/eventlog)
effect/unstable/http/FindMyWay (barrel: effect/unstable/http)
effect/unstable/http/HttpStaticServer (barrel: effect/unstable/http)
effect/unstable/http/Multipasta (barrel: effect/unstable/http)
effect/unstable/http/Multipasta/HeadersParser (barrel: effect/unstable/http)
effect/unstable/http/Multipasta/Node (barrel: effect/unstable/http)
effect/unstable/http/Multipasta/Search (barrel: effect/unstable/http)
effect/unstable/http/Multipasta/Web (barrel: effect/unstable/http)
effect/unstable/httpapi/HttpApiTest (barrel: effect/unstable/httpapi)
effect/unstable/observability/PrometheusMetrics (barrel: effect/unstable/observability)
effect/unstable/persistence/Redis (barrel: effect/unstable/persistence)
effect/unstable/reactivity/AsyncResult (barrel: effect/unstable/reactivity)
effect/unstable/reactivity/Atom (barrel: effect/unstable/reactivity)
effect/unstable/reactivity/AtomHttpApi (barrel: effect/unstable/reactivity)
effect/unstable/reactivity/AtomRef (barrel: effect/unstable/reactivity)
effect/unstable/reactivity/AtomRegistry (barrel: effect/unstable/reactivity)
effect/unstable/reactivity/AtomRpc (barrel: effect/unstable/reactivity)
effect/unstable/reactivity/Hydration (barrel: effect/unstable/reactivity)
effect/unstable/rpc/Utils (barrel: effect/unstable/rpc)
```

## API Renames

Each line is `v3 API -> v4 API`. Use these mappings when rewriting renamed
symbols from v3 source code to v4.

```text
Effect.async -> Effect.callback
Effect.zipRight -> Effect.andThen
Effect.zipLeft -> Effect.tap
Effect.either -> Effect.result
Effect.catchAll -> Effect.catch
Effect.catchAllCause -> Effect.catchCause
Effect.catchAllDefect -> Effect.catchDefect
Effect.catchSome -> Effect.catchIf
Effect.catchIf -> Effect.catchIf
Effect.optionFromOptional -> Effect.catchNoSuchElement
Effect.catchSomeCause -> Effect.catchCauseIf
Effect.tapErrorCause -> Effect.tapCause
Effect.ignoreLogged -> Effect.ignore
Effect.makeLatchUnsafe -> Latch.makeUnsafe
Effect.makeLatch -> Latch.make
Layer.scoped -> Layer.effect
Layer.scopedDiscard -> Layer.effectDiscard
Layer.tapErrorCause -> Layer.tapCause
Mailbox -> Queue.Queue
Mailbox.make -> Queue.make
Either -> Result.Result
Either.right -> Result.succeed
Either.left -> Result.fail
Scope.extend -> Scope.provide
Effect.makeSemaphoreUnsafe -> Semaphore.makeUnsafe
Effect.makeSemaphore -> Semaphore.make
Stream.Context -> Stream.Services
StreamHaltStrategy.HaltStrategy -> Stream.HaltStrategy
Stream.repeatEffect -> Stream.fromEffectRepeat
Stream.repeatEffectWithSchedule -> Stream.fromEffectSchedule
Stream.async -> Stream.callback
Stream.asyncEffect -> Stream.callback
Stream.asyncPush -> Stream.callback
Stream.asyncScoped -> Stream.callback
Stream.repeatEffectChunk -> Stream.fromIterableEffectRepeat
Stream.fromChunk -> Stream.fromArray
Stream.fromChunks -> Stream.fromArrays
Stream.mapChunks -> Stream.mapArray
Stream.mapChunksEffect -> Stream.mapArrayEffect
Stream.either -> Stream.result
Stream.flattenChunks -> Stream.flattenArray
Stream.flattenIterables -> Stream.flattenIterable
Stream.mergeEither -> Stream.mergeResult
Stream.zipWithChunks -> Stream.zipWithArray
Stream.bufferChunks -> Stream.bufferArray
Stream.catchAllCause -> Stream.catchCause
Stream.tapErrorCause -> Stream.tapCause
Stream.catchAll -> Stream.catch
Stream.catchSome -> Stream.catchIf
Stream.catchSomeCause -> Stream.catchCauseIf
Stream.combineChunks -> Stream.combineArray
provideSomeLayer -> Stream.provide
provideSomeContext -> Stream.provide
```
