package com.t3tools.android.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

data class VcsChangedFile(val path: String, val insertions: Int, val deletions: Int)

data class VcsWorkingTree(
  val files: List<VcsChangedFile>,
  val insertions: Int,
  val deletions: Int,
)

data class VcsPullRequest(
  val number: Int,
  val title: String,
  val url: String,
  val baseRef: String,
  val headRef: String,
  val state: String,
)

data class VcsStatus(
  val isRepo: Boolean,
  val hasPrimaryRemote: Boolean,
  val isDefaultRef: Boolean,
  val refName: String?,
  val hasWorkingTreeChanges: Boolean,
  val workingTree: VcsWorkingTree,
  val hasUpstream: Boolean = false,
  val aheadCount: Int = 0,
  val behindCount: Int = 0,
  val aheadOfDefaultCount: Int? = null,
  val pullRequest: VcsPullRequest? = null,
)

sealed interface VcsStatusEvent {
  data class Snapshot(val local: VcsStatus, val remote: VcsRemoteStatus?) : VcsStatusEvent
  data class LocalUpdated(val local: VcsStatus) : VcsStatusEvent
  data class RemoteUpdated(val remote: VcsRemoteStatus?) : VcsStatusEvent
}

data class VcsRemoteStatus(
  val hasUpstream: Boolean,
  val aheadCount: Int,
  val behindCount: Int,
  val aheadOfDefaultCount: Int?,
  val pullRequest: VcsPullRequest?,
)

data class VcsRef(
  val name: String,
  val isRemote: Boolean,
  val remoteName: String?,
  val current: Boolean,
  val isDefault: Boolean,
  val worktreePath: String?,
)

data class VcsRefs(
  val refs: List<VcsRef>,
  val isRepo: Boolean,
  val hasPrimaryRemote: Boolean,
  val nextCursor: Int?,
  val totalCount: Int,
)

data class VcsWorktree(val path: String, val refName: String)
data class VcsPullResult(val status: String, val refName: String, val upstreamRef: String?)

enum class GitStackedAction(val wireValue: String) {
  Commit("commit"),
  Push("push"),
  CreatePr("create_pr"),
  CommitPush("commit_push"),
  CommitPushPr("commit_push_pr"),
  ;

  companion object {
    fun fromWire(value: String) = entries.firstOrNull { it.wireValue == value }
      ?: error("Unknown Git action: $value")
  }
}

data class GitActionResult(
  val action: GitStackedAction,
  val branchStatus: String,
  val branchName: String?,
  val commitStatus: String,
  val commitSha: String?,
  val pushStatus: String,
  val prStatus: String,
  val prUrl: String?,
  val title: String,
  val description: String?,
)

sealed interface GitActionProgressEvent {
  val actionId: String
  val cwd: String
  val action: GitStackedAction

  data class ActionStarted(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val phases: List<String>,
  ) : GitActionProgressEvent

  data class PhaseStarted(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val phase: String,
    val label: String,
  ) : GitActionProgressEvent

  data class HookStarted(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val hookName: String,
  ) : GitActionProgressEvent

  data class HookOutput(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val hookName: String?,
    val stream: String,
    val text: String,
  ) : GitActionProgressEvent

  data class HookFinished(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val hookName: String,
    val exitCode: Int?,
    val durationMs: Long?,
  ) : GitActionProgressEvent

  data class ActionFinished(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val result: GitActionResult,
  ) : GitActionProgressEvent

  data class ActionFailed(
    override val actionId: String,
    override val cwd: String,
    override val action: GitStackedAction,
    val phase: String?,
    val message: String,
  ) : GitActionProgressEvent
}

fun reduceVcsStatus(current: VcsStatus?, event: VcsStatusEvent): VcsStatus? = when (event) {
  is VcsStatusEvent.Snapshot -> event.local.withRemote(event.remote)
  is VcsStatusEvent.LocalUpdated -> event.local.withRemote(current?.remote())
  is VcsStatusEvent.RemoteUpdated -> current?.withRemote(event.remote)
}

private fun VcsStatus.remote() = VcsRemoteStatus(
  hasUpstream = hasUpstream,
  aheadCount = aheadCount,
  behindCount = behindCount,
  aheadOfDefaultCount = aheadOfDefaultCount,
  pullRequest = pullRequest,
)

private fun VcsStatus.withRemote(remote: VcsRemoteStatus?) = copy(
  hasUpstream = remote?.hasUpstream ?: false,
  aheadCount = remote?.aheadCount ?: 0,
  behindCount = remote?.behindCount ?: 0,
  aheadOfDefaultCount = remote?.aheadOfDefaultCount,
  pullRequest = remote?.pullRequest,
)

internal fun vcsStatusPayload(cwd: String) = buildJsonObject("cwd" to JsonPrimitive(cwd))

internal fun vcsRefsPayload(
  cwd: String,
  query: String? = null,
  cursor: Int? = null,
  refresh: Boolean = false,
  limit: Int = 100,
) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "query" to query?.takeIf(String::isNotBlank)?.let(::JsonPrimitive),
  "cursor" to cursor?.let(::JsonPrimitive),
  "refresh" to JsonPrimitive(refresh),
  "limit" to JsonPrimitive(limit),
)

internal fun vcsCreateRefPayload(cwd: String, refName: String) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "refName" to JsonPrimitive(refName),
  "switchRef" to JsonPrimitive(true),
)

internal fun vcsSwitchRefPayload(cwd: String, refName: String) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "refName" to JsonPrimitive(refName),
)

internal fun vcsCreateWorktreePayload(cwd: String, baseRef: String, newRef: String) = buildJsonObject(
  "cwd" to JsonPrimitive(cwd),
  "refName" to JsonPrimitive(baseRef),
  "newRefName" to JsonPrimitive(newRef),
  "path" to JsonNull,
)

internal fun gitActionPayload(
  actionId: String,
  cwd: String,
  action: GitStackedAction,
  commitMessage: String? = null,
  featureBranch: Boolean = false,
  filePaths: List<String>? = null,
) = buildJsonObject(
  "actionId" to JsonPrimitive(actionId),
  "cwd" to JsonPrimitive(cwd),
  "action" to JsonPrimitive(action.wireValue),
  "commitMessage" to commitMessage?.trim()?.takeIf(String::isNotEmpty)?.let(::JsonPrimitive),
  "featureBranch" to featureBranch.takeIf { it }?.let(::JsonPrimitive),
  "filePaths" to filePaths?.takeIf(List<String>::isNotEmpty)
    ?.let { JsonArray(it.map(::JsonPrimitive)) },
)

internal fun JsonElement.toVcsStatusEvent(): VcsStatusEvent {
  val value = jsonObject
  val tag = value.stringOrNull("_tag") ?: value.stringOrNull("kind")
    ?: error("Response is missing VCS status event type.")
  return when (tag) {
    "snapshot" -> VcsStatusEvent.Snapshot(
      local = value.required("local").toVcsLocalStatus(),
      remote = value["remote"].toRemoteStatusOrNull(),
    )
    "localUpdated" -> VcsStatusEvent.LocalUpdated(value.required("local").toVcsLocalStatus())
    "remoteUpdated" -> VcsStatusEvent.RemoteUpdated(value["remote"].toRemoteStatusOrNull())
    else -> error("Unknown VCS status event: $tag")
  }
}

internal fun JsonElement.toVcsStatus(): VcsStatus {
  val value = jsonObject
  return value.toLocalStatus().withRemote(value.toRemoteStatus())
}

private fun JsonElement.toVcsLocalStatus() = jsonObject.toLocalStatus()

private fun JsonObject.toLocalStatus(): VcsStatus {
  val tree = required("workingTree").jsonObject
  return VcsStatus(
    isRepo = required("isRepo").jsonPrimitive.booleanOrNull == true,
    hasPrimaryRemote = required("hasPrimaryRemote").jsonPrimitive.booleanOrNull == true,
    isDefaultRef = required("isDefaultRef").jsonPrimitive.booleanOrNull == true,
    refName = nullableString("refName"),
    hasWorkingTreeChanges = required("hasWorkingTreeChanges").jsonPrimitive.booleanOrNull == true,
    workingTree = VcsWorkingTree(
      files = tree.required("files").jsonArray.map { item ->
        val file = item.jsonObject
        VcsChangedFile(
          path = file.required("path").jsonPrimitive.content,
          insertions = file.required("insertions").jsonPrimitive.int,
          deletions = file.required("deletions").jsonPrimitive.int,
        )
      },
      insertions = tree.required("insertions").jsonPrimitive.int,
      deletions = tree.required("deletions").jsonPrimitive.int,
    ),
  )
}

private fun JsonElement?.toRemoteStatusOrNull() =
  if (this == null || this is JsonNull) null else jsonObject.toRemoteStatus()

private fun JsonObject.toRemoteStatus() = VcsRemoteStatus(
  hasUpstream = required("hasUpstream").jsonPrimitive.booleanOrNull == true,
  aheadCount = required("aheadCount").jsonPrimitive.int,
  behindCount = required("behindCount").jsonPrimitive.int,
  aheadOfDefaultCount = this["aheadOfDefaultCount"]?.jsonPrimitive?.intOrNull,
  pullRequest = this["pr"].toPullRequestOrNull(),
)

private fun JsonElement?.toPullRequestOrNull(): VcsPullRequest? {
  if (this == null || this is JsonNull) return null
  val value = jsonObject
  return VcsPullRequest(
    number = value.required("number").jsonPrimitive.int,
    title = value.required("title").jsonPrimitive.content,
    url = value.required("url").jsonPrimitive.content,
    baseRef = value.required("baseRef").jsonPrimitive.content,
    headRef = value.required("headRef").jsonPrimitive.content,
    state = value.required("state").jsonPrimitive.content,
  )
}

internal fun JsonElement.toVcsRefs(): VcsRefs {
  val value = jsonObject
  return VcsRefs(
    refs = value.required("refs").jsonArray.map { item ->
      val ref = item.jsonObject
      VcsRef(
        name = ref.required("name").jsonPrimitive.content,
        isRemote = ref["isRemote"]?.jsonPrimitive?.booleanOrNull == true,
        remoteName = ref.nullableString("remoteName"),
        current = ref.required("current").jsonPrimitive.booleanOrNull == true,
        isDefault = ref.required("isDefault").jsonPrimitive.booleanOrNull == true,
        worktreePath = ref.nullableString("worktreePath"),
      )
    },
    isRepo = value.required("isRepo").jsonPrimitive.booleanOrNull == true,
    hasPrimaryRemote = value.required("hasPrimaryRemote").jsonPrimitive.booleanOrNull == true,
    nextCursor = value["nextCursor"]?.jsonPrimitive?.intOrNull,
    totalCount = value.required("totalCount").jsonPrimitive.int,
  )
}

internal fun JsonElement.toVcsWorktree(): VcsWorktree {
  val value = jsonObject.required("worktree").jsonObject
  return VcsWorktree(
    path = value.required("path").jsonPrimitive.content,
    refName = value.required("refName").jsonPrimitive.content,
  )
}

internal fun JsonElement.toVcsPullResult(): VcsPullResult {
  val value = jsonObject
  return VcsPullResult(
    status = value.required("status").jsonPrimitive.content,
    refName = value.required("refName").jsonPrimitive.content,
    upstreamRef = value.nullableString("upstreamRef"),
  )
}

internal fun JsonElement.toGitActionProgressEvent(): GitActionProgressEvent {
  val value = jsonObject
  val actionId = value.required("actionId").jsonPrimitive.content
  val cwd = value.required("cwd").jsonPrimitive.content
  val action = GitStackedAction.fromWire(value.required("action").jsonPrimitive.content)
  return when (value.required("kind").jsonPrimitive.content) {
    "action_started" -> GitActionProgressEvent.ActionStarted(
      actionId, cwd, action, value.required("phases").jsonArray.map { it.jsonPrimitive.content },
    )
    "phase_started" -> GitActionProgressEvent.PhaseStarted(
      actionId, cwd, action,
      value.required("phase").jsonPrimitive.content,
      value.required("label").jsonPrimitive.content,
    )
    "hook_started" -> GitActionProgressEvent.HookStarted(
      actionId, cwd, action, value.required("hookName").jsonPrimitive.content,
    )
    "hook_output" -> GitActionProgressEvent.HookOutput(
      actionId, cwd, action,
      value.nullableString("hookName"),
      value.required("stream").jsonPrimitive.content,
      value.required("text").jsonPrimitive.content,
    )
    "hook_finished" -> GitActionProgressEvent.HookFinished(
      actionId, cwd, action,
      value.required("hookName").jsonPrimitive.content,
      value["exitCode"]?.jsonPrimitive?.intOrNull,
      value["durationMs"]?.jsonPrimitive?.longOrNull,
    )
    "action_finished" -> GitActionProgressEvent.ActionFinished(
      actionId, cwd, action, value.required("result").toGitActionResult(),
    )
    "action_failed" -> GitActionProgressEvent.ActionFailed(
      actionId, cwd, action,
      value.nullableString("phase"),
      value.required("message").jsonPrimitive.content,
    )
    else -> error("Unknown Git progress event: ${value["kind"]}")
  }
}

private fun JsonElement.toGitActionResult(): GitActionResult {
  val value = jsonObject
  val branch = value.required("branch").jsonObject
  val commit = value.required("commit").jsonObject
  val push = value.required("push").jsonObject
  val pr = value.required("pr").jsonObject
  val toast = value.required("toast").jsonObject
  val cta = toast.required("cta").jsonObject
  return GitActionResult(
    action = GitStackedAction.fromWire(value.required("action").jsonPrimitive.content),
    branchStatus = branch.required("status").jsonPrimitive.content,
    branchName = branch.stringOrNull("name"),
    commitStatus = commit.required("status").jsonPrimitive.content,
    commitSha = commit.stringOrNull("commitSha"),
    pushStatus = push.required("status").jsonPrimitive.content,
    prStatus = pr.required("status").jsonPrimitive.content,
    prUrl = if (cta.stringOrNull("kind") == "open_pr") cta.stringOrNull("url") else pr.stringOrNull("url"),
    title = toast.required("title").jsonPrimitive.content,
    description = toast.stringOrNull("description"),
  )
}

private fun JsonObject.nullableString(name: String) = this[name]
  ?.takeUnless { it is JsonNull }
  ?.jsonPrimitive
  ?.content
