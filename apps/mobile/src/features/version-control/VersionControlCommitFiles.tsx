import type { VcsPanelCommitSummary, VcsPanelFileChange } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable } from "react-native";
import { AppText as Text } from "../../components/AppText";
import type { useVersionControlPanelApi } from "./useVersionControlPanelApi";
import { VersionControlList } from "./VersionControlList";

export function VersionControlCommitFiles({
  commit,
  cwd,
  api,
  renderFile,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly cwd: string;
  readonly api: ReturnType<typeof useVersionControlPanelApi>;
  readonly renderFile: (file: VcsPanelFileChange) => ReactNode;
}) {
  const [files, setFiles] = useState<readonly VcsPanelFileChange[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!commit.filesDeferred) return;
    let active = true;
    void api
      .commitFiles({ cwd, sha: commit.sha }, attempt > 0)
      .then((result) => {
        if (active) setFiles(result.files);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [api, cwd, commit.sha, commit.filesDeferred, attempt]);
  if (error)
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setError(false);
          setFiles(null);
          setAttempt((value) => value + 1);
        }}
      >
        <Text>Could not load files. Retry</Text>
      </Pressable>
    );
  const loaded = commit.filesDeferred ? files : commit.files;
  if (!loaded) return <Text>Loading files...</Text>;
  if (!loaded.length) return <Text>No changed files.</Text>;
  return <VersionControlList items={loaded} getKey={(file) => file.path} renderItem={renderFile} />;
}
