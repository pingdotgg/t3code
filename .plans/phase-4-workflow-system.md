# Phase 4: Workflow System - Implementation Guide

## Overview
Build the declarative JSON-based workflow system for programmatic multi-agent orchestration.

## Dependencies
- ✅ Phase 1: SubAgentProviderRegistry
- ✅ Phase 2: UnifiedSubAgentTool
- ✅ Phase 3: Adapter Integration

## Architecture

```
WorkflowEngine
├── WorkflowExecutor (executes phases/tasks)
├── WorkflowStorage (filesystem + DB backup)
├── WorkflowProgress (tracks execution state)
├── WorkflowMetrics (cost/token tracking)
└── TaskDependencyResolver (resolves task dependencies)
```

## Core Components

### 1. WorkflowSchema.ts

Define the workflow JSON schema:

```typescript
export const WorkflowDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  phases: Schema.Array(WorkflowPhase),
  defaultProvider: Schema.optional(ProviderInstanceId),
  parallelismLimit: Schema.optional(Schema.Int.pipe(Schema.between(1, 50))),
});

export const WorkflowPhase = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  tasks: Schema.Array(WorkflowTask),
  execution: Schema.Literals(['sequential', 'parallel', 'pipeline']),
});

export const WorkflowTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literals(['spawn', 'wait', 'send', 'aggregate']),
  provider: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  dependencies: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  timeout: Schema.optional(Schema.Int.pipe(Schema.between(10, 600))),
  onError: Schema.optional(Schema.Literals(['continue', 'abort', 'retry'])),
  retryPolicy: Schema.optional(Schema.Struct({
    maxAttempts: Schema.Int.pipe(Schema.between(1, 5)),
    backoffMs: Schema.Int.pipe(Schema.between(100, 10000)),
  })),
});
```

### 2. WorkflowEngine.ts

Main orchestration engine:

```typescript
export class WorkflowEngine extends Context.Service<WorkflowEngine, {
  execute(
    definition: WorkflowDefinition,
    context: WorkflowExecutionContext,
  ): Effect.Effect<WorkflowExecutionResult, WorkflowError>;
  
  resume(
    workflowId: string,
    fromPhase: string,
  ): Effect.Effect<WorkflowExecutionResult, WorkflowError>;
  
  cancel(workflowId: string): Effect.Effect<void, WorkflowError>;
  
  getProgress(workflowId: string): Effect.Effect<WorkflowProgress, WorkflowError>;
}>() {}
```

**Key Features:**
- Phase execution with progress tracking
- Task dependency resolution
- Parallel/sequential/pipeline execution modes
- Failure handling and retry logic
- Resume from failure
- Cost/token accumulation

### 3. WorkflowExecutor.ts

Task execution logic:

```typescript
interface TaskExecutor {
  executeTask(
    task: WorkflowTask,
    context: TaskExecutionContext,
  ): Effect.Effect<TaskResult, TaskError>;
}

// Execution modes
function executeSequential(tasks: ReadonlyArray<WorkflowTask>): Effect.Effect<...>;
function executeParallel(tasks: ReadonlyArray<WorkflowTask>, limit: number): Effect.Effect<...>;
function executePipeline(tasks: ReadonlyArray<WorkflowTask>): Effect.Effect<...>;
```

**Execution Modes:**
- **Sequential**: Run tasks one after another
- **Parallel**: Run tasks concurrently with limit
- **Pipeline**: Stream results between tasks

### 4. WorkflowStorage.ts

Dual storage (filesystem + database):

```typescript
interface WorkflowStorage {
  save(
    workflow: WorkflowDefinition,
    metadata: WorkflowMetadata,
  ): Effect.Effect<string, StorageError>;
  
  load(workflowId: string): Effect.Effect<WorkflowDefinition, StorageError>;
  
  list(filter?: WorkflowFilter): Effect.Effect<Array<WorkflowMetadata>, StorageError>;
  
  delete(workflowId: string): Effect.Effect<void, StorageError>;
  
  // Backup to database
  syncToDatabase(workflowId: string): Effect.Effect<void, StorageError>;
  
  // Restore from database
  restoreFromDatabase(workflowId: string): Effect.Effect<void, StorageError>;
}
```

**Storage Strategy:**
- Primary: `.claude/workflows/<name>.json`
- Backup: Database table `workflows`
- Auto-sync on save
- Restore on filesystem miss

### 5. WorkflowProgress.ts

Progress tracking:

```typescript
interface WorkflowProgress {
  workflowId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  currentPhase: string;
  phasesCompleted: number;
  phasesTotal: number;
  tasksCompleted: number;
  tasksTotal: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  metrics: {
    totalDurationMs: number;
    totalTokens: number;
    totalCostUsd?: number;
  };
}
```

### 6. WorkflowMetrics.ts

Cost/token tracking:

```typescript
interface WorkflowMetrics {
  trackTaskExecution(
    taskId: string,
    provider: ProviderInstanceId,
    model: string,
    tokens: number,
    durationMs: number,
  ): Effect.Effect<void>;
  
  getWorkflowMetrics(workflowId: string): Effect.Effect<WorkflowMetricsSnapshot>;
  
  estimateCost(definition: WorkflowDefinition): Effect.Effect<CostEstimate>;
}
```

## Built-in Workflows

### 1. code-review.json

Multi-agent code review:

```json
{
  "name": "code-review-workflow",
  "description": "Multi-agent code review with specialized reviewers",
  "version": "1.0.0",
  "defaultProvider": "claudeAgent",
  "phases": [
    {
      "id": "discover",
      "title": "Discover Changes",
      "execution": "sequential",
      "tasks": [
        {
          "id": "list-files",
          "type": "spawn",
          "provider": "codex",
          "model": "gpt-5.5",
          "prompt": "List all modified files in this PR with git diff --name-only"
        }
      ]
    },
    {
      "id": "review",
      "title": "Parallel Review",
      "execution": "parallel",
      "tasks": [
        {
          "id": "security-review",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "opus-4.8",
          "prompt": "Review for security vulnerabilities: {{files}}",
          "dependencies": ["list-files"]
        },
        {
          "id": "performance-review",
          "type": "spawn",
          "provider": "codex",
          "model": "gpt-5.5",
          "prompt": "Review for performance issues: {{files}}",
          "dependencies": ["list-files"]
        },
        {
          "id": "style-review",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "sonnet-5",
          "prompt": "Review for code style and best practices: {{files}}",
          "dependencies": ["list-files"]
        }
      ]
    },
    {
      "id": "synthesize",
      "title": "Synthesize Results",
      "execution": "sequential",
      "tasks": [
        {
          "id": "final-report",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "sonnet-5",
          "prompt": "Create comprehensive review report combining: Security={{security-review}}, Performance={{performance-review}}, Style={{style-review}}",
          "dependencies": ["security-review", "performance-review", "style-review"]
        }
      ]
    }
  ]
}
```

### 2. parallel-search.json

Parallel information gathering:

```json
{
  "name": "parallel-search",
  "description": "Search multiple sources in parallel",
  "version": "1.0.0",
  "defaultProvider": "codex",
  "parallelismLimit": 10,
  "phases": [
    {
      "id": "search",
      "title": "Parallel Search",
      "execution": "parallel",
      "tasks": [
        {
          "id": "search-docs",
          "type": "spawn",
          "model": "gpt-4o-mini",
          "prompt": "Search documentation for: {{query}}"
        },
        {
          "id": "search-code",
          "type": "spawn",
          "model": "gpt-4o-mini",
          "prompt": "Search codebase for: {{query}}"
        },
        {
          "id": "search-issues",
          "type": "spawn",
          "model": "gpt-4o-mini",
          "prompt": "Search GitHub issues for: {{query}}"
        }
      ]
    },
    {
      "id": "synthesize",
      "title": "Synthesize",
      "execution": "sequential",
      "tasks": [
        {
          "id": "combine",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "sonnet-5",
          "prompt": "Combine findings: Docs={{search-docs}}, Code={{search-code}}, Issues={{search-issues}}",
          "dependencies": ["search-docs", "search-code", "search-issues"]
        }
      ]
    }
  ]
}
```

### 3. multi-model-eval.json

Evaluate with multiple models:

```json
{
  "name": "multi-model-eval",
  "description": "Get opinions from multiple models and synthesize",
  "version": "1.0.0",
  "phases": [
    {
      "id": "gather",
      "title": "Gather Opinions",
      "execution": "parallel",
      "tasks": [
        {
          "id": "opus-opinion",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "opus-4.8",
          "prompt": "{{question}}"
        },
        {
          "id": "sonnet-opinion",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "sonnet-5",
          "prompt": "{{question}}"
        },
        {
          "id": "gpt-opinion",
          "type": "spawn",
          "provider": "codex",
          "model": "gpt-5.5",
          "prompt": "{{question}}"
        }
      ]
    },
    {
      "id": "synthesize",
      "title": "Synthesize",
      "execution": "sequential",
      "tasks": [
        {
          "id": "final",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "fable-5",
          "prompt": "Compare these answers and provide the best synthesis: Opus={{opus-opinion}}, Sonnet={{sonnet-opinion}}, GPT={{gpt-opinion}}",
          "dependencies": ["opus-opinion", "sonnet-opinion", "gpt-opinion"]
        }
      ]
    }
  ]
}
```

## Implementation Steps

1. **Week 4 - Core Engine**
   - WorkflowSchema.ts
   - WorkflowEngine.ts
   - WorkflowExecutor.ts
   - Basic sequential execution

2. **Week 5 - Advanced Features**
   - WorkflowStorage.ts (filesystem + DB)
   - WorkflowProgress.ts
   - WorkflowMetrics.ts
   - Parallel/pipeline execution
   - Retry logic
   - Resume capability

3. **Integration**
   - Connect to UnifiedSubAgentTool
   - Add workflow action to tool
   - Create built-in workflows
   - Testing

## Testing Strategy

1. **Unit Tests**
   - Schema validation
   - Dependency resolution
   - Execution modes
   - Storage operations

2. **Integration Tests**
   - Full workflow execution
   - Cross-provider spawning
   - Progress tracking
   - Metrics accumulation

3. **End-to-End Tests**
   - Built-in workflows
   - Failure scenarios
   - Resume capability

## Validation Checklist

- [ ] JSON schema validation works
- [ ] Sequential execution correct
- [ ] Parallel execution respects limits
- [ ] Pipeline execution streams results
- [ ] Dependencies resolved correctly
- [ ] Can resume from failure
- [ ] Filesystem storage works
- [ ] Database backup works
- [ ] Progress tracking accurate
- [ ] Cost tracking accurate
- [ ] Built-in workflows execute
- [ ] Tests pass
- [ ] Type check passes

## Database Schema

Add to existing database:

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  definition JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id),
  status TEXT NOT NULL,
  progress JSONB,
  metrics JSONB,
  started_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```
