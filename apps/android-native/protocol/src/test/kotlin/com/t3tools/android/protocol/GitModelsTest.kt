package com.t3tools.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray

class GitModelsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun reduces_split_status_stream_without_losing_the_other_half() {
    val snapshot = json.parseToJsonElement(
      """{"_tag":"snapshot","local":{"isRepo":true,"hasPrimaryRemote":true,"isDefaultRef":false,"refName":"feature/native","hasWorkingTreeChanges":true,"workingTree":{"files":[{"path":"App.kt","insertions":3,"deletions":1}],"insertions":3,"deletions":1}},"remote":{"hasUpstream":true,"aheadCount":2,"behindCount":0,"aheadOfDefaultCount":2,"pr":null}}""",
    ).toVcsStatusEvent()
    val localUpdate = json.parseToJsonElement(
      """{"_tag":"localUpdated","local":{"isRepo":true,"hasPrimaryRemote":true,"isDefaultRef":false,"refName":"feature/native","hasWorkingTreeChanges":false,"workingTree":{"files":[],"insertions":0,"deletions":0}}}""",
    ).toVcsStatusEvent()
    val remoteUpdate = json.parseToJsonElement(
      """{"kind":"remoteUpdated","remote":{"hasUpstream":true,"aheadCount":0,"behindCount":1,"pr":{"number":42,"title":"Native Git","url":"https://example.com/pr/42","baseRef":"main","headRef":"feature/native","state":"open"}}}""",
    ).toVcsStatusEvent()

    val afterSnapshot = reduceVcsStatus(null, snapshot)
    val afterLocal = reduceVcsStatus(afterSnapshot, localUpdate)
    val result = reduceVcsStatus(afterLocal, remoteUpdate)

    assertFalse(requireNotNull(result).hasWorkingTreeChanges)
    assertEquals(1, result.behindCount)
    assertEquals(42, result.pullRequest?.number)
    assertEquals("feature/native", result.refName)
  }

  @Test
  fun decodes_refs_worktree_pull_and_progress_results() {
    val refs = json.parseToJsonElement(
      """{"refs":[{"name":"main","current":true,"isDefault":true,"worktreePath":"/repo"}],"isRepo":true,"hasPrimaryRemote":true,"nextCursor":null,"totalCount":1}""",
    ).toVcsRefs()
    val worktree = json.parseToJsonElement(
      """{"worktree":{"path":"/repo-worktrees/native","refName":"feature/native"}}""",
    ).toVcsWorktree()
    val pull = json.parseToJsonElement(
      """{"status":"pulled","refName":"feature/native","upstreamRef":"origin/feature/native"}""",
    ).toVcsPullResult()
    val progress = json.parseToJsonElement(
      """{"actionId":"action-1","cwd":"/repo","action":"commit_push_pr","kind":"action_finished","result":{"action":"commit_push_pr","branch":{"status":"created","name":"native-git"},"commit":{"status":"created","commitSha":"abc","subject":"Native Git"},"push":{"status":"pushed"},"pr":{"status":"created","url":"https://example.com/pr/7"},"toast":{"title":"Pull request created","cta":{"kind":"open_pr","label":"Open PR","url":"https://example.com/pr/7"}}}}""",
    ).toGitActionProgressEvent()

    assertTrue(refs.refs.single().current)
    assertNull(refs.nextCursor)
    assertEquals("feature/native", worktree.refName)
    assertEquals("origin/feature/native", pull.upstreamRef)
    val finished = assertIs<GitActionProgressEvent.ActionFinished>(progress)
    assertEquals("native-git", finished.result.branchName)
    assertEquals("https://example.com/pr/7", finished.result.prUrl)
  }

  @Test
  fun builds_selective_stacked_action_and_worktree_wire_shapes() {
    val action = gitActionPayload(
      actionId = "action-1",
      cwd = "/repo",
      action = GitStackedAction.Commit,
      commitMessage = "Native Git",
      featureBranch = true,
      filePaths = listOf("App.kt", "Git.kt"),
    )
    val worktree = vcsCreateWorktreePayload("/repo", "main", "feature/native")
    val refs = vcsRefsPayload("/repo", query = "native", cursor = 100, refresh = true)
    val metadata = updateThreadGitContextCommand(
      threadId = "thread-1",
      branch = "feature/native",
      worktreePath = "/repo-worktrees/native",
      expectedBranch = "main",
      commandId = "command-1",
    )

    assertEquals(JsonPrimitive("commit"), action["action"])
    assertEquals(listOf("App.kt", "Git.kt"), action["filePaths"]!!.jsonArray.map { it.toString().trim('"') })
    assertEquals(JsonPrimitive(true), action["featureBranch"])
    assertEquals(JsonNull, worktree["path"])
    assertEquals(JsonPrimitive("native"), refs["query"])
    assertEquals(JsonPrimitive(100), refs["cursor"])
    assertEquals(JsonPrimitive(true), refs["refresh"])
    assertEquals(JsonPrimitive("thread.meta.update"), metadata["type"])
    assertEquals(JsonPrimitive("main"), metadata["expectedBranch"])
  }
}
