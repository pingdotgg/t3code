export const storageResources = {
  en: {
    worktrees: "Worktrees",
    automaticWorktreeCleanup: "Automatic worktree cleanup",
    keepUntilManuallyDeleted: "Keep this project’s worktrees until you delete them manually.",
    useProjectRules: "Use these rules for this project.",
    inheritMachineRules: "Use each machine’s worktree cleanup settings.",
    mixed: "Mixed",
    inherit: "Inherit",
    off: "Off",
    custom: "Custom",
    deleteWorktreesWithDeletedThreads: "Delete worktrees with deleted threads",
    deleteWorktreesWithDeletedThreadsDescription:
      "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
    deleteInactiveWorktrees: "Delete inactive worktrees",
    deleteInactiveWorktreesDescription:
      "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
    deleteMergedWorktrees: "Delete merged worktrees",
    deleteMergedWorktreesDescription:
      "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
    deleteUnchangedWorktrees: "Delete unchanged worktrees",
    deleteUnchangedWorktreesDescription:
      "Remove worktrees with no commits beyond the default branch.",
    artifactsAndLogs: "Artifacts and logs",
    deleteOldBrowserArtifacts: "Delete old browser artifacts",
    deleteOldBrowserArtifactsDescription:
      "Delete saved browser captures after this many days. Older capture links will no longer open.",
    deleteOldRotatedLogs: "Delete old rotated logs",
    deleteOldRotatedLogsDescription:
      "Delete inactive rotated log files after this many days. Current logs are kept.",
    days: "days",
    mixedAcrossMachines: "Mixed across selected machines",
    updateMachinesForProjectCleanup:
      "Update the selected machines to configure project worktree cleanup.",
    updateEnvironmentsForStorageCleanup:
      "Update the selected environments to use storage cleanup, or choose a machine that supports it.",
    labelDays: "{{label}} in days",
    decrease: "Decrease {{label}}",
    increase: "Increase {{label}}",
  },
  "zh-CN": {
    worktrees: "工作树",
    automaticWorktreeCleanup: "自动清理工作树",
    keepUntilManuallyDeleted: "保留此项目的工作树，直到你手动删除。",
    useProjectRules: "使用此项目的清理规则。",
    inheritMachineRules: "使用各台机器的工作树清理设置。",
    mixed: "不一致",
    inherit: "继承",
    off: "关闭",
    custom: "自定义",
    deleteWorktreesWithDeletedThreads: "删除会话时一并删除工作树",
    deleteWorktreesWithDeletedThreadsDescription:
      "删除活动或已归档会话时，清理未使用的工作树。包含本地修改的工作树会保留。",
    deleteInactiveWorktrees: "删除长期未活动的工作树",
    deleteInactiveWorktreesDescription:
      "会话在此天数内没有活动后，删除对应工作树。分支和会话历史会保留。",
    deleteMergedWorktrees: "删除已合并的工作树",
    deleteMergedWorktreesDescription: "拉取请求已合并且提交已包含在默认分支中时，删除对应工作树。",
    deleteUnchangedWorktrees: "删除未产生提交的工作树",
    deleteUnchangedWorktreesDescription: "删除没有比默认分支多出提交的工作树。",
    artifactsAndLogs: "产物与日志",
    deleteOldBrowserArtifacts: "删除旧浏览器录制文件",
    deleteOldBrowserArtifactsDescription:
      "在指定天数后删除已保存的浏览器录制文件。旧录制链接将无法再打开。",
    deleteOldRotatedLogs: "删除旧轮转日志",
    deleteOldRotatedLogsDescription: "在指定天数后删除不活动的轮转日志文件。当前日志会保留。",
    days: "天",
    mixedAcrossMachines: "所选机器的设置不一致",
    updateMachinesForProjectCleanup: "更新所选机器以配置项目工作树清理。",
    updateEnvironmentsForStorageCleanup: "更新所选环境以使用存储清理，或选择支持此功能的机器。",
    labelDays: "{{label}}（天）",
    decrease: "减少{{label}}",
    increase: "增加{{label}}",
  },
} as const;
