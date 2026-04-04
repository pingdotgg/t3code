# Plan: Fix Misleading Error Message When Project Directory is Moved/Deleted

## Issue Summary
When a user creates a project in T3 Code and then renames/moves/deletes the project directory externally (via terminal or file explorer), the error message displayed is misleading:

- **Expected**: "path could not be found" or similar clear message about the missing project directory
- **Actual**: "Claude Code native binary not found at claude. Please ensure Claude Code is installed..."

This causes confusion because users think Claude Code is not installed when the actual issue is the project directory no longer exists.

## Root Cause Analysis

1. **Path Resolution Flow**:
   - When sending a message to Claude, the system resolves the workspace root from the project database
   - The database stores the original workspace root path (e.g., `/home/user/my-project`)
   - When the directory is renamed/moved, the stored path still points to the old location

2. **Error Handling Gap**:
   - `resolveThreadWorkspaceCwd()` in `checkpointing/Utils.ts` retrieves the stored workspace root
   - This path is passed as `cwd` to `ProviderService.startSession()`
   - In `ClaudeAdapter.ts`, this `cwd` is passed to the Claude SDK via `pathToClaudeCodeExecutable`
   - When the directory doesn't exist, the SDK fails with "native binary not found" instead of detecting the path issue

3. **Missing Validation**:
   - The system never validates that the workspace root exists before attempting to start a provider session
   - There is no early check to detect if the project directory has been moved/deleted

## Solution

Add workspace root existence validation in `ProviderCommandReactor.ts` before starting a provider session. This ensures a clear, accurate error message is shown when the project directory is missing.

### Changes Made

**File**: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`

1. Added imports:
   - `FileSystem` from "effect"
   - `Result` from "effect"

2. Added validation block after resolving `effectiveCwd`:
   ```typescript
   // Validate that the workspace root exists before attempting to start a session
   if (effectiveCwd) {
     const pathExists = yield* FileSystem.FileSystem.pipe(
       Effect.flatMap((fs) => fs.stat(effectiveCwd)),
       Effect.map(() => true),
       Effect.catchTag("SystemError", (e) =>
         e.reason === "NotFound" ? Effect.succeed(false) : Effect.fail(e),
       ),
       Effect.result,
     );
     if (Result.isFailure(pathExists) || pathExists.success === Option.none()) {
       return yield* new ProviderAdapterRequestError({
         provider: preferredProvider ?? "claudeAgent",
         method: "thread.turn.start",
         detail: `Project workspace path '${effectiveCwd}' no longer exists. The project directory may have been moved or deleted. Please recreate the project or select a different project.`,
       });
     }
   }
   ```

## Expected Result

After this fix, when a user sends a message after the project directory has been moved/deleted:
- Clear error: "Project workspace path '/path/to/project' no longer exists. The project directory may have been moved or deleted. Please recreate the project or select a different project."
- Instead of: "Claude Code native binary not found..."

## Test Verification

To verify the fix works:
1. Start T3 Code desktop app
2. Create a new project
3. Rename the project directory via terminal/file explorer
4. Begin a new chat and send a message to Claude
5. Verify the error message is now about the missing path, not the missing Claude binary