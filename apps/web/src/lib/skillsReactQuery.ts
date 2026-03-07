import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

export const skillsQueryKeys = {
  all: ["skills"] as const,
  list: () => ["skills", "list"] as const,
  search: (query: string) => ["skills", "search", query] as const,
  readContent: (skillName: string) => ["skills", "readContent", skillName] as const,
};

export function skillsListQueryOptions() {
  return queryOptions({
    queryKey: skillsQueryKeys.list(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.skills.list();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function skillsSearchQueryOptions(query: string) {
  return queryOptions({
    queryKey: skillsQueryKeys.search(query),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.skills.search({ query });
    },
    enabled: query.length >= 2,
    staleTime: 60_000,
  });
}

export function skillsReadContentQueryOptions(skillName: string) {
  return queryOptions({
    queryKey: skillsQueryKeys.readContent(skillName),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.skills.readContent({ skillName });
    },
    enabled: skillName.length > 0,
    staleTime: 60_000,
  });
}

export function invalidateSkillsQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: skillsQueryKeys.all });
}

export function skillsToggleMutationOptions(opts: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async (vars: { skillName: string; enabled: boolean }) => {
      const api = ensureNativeApi();
      return api.skills.toggle(vars);
    },
    onSettled: async () => {
      await invalidateSkillsQueries(opts.queryClient);
    },
  });
}

export function skillsInstallMutationOptions(opts: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async (vars: { source: string; skillName: string }) => {
      const api = ensureNativeApi();
      return api.skills.install(vars);
    },
    onSettled: async () => {
      await invalidateSkillsQueries(opts.queryClient);
    },
  });
}

export function skillsUninstallMutationOptions(opts: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async (vars: { skillName: string }) => {
      const api = ensureNativeApi();
      return api.skills.uninstall(vars);
    },
    onSettled: async () => {
      await invalidateSkillsQueries(opts.queryClient);
    },
  });
}
