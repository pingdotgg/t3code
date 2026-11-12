import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { AppTextInput as TextInput, AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { SelectionRow } from "../../../components/ui/SelectionRow";
import { usePaginatedBranches } from "../../../state/queries";

export function StackBranchPicker({
  environmentId,
  cwd,
  value,
  excluded,
  label,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: string;
  readonly excluded: readonly string[];
  readonly label: string;
  readonly onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const branches = usePaginatedBranches({
    environmentId: open ? environmentId : null,
    cwd,
    query: search,
  });
  const items = branches.refs.filter((ref) => !ref.isRemote && !excluded.includes(ref.name));
  return (
    <View className="gap-2">
      <Button
        label={value || "Choose branch"}
        accessibilityLabel={`${label}: ${value || "Choose branch"}`}
        tone="text"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel={`Search ${label.toLowerCase()}`}
            placeholder="Search branches"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-12 rounded-xl bg-subtle px-3 text-foreground"
          />
          <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }}>
            {items.map((branch) => (
              <SelectionRow
                key={branch.name}
                title={branch.name}
                selected={branch.name === value}
                onPress={() => {
                  onChange(branch.name);
                  setOpen(false);
                }}
              />
            ))}
          </ScrollView>
          {branches.error ? (
            <Text className="text-warning-foreground">{branches.error}</Text>
          ) : branches.isPending ? (
            <Text className="text-foreground-secondary">Loading branches…</Text>
          ) : items.length === 0 ? (
            <Text className="text-foreground-secondary">No branches found</Text>
          ) : null}
          {branches.data?.nextCursor != null ? (
            <Button
              label="More branches"
              tone="text"
              disabled={branches.isFetchingNextPage}
              onPress={branches.loadNext}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
