# Phase 3: macOS Native UI - Implementation Progress

## ✅ Completed: T3Kit Layer Updates

### 1. Thread Models (OrchestrationModels.swift)
✅ **OrchestrationThreadShell**
- Added `settledOverride: String?` field
- Added `settledAt: String?` field
- Updated CodingKeys to include settled fields
- Updated decoder to decode settled fields with defaults

### 2. Thread Status Projection (ThreadStatusProjection.swift)
✅ **T3ProjectedThreadStatus enum**
- Added `.settled` case for settled threads

✅ **ThreadStatusProjection.project() method**
- Added `settledOverride: String?` parameter
- Updated logic to check for `settledOverride == "settled"`
- Returns `.settled` status when explicitly settled

### 3. Command Structures (OrchestrationModels.swift)
✅ **ThreadSettleCommand struct**
- Type: "thread.settle"
- Fields: commandId, threadId
- Proper initialization

✅ **ThreadUnsettleCommand struct**
- Type: "thread.unsettle"
- Fields: commandId, threadId, reason
- Reason defaults to "user" from client

✅ **ClientOrchestrationCommand enum**
- Added `.threadSettle(ThreadSettleCommand)` case
- Added `.threadUnsettle(ThreadUnsettleCommand)` case
- Updated encode method to handle settled commands

### 4. RPC Methods (T3Client.swift)
✅ **settleThread(threadId:)**
- Generates commandId
- Dispatches thread.settle command
- Returns DispatchResult

✅ **unsettleThread(threadId:)**
- Generates commandId
- Dispatches thread.unsettle command with reason: "user"
- Returns DispatchResult

### 5. Backend Integration (LiveBackend.swift)
✅ **ThreadStatusProjection call updated**
- Now passes `settledOverride` parameter
- Properly resolves settled status from thread shell

## 📋 Remaining: SwiftUI Components

### TODO: Sidebar View Updates
- [ ] Add segmented control for Active/Settled filter
- [ ] Filter thread list based on settled state
- [ ] Update thread row styling for settled threads
- [ ] Add settled indicator (SF Symbol)

### TODO: Context Menus
- [ ] Add "Settle Thread" menu item
- [ ] Add "Mark as Active" menu item
- [ ] Wire menu actions to T3Client RPC methods
- [ ] Handle errors gracefully

### TODO: State Management
- [ ] Add filter state (Active/Settled enum)
- [ ] Subscribe to settled state changes
- [ ] Handle optimistic updates
- [ ] Update thread list reactively

### TODO: Visual Design
- [ ] SF Symbol for settled state
- [ ] Color scheme matching SergeCode Alpine glass
- [ ] Subtle settled thread dimming
- [ ] Smooth animations for state transitions

### TODO: Keyboard Shortcuts
- [ ] Cmd+Shift+S to settle selected thread
- [ ] Cmd+Shift+A to activate (unsettle)
- [ ] Register shortcuts in keybinding system

---

## Architecture Notes

### Settled State Flow
1. User clicks "Settle Thread" in context menu
2. UI calls `T3Client.settleThread(threadId:)`
3. T3Client generates commandId and dispatches command
4. Server validates and emits thread.settled event
5. Event propagates through shell subscription
6. ThreadStatusProjection detects settledOverride
7. UI updates to show settled state

### Status Priority
```
Blocked work (approvals, active session) → Active
settledOverride == "settled" → Settled
settledOverride == "active" → Active
Auto-settle rules → Computed
Default → Idle
```

---

## Next Steps

1. Create/update SidebarView.swift with filter control
2. Add context menu for settle/unsettle actions
3. Implement visual indicators for settled threads
4. Add keyboard shortcuts
5. Test full lifecycle with real server

