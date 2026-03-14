import type { SharedSkillsConfigInput } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const sharedSkillsQueryKeys = {
  all: ["server", "shared-skills"] as const,
  detail: (input: SharedSkillsConfigInput) =>
    ["server", "shared-skills", input.codexHomePath ?? "", input.sharedSkillsPath ?? ""] as const,
  skillDetail: (input: SharedSkillsConfigInput, skillName: string | null) =>
    [
      "server",
      "shared-skills",
      "detail",
      input.codexHomePath ?? "",
      input.sharedSkillsPath ?? "",
      skillName ?? "",
    ] as const,
};

export function sharedSkillsQueryOptions(input: SharedSkillsConfigInput, enabled = true) {
  return queryOptions({
    queryKey: sharedSkillsQueryKeys.detail(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getSharedSkills(input);
    },
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function sharedSkillDetailQueryOptions(
  input: SharedSkillsConfigInput,
  skillName: string | null,
  enabled = true,
) {
  return queryOptions({
    queryKey: sharedSkillsQueryKeys.skillDetail(input, skillName),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!skillName) {
        throw new Error("Skill detail is unavailable.");
      }

      return api.server.getSharedSkillDetail({
        codexHomePath: input.codexHomePath,
        sharedSkillsPath: input.sharedSkillsPath,
        skillName,
      });
    },
    enabled: enabled && skillName !== null,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function initializeSharedSkillsMutationOptions(input: {
  config: SharedSkillsConfigInput;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["server", "shared-skills", "initialize"] as const,
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.initializeSharedSkills(input.config);
    },
    onSuccess: async () => {
      await input.queryClient.invalidateQueries({ queryKey: sharedSkillsQueryKeys.all });
    },
  });
}

export function setSharedSkillEnabledMutationOptions(input: {
  config: SharedSkillsConfigInput;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["server", "shared-skills", "set-enabled"] as const,
    mutationFn: async (variables: { enabled: boolean; skillName: string }) => {
      const api = ensureNativeApi();
      return api.server.setSharedSkillEnabled({
        ...input.config,
        ...variables,
      });
    },
    onSuccess: async (_result, variables) => {
      await input.queryClient.invalidateQueries({ queryKey: sharedSkillsQueryKeys.all });
      await input.queryClient.invalidateQueries({
        queryKey: sharedSkillsQueryKeys.skillDetail(input.config, variables.skillName),
      });
    },
  });
}

export function uninstallSharedSkillMutationOptions(input: {
  config: SharedSkillsConfigInput;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["server", "shared-skills", "uninstall"] as const,
    mutationFn: async (skillName: string) => {
      const api = ensureNativeApi();
      return api.server.uninstallSharedSkill({
        ...input.config,
        skillName,
      });
    },
    onSuccess: async (_result, skillName) => {
      await input.queryClient.invalidateQueries({ queryKey: sharedSkillsQueryKeys.all });
      await input.queryClient.invalidateQueries({
        queryKey: sharedSkillsQueryKeys.skillDetail(input.config, skillName),
      });
    },
  });
}
