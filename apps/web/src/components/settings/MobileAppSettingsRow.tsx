import type { EnvironmentId } from "@t3tools/contracts";

import { mobileAccessEnvironment } from "../../state/mobileAccess";
import { useEnvironmentQuery } from "../../state/query";
import { AndroidIcon, AppleIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const stores = [
  {
    label: "iPhone and iPad",
    store: "App Store",
    url: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824",
    Icon: AppleIcon,
  },
  {
    label: "Android",
    store: "Google Play",
    url: "https://play.google.com/store/apps/details?id=com.t3tools.t3code",
    Icon: AndroidIcon,
  },
];

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description="Connect to your server from your phone or tablet."
      control={
        <div className="flex items-center gap-2">
          {stores.map(({ label, store, url, Icon }) => (
            <Popover key={store}>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                <Icon />
                {label}
              </PopoverTrigger>
              <PopoverPopup align="end">
                <div className="flex flex-col items-center gap-3">
                  <PopoverTitle>{store}</PopoverTitle>
                  <p className="text-xs text-muted-foreground">Scan with your phone camera.</p>
                  <div className="rounded-lg bg-white p-1.5">
                    <QRCodeSvg
                      value={url}
                      size={128}
                      level="M"
                      marginSize={1}
                      title={`${store} link`}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={url} target="_blank" rel="noreferrer noopener" />}
                  >
                    Open {store}
                  </Button>
                </div>
              </PopoverPopup>
            </Popover>
          ))}
        </div>
      }
    />
  );
}

/** Phone connections this host refused recently, and why, so a failed pairing is explainable. */
export function MobileAccessStatusRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const query = useEnvironmentQuery(mobileAccessEnvironment.status({ environmentId, input: {} }));
  const status = query.data;
  if (!status) return null;
  return (
    <SettingsRow
      {...searchableSetting("mobile-access")}
      description={`This server speaks mobile protocol ${status.serverProtocol}. Verified with ${
        status.verifiedClients.length > 0
          ? status.verifiedClients.join(", ")
          : "no app releases yet"
      }.`}
    >
      {status.attempts.length === 0 ? (
        <p className="text-muted-foreground text-xs">No refused phone connections.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-xs">
          {status.attempts.map((attempt) => (
            <li
              key={`${attempt.at}:${attempt.outcome}`}
              className="rounded-md border border-border p-2"
            >
              <div className="font-medium">
                {attempt.outcome === "protocol-mismatch"
                  ? "Version mismatch"
                  : "Credential refused"}{" "}
                <span className="font-normal text-muted-foreground">
                  {new Date(attempt.at).toLocaleString()} · {attempt.surface}
                  {attempt.appVersion ? ` · app ${attempt.appVersion}` : ""}
                  {attempt.os ? ` · ${attempt.os}` : ""}
                </span>
              </div>
              <p className="text-muted-foreground">{attempt.explanation}</p>
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}
