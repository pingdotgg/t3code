# Implementation Progress Update - Phase 2

## ✅ Completed: Client Runtime Integration

### Thread Settled State Logic (packages/client-runtime/src/state/threadSettled.ts)
- ✅ Created complete threadSettled.ts module with:
  - `threadLastActivityAt()` - Finds latest activity timestamp
  - `hasQueuedTurnStart()` - Detects user messages not yet adopted by a turn
  - `canSettle()` - Client-side validation before settle command
  - `effectiveSettled()` - Computes effective settled state with all logic
  - `QUEUED_TURN_START_GRACE_MS` constant (2 minutes)
  - `ChangeRequestStateLike` type for PR state

### Contract Schema Updates (packages/contracts/src/orchestration.ts)
- ✅ Added settled fields to `OrchestrationThreadShell`:
  - `settledOverride?: "settled" | "active" | null`
  - `settledAt?: string | null`
- ✅ Added settled fields to `OrchestrationThread`:
  - `settledOverride?: "settled" | "active" | null`
  - `settledAt?: string | null`

## 📋 Next: Thread Action Commands

### TODO: Add Settle/Unsettle Command Dispatchers
Need to create command dispatcher functions that will:
1. Generate command IDs
2. Dispatch settle/unsettle commands to server
3. Handle optimistic UI updates
4. Handle error states

Files to create/update:
- Check existing action patterns in client-runtime
- Add settleThread() and unsettleThread() functions
- Wire to RPC/WebSocket layer

