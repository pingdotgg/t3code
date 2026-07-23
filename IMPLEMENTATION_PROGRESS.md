# T3Code Integration - Implementation Progress

## Completed: Phase 1 - Backend Foundation (Partial)

### ✅ Contracts Layer (packages/contracts/src/orchestration.ts)
- Added `ThreadSettleCommand` schema
- Added `ThreadUnsettleCommand` schema with "user" reason
- Added `ThreadSettledPayload` schema (threadId, settledAt, updatedAt)
- Added `ThreadUnsettledPayload` schema (threadId, reason, updatedAt)
- Added event schemas for `thread.settled` and `thread.unsettled`
- Added commands to DispatchableClientOrchestrationCommand union
- Added commands to ClientOrchestrationCommand union

### ✅ Server Orchestration Decider (apps/server/src/orchestration/decider.ts)
- Added helper constants:
  - `QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000` (2 minutes)
- Added helper functions:
  - `isStaleRequestFailureDetail()` - Detects stale approval/input requests
  - `hasOpenBlockingRequest()` - Checks for pending approvals/user-input
- Implemented `thread.settle` command handler:
  - Validates no active/starting/running session
  - Validates no pending approval or user-input requests
  - Validates no queued turn starts (with grace window)
  - Handles idempotent re-settle (preserves original settledAt/updatedAt)
  - Emits `thread.settled` event
- Implemented `thread.unsettle` command handler:
  - Validates thread not archived
  - Handles idempotent re-unsettle
  - Emits `thread.unsettled` event with reason

### ✅ Server Orchestration Projector (apps/server/src/orchestration/projector.ts)
- Added `ThreadSettledPayload` and `ThreadUnsettledPayload` imports
- Implemented `thread.settled` event reducer:
  - Sets `settledOverride = "settled"`
  - Sets `settledAt` timestamp
  - Updates `updatedAt`
- Implemented `thread.unsettled` event reducer:
  - Sets `settledOverride = "active"` (user) or `null` (activity)
  - Clears `settledAt`
  - Updates `updatedAt`

### ✅ Server Orchestration Schemas (apps/server/src/orchestration/Schemas.ts)
- Added `ThreadSettledPayload` export
- Added `ThreadUnsettledPayload` export

### ✅ Database Migration (apps/server/src/persistence/Migrations/)
- Created `037_ProjectionThreadsSettled.ts` migration
- Adds `settled_override TEXT` column (nullable)
- Adds `settled_at TEXT` column (nullable ISO timestamp)
- Registered migration in `Migrations.ts` as migration #37

---

## TODO: Phase 1 - Backend Foundation (Remaining)

### ⏳ Thread Model Schema Updates
- [ ] Update `OrchestrationThread` type in contracts to include:
  - `settledOverride?: "settled" | "active" | null`
  - `settledAt?: string | null`
- [ ] Update thread projection queries to include settled columns
- [ ] Update thread shell snapshots to include settled state

### ⏳ Projection Pipeline Updates
- [ ] Add settled state computation logic
- [ ] Implement automatic unsettle on new activity
- [ ] Handle settled state in thread lifecycle transitions

### ⏳ Testing
- [ ] Unit tests for settle/unsettle command handlers
- [ ] Unit tests for settled event reducers
- [ ] Integration tests for settled lifecycle
- [ ] Test cases for edge conditions:
  - Cannot settle with active session
  - Cannot settle with pending approvals
  - Cannot settle with queued turn start
  - Idempotent settle/unsettle

---

## TODO: Phase 2 - Client Runtime Integration

### ⏳ Thread Settled State (packages/client-runtime/)
- [ ] Create `src/state/threadSettled.ts`:
  - `effectiveSettled()` atom function
  - `canSettle()` validation logic
  - `hasQueuedTurnStart()` detection
  - `hasPendingApprovals` / `hasPendingUserInput` tracking
- [ ] Add thread action commands:
  - `settleThread(threadId)` dispatcher
  - `unsettleThread(threadId)` dispatcher
- [ ] Wire commands to orchestration RPC API

### ⏳ Thread Shell Updates
- [ ] Subscribe to settled state changes
- [ ] Update thread list filtering for settled threads
- [ ] Handle settled state in thread status projection

---

## TODO: Phase 3 - macOS Native UI

### ⏳ Swift UI Components (apps/mac/Sources/)
- [ ] Create `ThreadListView.swift` - Main flat thread list
- [ ] Create `ThreadRowView.swift` - Individual thread row with settled indicator
- [ ] Create `ThreadContextMenu.swift` - Right-click actions (settle/unsettle)
- [ ] Create `ThreadStatusBadge.swift` - Visual status indicators

### ⏳ T3Kit RPC Extensions (apps/mac/Sources/T3Kit/)
- [ ] Add `settleThread()` RPC method
- [ ] Add `unsettleThread()` RPC method
- [ ] Extend `ThreadStatusProjection` with settled fields
- [ ] Update `ServerModels.swift` with settled state types

### ⏳ UI/UX Design
- [ ] Design segmented control (Active | Settled) for sidebar
- [ ] Apply Alpine glass chrome styling
- [ ] Add SF Symbols for settled state icons
- [ ] Implement smooth animations for state transitions
- [ ] Add keyboard shortcuts (Cmd+S to settle?)

---

## TODO: Phase 4 - Testing & Polish

### ⏳ Integration Testing
- [ ] Test settle/unsettle RPC flow end-to-end
- [ ] Test thread list filtering (active vs settled)
- [ ] Test offline mode behavior with settled state
- [ ] Test settled state persistence across restarts

### ⏳ Performance Testing
- [ ] Benchmark thread list rendering with 100+ threads
- [ ] Verify no memory leaks in settled state subscriptions
- [ ] Test database query performance with settled filters

### ⏳ User Acceptance Testing
- [ ] Validate settled workflow feels intuitive
- [ ] Ensure visual design matches SergeCode identity
- [ ] Test accessibility (VoiceOver, keyboard navigation)

---

## Architecture Notes

### Settled State Model
```typescript
type SettledOverride = "settled" | "active" | null;

// "settled" - User explicitly settled, stays settled
// "active"  - User explicitly unsettled, stays active  
// null      - No override, use computed settled state
```

### Settled State Priority
1. User override (`settledOverride`) takes precedence
2. Fallback to computed state based on session/turn status
3. Auto-unsettle on new user message or activity

### Database Schema
```sql
ALTER TABLE projection_threads ADD COLUMN settled_override TEXT;
ALTER TABLE projection_threads ADD COLUMN settled_at TEXT;
```

---

## Key Decisions Made

1. **Idempotent Commands**: Settle/unsettle commands are idempotent - can be called multiple times without error
2. **Grace Window**: 2-minute grace period for queued turn starts to prevent race conditions
3. **Reason Field**: Unsettle has "user" | "activity" reason to differentiate manual vs automatic unsettles
4. **Timestamp Preservation**: Re-settling preserves original `settledAt` to avoid ordering churn

---

## Next Steps

1. Update `OrchestrationThread` type schema in contracts
2. Implement client-runtime settled state tracking
3. Begin macOS UI prototyping with flat thread list
4. Create integration tests for full settled lifecycle


---

## ✅ COMPLETED: Phase 2 - Client Runtime Integration

### Thread Settled State (packages/client-runtime/src/state/threadSettled.ts)
- ✅ Created complete module with all settled state logic
- ✅ `effectiveSettled()` - Computes effective settled state
- ✅ `canSettle()` - Client-side validation
- ✅ `hasQueuedTurnStart()` - Detects pending turn starts
- ✅ `threadLastActivityAt()` - Finds latest activity timestamp
- ✅ `QUEUED_TURN_START_GRACE_MS` constant

### Contract Schema Updates
- ✅ Added `settledOverride` and `settledAt` to `OrchestrationThreadShell`
- ✅ Added `settledOverride` and `settledAt` to `OrchestrationThread`
- ✅ Both fields properly typed with default values

### Command Dispatchers (packages/client-runtime/src/operations/commands.ts)
- ✅ Added `SettleThreadInput` type
- ✅ Added `UnsettleThreadInput` type
- ✅ Implemented `settleThread()` command dispatcher
- ✅ Implemented `unsettleThread()` command dispatcher
- ✅ Both commands generate command IDs and dispatch to server

