import { DEFAULT_CLIENT_SETTINGS, FileLinkPathDepth } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";

const LABELS: Record<FileLinkPathDepth, string> = {
  1: "File name only",
  2: "1 folder + file name",
  3: "2 folders + file name",
  4: "3 folders + file name",
  5: "4 folders + file name",
};

export function FileLinkPathDepthSetting() {
  const setting = useSearchableSetting();
  const depth = useClientSettings((settings) => settings.fileLinkPathDepth);

  return (
    <SettingsRow
      {...setting("file-link-path-depth")}
      description="Folders that file links in messages and Markdown previews show before the file name, on this device. A file name that repeats in a message keeps its folder hint after the name."
      resetAction={
        depth !== DEFAULT_CLIENT_SETTINGS.fileLinkPathDepth ? (
          <SettingResetButton
            ariaLabel="Reset file link folders to default"
            onClick={() =>
              void updateClientSettings({
                fileLinkPathDepth: DEFAULT_CLIENT_SETTINGS.fileLinkPathDepth,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={depth}
          onValueChange={(value) => {
            const next = FileLinkPathDepth.literals.find((literal) => literal === value);
            if (next !== undefined) void updateClientSettings({ fileLinkPathDepth: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="File link folders">
            <SelectValue>{(value: FileLinkPathDepth) => LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {FileLinkPathDepth.literals.map((literal) => (
              <SelectItem hideIndicator key={literal} value={literal}>
                {LABELS[literal]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
