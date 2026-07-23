# T3Code v0.0.29 Nightly Integration Plan for SergeCode

**Date**: July 23, 2026  
**Target Build**: v0.0.29-nightly.20260723.882  
**Estimated Changes**: ~2080 commits since fork

## Executive Summary

This plan outlines the integration of backend improvements and the new SidebarV2 workflow/inbox system from t3code into SergeCode while preserving SergeCode's unique design language and macOS-native architecture.

**Key Integration Areas**:
1. **Backend: Thread Settled Lifecycle** - Server-backed thread state management
2. **Backend: Orchestration Engine Improvements** - Enhanced reliability and performance
3. **Backend: Provider Session Lifecycle** - Stabilized PR status and connection management
4. **Frontend: SidebarV2 System** - Flat thread list with inbox/workflow paradigm
5. **Backend: Remote Server Management** - Standalone service improvements
6. **Performance: Optimized State Synchronization** - Faster updates and offline support

---

## Phase 1: Backend Foundation (Priority: Critical)

### 1.1 Thread Settled Lifecycle System

**Purpose**: Implement server-backed "settled" state for threads, enabling inbox-style workflow where completed threads move out of active view.

**Key Commit**: `32c6012da` - Sidebar v2 beta: flat thread list with a server-backed settled lifecycle

**Changes Required**:

#### Server (apps/server/)
- [ ] **Orchestration Decider** (`src/orchestration/decider.ts`)
  - Add `thread.settle` command handler
  - Add `thread.unsettle` command handler
  - Implement `hasOpenBlockingRequest()` logic
  - Add `QUEUED_TURN_START_GRACE_MS` constant (2min)
  - Validate settled state transitions (no active sessions, no pending approvals)

- [ ] **Orchestration Projector** (`src/orchestration/projector.ts`)
  - Add `thread.settled` event reducer
  - Add `thread.unsettled` event reducer
  - Update thread projection schema with `settledOverride` and `settledAt` fields

- [ ] **Database Migration** (`src/persistence/Migrations/033_ProjectionThreadsSettled.ts`)
  - Add `settledOverride` column (nullable, 'settled' | 'active')
  - Add `settledAt` column (nullable timestamp)
  - Add index on settledOverride for filtering

- [ ] **Projection Pipeline** (`src/orchestration/Layers/ProjectionPipeline.ts`)
  - Add settled state computation based on activities
  - Implement pending approval/input tracking

- [ ] **API Contracts** (`packages/contracts/src/orchestration.ts`)
  - Add `ThreadSettleCommand` schema
  - Add `ThreadUnsettleCommand` schema
  - Add `ThreadSettledEvent` schema
  - Add `ThreadUnsettledEvent` schema

#### Client Runtime (packages/client-runtime/)
- [ ] **Thread Settled State** (`src/state/threadSettled.ts`)
  - Create `effectiveSettled()` atom function
  - Implement `canSettle()` validation logic
  - Add `hasQueuedTurnStart()` detection
  - Add `hasPendingApprovals` / `hasPendingUserInput` tracking

- [ ] **Thread Actions**
  - Add `settleThread()` command
  - Add `unsettleThread()` command
  - Wire to orchestration API

**Testing Requirements**:
- Unit tests for settle/unsettle invariants
- Test cases for blocked settling (active session, pending approvals, queued turns)
- Integration tests for settled state projection

---

### 1.2 Orchestration Engine Stability

**Key Improvements**:
- Clear stale active turns when session becomes inactive
- Handle all SDK stream messages properly
- Improved error handling for provider sessions

**Changes Required**:

- [ ] **Session Lifecycle** (`apps/server/src/orchestration/decider.ts`)
  - Add stale turn detection and clearing logic
  - Improve session status transitions (starting → running → idle)

- [ ] **Provider Integration**
  - Handle EPIPE errors gracefully (commit `f74eb6266`)
  - Isolate capability probes from user MCP servers
  - Stabilize PR status lookups

- [ ] **Error Handling**
  - Route OpenCode missing-session errors through Effect
  - Structure VCS process boundary errors
  - Add better error messages for failed operations

**Testing Requirements**:
- Test session state transitions
- Test stale turn cleanup
- Test error recovery scenarios

---

### 1.3 Remote Server & Connection Management

**Key Commit**: `ab4a88386` - Add remote server updates and standalone service management

**Changes Required**:

- [ ] **Connection Probing** (`packages/client-runtime/`)
  - Implement lightweight connection probe (commit `2640e6dcf`)
  - Add connection status preservation during turn starts

- [ ] **Remote Environment Management**
  - Allow failed remote environments to be removed
  - Improve remote environment lifecycle

- [ ] **Offline Support** (`packages/client-runtime/`)
  - Persist offline environment data (commit `2250e3ee7`)
  - Speed up new-chat propagation and offline catch-up

**Testing Requirements**:
- Test connection probe reliability
- Test offline mode functionality
- Test remote environment cleanup

---

## Phase 2: SidebarV2 & Workflow UI (Priority: High)

### 2.1 Core SidebarV2 Architecture

**Purpose**: Replace traditional sidebar with flat thread list using settled lifecycle for inbox paradigm.

**Key Files**:
- `apps/web/src/components/SidebarV2.tsx` - Main sidebar component
- `apps/web/src/components/Sidebar.logic.ts` - Business logic
- `apps/web/src/sidebarProjectGrouping.ts` - Thread grouping

**Changes Required**:

- [ ] **SidebarV2 Component**
  - Flat thread list (no nested project structure by default)
  - Filter threads by settled state (Active vs. Settled)
  - Thread jump hints with keyboard shortcuts
  - Double-click to rename threads
  - Context menu actions (settle, archive, rename, delete)

- [ ] **Thread Sorting & Filtering**
  - Implement `sortThreadsForSidebarV2()` logic
  - Active threads: sort by activity/unseen
  - Settled threads: sort by settledAt timestamp
  - Filter out archived threads from main view

- [ ] **Thread Status Indicators**
  - Show provider icons
  - Show PR status indicators
  - Show unseen completion badges
  - Show worktree indicators

- [ ] **Keyboard Navigation**
  - Cmd/Ctrl+1-9 for quick thread switching
  - Cmd/Ctrl+K for command palette
  - Cmd/Ctrl+N for new thread
  - Arrow key navigation

**Design Adaptation for SergeCode**:
- Maintain SergeCode's glass/alpine chrome aesthetic
- Use SergeCode color palette and typography
- Keep macOS-native controls where applicable
- Preserve SergeCode's toolbar design language

---

### 2.2 macOS Native Integration

**Purpose**: Adapt SidebarV2 concepts to SergeCode's Swift/macOS architecture.

**Current SergeCode Architecture**:
- Swift-based UI (`apps/mac/Sources/`)
- T3Kit for server communication
- Native macOS controls

**Adaptation Strategy**:

- [ ] **Swift UI Components** (Create new or adapt existing)
  - `ThreadListView.swift` - Main thread list
  - `ThreadRowView.swift` - Individual thread row
  - `ThreadContextMenu.swift` - Right-click actions
  - `ThreadStatusBadge.swift` - Status indicators

- [ ] **T3Kit Extensions** (`apps/mac/Sources/T3Kit/`)
  - Add `settleThread()` RPC method
  - Add `unsettleThread()` RPC method
  - Extend `ThreadStatusProjection` with settled state
  - Update `ServerModels.swift` with new fields

- [ ] **State Management**
  - Subscribe to settled state changes via RPC
  - Update thread list reactively
  - Handle optimistic UI updates

- [ ] **Visual Design**
  - Use SF Symbols for thread status icons
  - Maintain Alpine glass effects
  - Apply SergeCode color scheme
  - Use native macOS list/outline views

**Testing Requirements**:
- Test thread list rendering performance
- Test keyboard shortcuts
- Test context menu actions
- Test settled state UI updates

---

### 2.3 Thread Actions & Context Menus

**Changes Required**:

- [ ] **Context Menu Actions**
  - Settle/Unsettle thread
  - Archive thread
  - Rename thread (double-click alternative)
  - Delete thread
  - Copy link
  - Open in new window (macOS-specific)

- [ ] **Bulk Actions**
  - Select multiple threads
  - Settle all completed threads
  - Archive selected threads

- [ ] **Keyboard Shortcuts**
  - Map t3code shortcuts to macOS conventions
  - Register with SergeCode's keybinding system

---

## Phase 3: Performance & Polish (Priority: Medium)

### 3.1 State Synchronization Optimization

**Key Improvements**:
- Defer active thread cache writes (commit `765e1b5fc`)
- Speed up new-chat propagation (commit `db4b2d8a0`)
- Normalize sidebar thread state for faster updates (commit `ae6f9715c`)

**Changes Required**:

- [ ] **Client-Side Caching**
  - Implement deferred cache writes
  - Optimize thread shell subscriptions
  - Warm sidebar thread detail subscriptions

- [ ] **Reduce Re-renders**
  - Memoize thread list items
  - Use auto-animate for smooth transitions
  - Optimize thread status computation

---

### 3.2 UI Polish & Animations

**Key Improvements**:
- Stabilize sidebar settling animations (commit `18b468871`)
- Glass surface opacity controls
- Dark mode refinements

**Changes Required**:

- [ ] **Animation System**
  - Smooth thread transitions when settling
  - Fade animations for status changes
  - Native macOS spring animations

- [ ] **Visual Refinements**
  - Light mode sidebar surfaces (commit `593289c3c`)
  - Glass opacity slider
  - Thread tooltip improvements

---

## Phase 4: Additional Backend Features (Priority: Low)

### 4.1 Enhanced Git & VCS

**Improvements**:
- Prevent silent thread branch drift (commit `2d31cb022`)
- Stabilize PR status lookups (commit `376c149ea`)
- Preserve worktree metadata during branch sync (commit `3201e00ad`)

**Changes Required**:

- [ ] **Git Integration**
  - Improve PR status resolution
  - Better worktree branch tracking
  - Sticky PR fallback handling

---

### 4.2 Provider & Model Improvements

**Key Changes**:
- Better defaults: Claude 1M context, Codex gpt-5.6 (commit `62cf46175`)
- Worktrees from origin main by default
- Preserve custom model slugs (commit `fa69f05b6`)

**Changes Required**:

- [ ] **Model Defaults**
  - Update default context sizes
  - Update default models per provider
  - Preserve user customizations

---

## Implementation Strategy

### Approach

**Hybrid Parallel + Sequential**:
1. Backend changes can proceed in parallel with frontend exploration
2. Frontend implementation depends on backend APIs being available
3. Testing happens continuously throughout

### Recommended Execution

**Stage 1: Backend Foundation** (Week 1-2)
- Implement thread settled lifecycle (server + client-runtime)
- Add database migrations
- Deploy and test API contracts
- Run full integration tests

**Stage 2: Client Runtime Integration** (Week 2-3)
- Integrate settled state tracking
- Add thread action commands
- Test with web app first (faster iteration)
- Validate state management

**Stage 3: macOS UI Adaptation** (Week 3-4)
- Design Swift UI components
- Implement thread list view
- Add context menus and shortcuts
- Apply SergeCode design language

**Stage 4: Polish & Performance** (Week 4-5)
- Optimize rendering performance
- Add animations
- Test edge cases
- User acceptance testing

---

## Design Language Preservation

### SergeCode Identity to Maintain

1. **Alpine Glass Chrome**
   - Translucent toolbar backgrounds
   - Glass effects with controlled opacity
   - Native macOS vibrancy

2. **Typography & Spacing**
   - SF Pro system font
   - Consistent padding/margins
   - Native macOS text rendering

3. **Color Palette**
   - SergeCode brand colors
   - Dark/light mode adaptations
   - Accent colors for states

4. **Interaction Patterns**
   - macOS-standard gestures
   - Native context menus
   - System keyboard shortcuts

### t3code Elements to Adapt

1. **Flat Thread List** - Adapt layout, keep SergeCode styling
2. **Settled State Logic** - Use unchanged (backend)
3. **Quick Jump Shortcuts** - Map to macOS conventions
4. **Status Indicators** - Redesign with SF Symbols

---

## Risk Assessment & Mitigation

### High Risk Areas

1. **Database Migration** (settled columns)
   - **Mitigation**: Test on staging first, backup strategy, rollback plan
   - **Validation**: Run migration on production clone

2. **State Synchronization** (settled lifecycle)
   - **Mitigation**: Extensive integration tests, canary rollout
   - **Validation**: Monitor error rates and performance metrics

3. **UI/UX Disruption** (sidebar redesign)
   - **Mitigation**: Feature flag, gradual rollout, user feedback loop
   - **Validation**: Beta testing with select users

### Medium Risk Areas

1. **Performance Regression**
   - **Mitigation**: Benchmark before/after, profile hot paths
   - **Validation**: Load testing with realistic data

2. **Keyboard Shortcut Conflicts**
   - **Mitigation**: Audit existing shortcuts, provide customization
   - **Validation**: Manual testing of all shortcuts

### Low Risk Areas

1. **Visual Polish** - Iterative improvements, low user impact
2. **Model Defaults** - Easy to adjust, well-tested upstream

---

## Testing Strategy

### Unit Tests
- [ ] Thread settled state logic
- [ ] Command invariants (settle/unsettle)
- [ ] Thread sorting algorithms
- [ ] Status indicator resolution

### Integration Tests
- [ ] Settled lifecycle end-to-end
- [ ] Thread list updates on state changes
- [ ] RPC communication (Swift ↔ Node)
- [ ] Offline mode behavior

### UI Tests
- [ ] Thread list rendering
- [ ] Context menu actions
- [ ] Keyboard navigation
- [ ] Animation smoothness

### Manual Testing
- [ ] Settle/unsettle workflow
- [ ] Thread filtering (active vs settled)
- [ ] Multi-window behavior (macOS)
- [ ] Dark/light mode switching
- [ ] Performance with 100+ threads

---

## Success Criteria

### Backend Integration
- ✅ All settled lifecycle tests passing
- ✅ Zero data loss in migration
- ✅ API response time < 100ms
- ✅ Offline mode working reliably

### Frontend Integration
- ✅ Thread list renders in < 50ms
- ✅ Smooth animations (60fps)
- ✅ All keyboard shortcuts working
- ✅ Context menus fully functional

### Design Language
- ✅ Maintains SergeCode visual identity
- ✅ Passes accessibility audit
- ✅ Consistent with macOS HIG
- ✅ User feedback score > 4/5

### Performance
- ✅ No regressions vs current version
- ✅ Memory usage stable
- ✅ CPU usage < 5% idle
- ✅ Startup time unchanged

---

## Rollout Plan

### Phase 1: Internal Testing
- Deploy to development environment
- Team dogfooding (1 week)
- Fix critical bugs

### Phase 2: Beta Testing
- Deploy behind feature flag
- Invite beta users (50-100)
- Collect feedback (2 weeks)

### Phase 3: Gradual Rollout
- Enable for 10% of users
- Monitor metrics (1 week)
- Increase to 50% (1 week)
- Full rollout (1 week)

### Phase 4: Cleanup
- Remove old code paths
- Remove feature flags
- Update documentation

---

## Open Questions

1. **Settled State UI Location**: Separate tabs/sections or inline filtering?
   - **Recommendation**: Segmented control (Active | Settled) at top of sidebar

2. **Default Settling Behavior**: Auto-settle on completion or manual only?
   - **Recommendation**: Manual initially, add auto-settle as optional setting

3. **Thread Grouping**: Keep project grouping as option or force flat list?
   - **Recommendation**: Flat by default, add grouping as user preference

4. **Migration Timing**: Require app restart or hot-migrate?
   - **Recommendation**: Restart required for safety

5. **Backward Compatibility**: Support reverting to old sidebar?
   - **Recommendation**: Yes, via feature flag for first month

---

## Timeline Estimate

**Total Duration**: 5-6 weeks

- **Week 1**: Backend foundation (settled lifecycle)
- **Week 2**: Client runtime integration + testing
- **Week 3**: macOS UI components (SidebarV2 adaptation)
- **Week 4**: Polish, animations, edge cases
- **Week 5**: Beta testing & feedback incorporation
- **Week 6**: Gradual rollout & monitoring

**Team Allocation**:
- 1 Backend Engineer (orchestration, database)
- 1 Frontend Engineer (client-runtime, state management)
- 1 macOS Engineer (Swift UI, native integration)
- 1 Designer (visual adaptation, prototyping)
- 1 QA Engineer (testing, validation)

---

## Next Steps

1. **Review & Approve Plan**: Stakeholder sign-off on approach
2. **Set Up Development Branch**: Create `feat/t3code-integration` branch
3. **Clone t3code Nightly**: Set up local reference for diffing
4. **Create Tracking Issues**: One per major feature area
5. **Begin Phase 1**: Start with backend foundation
6. **Weekly Check-ins**: Review progress and adjust plan

---

## Appendix: Key Commits Reference

| Commit | Description | Priority |
|--------|-------------|----------|
| `32c6012da` | Sidebar v2 beta: flat thread list with settled lifecycle | Critical |
| `ab4a88386` | Remote server updates and standalone service management | High |
| `db4b2d8a0` | Speed up new-chat propagation and offline catch-up | High |
| `62cf46175` | Better defaults: Claude 1M context, Codex gpt-5.6 | Medium |
| `2d31cb022` | Prevent silent thread branch drift and PR fetching | Medium |
| `765e1b5fc` | Defer active thread cache writes | Medium |
| `18b468871` | Stabilize sidebar settling animations | Low |
| `593289c3c` | Refine light-mode sidebar surfaces | Low |

---

## Contact & Resources

**t3code Repository**: https://github.com/pingdotgg/t3code  
**Target Build**: v0.0.29-nightly.20260723.882  
**Build Commit**: `b44ed835c`

**Key Documentation**:
- t3code API contracts: `packages/contracts/src/orchestration.ts`
- Thread settled logic: `packages/client-runtime/src/state/threadSettled.ts`
- SidebarV2 component: `apps/web/src/components/SidebarV2.tsx`
- Orchestration decider: `apps/server/src/orchestration/decider.ts`
