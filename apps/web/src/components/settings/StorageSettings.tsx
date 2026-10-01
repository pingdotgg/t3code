import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

/**
 * Storage settings panel.
 *
 * Monitoring surface for the worktree cleanup behavior that already exists in
 * this tree (client orphan detection in `worktreeCleanup.ts`, delete intent via
 * `thread.delete { cleanupWorktree }`, archive intent plus durable
 * reconciliation in the server `ThreadDeletionReactor`). Nothing here is
 * configurable yet: cleanup has no setting gate, so every row below is
 * read-only and describes what gets removed and what is always kept.
 */
export function StorageSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsPageHeader
        title="Storage"
        description="How T3 Code reclaims worktrees when threads are deleted or archived. Cleanup is automatic and always on; the rows below describe what gets removed and what is always kept."
      />

      <SettingsSection title="Worktrees">
        <SettingsRow
          title="Delete worktrees with deleted threads"
          description="Deleting a thread removes its worktree once no other thread — active or archived — points at the same path. Branches and thread history are kept."
          status="Always on"
        />
        <SettingsRow
          title="Delete merged worktrees"
          description="Archiving a thread whose pull request has merged schedules its worktree for removal after re-checking live pull request state. Unarchiving the thread cancels pending cleanup; closed-but-unmerged and branch-mismatched worktrees are left alone."
          status="Always on"
        />
      </SettingsSection>

      <SettingsSection title="Always kept">
        <SettingsRow
          title="Project checkout"
          description="The project workspace root (main checkout) is never removed."
        />
        <SettingsRow
          title="Shared worktrees"
          description="A worktree still referenced by another thread is kept until its last thread is gone."
        />
        <SettingsRow
          title="Worktrees with local changes"
          description="Removal never force-deletes: dirty worktrees are left in place for review instead of being removed."
        />
      </SettingsSection>

      <SettingsSection title="Related settings">
        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread, on the General page. Confirming the delete is what triggers worktree cleanup for orphaned worktrees."
        />
        <SettingsRow
          title="Archive confirmation"
          description="Ask before archiving a thread, on the General page. Archiving is what schedules merged-PR worktree cleanup."
        />
        <SettingsRow
          title="Archive review chats on merge"
          description="Move review chats to the archive when their pull request merges, on the General page. Archived merged threads become worktree cleanup candidates."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
