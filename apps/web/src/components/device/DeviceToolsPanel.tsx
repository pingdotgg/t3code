import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DevicePermission, DeviceSummary, DeviceTextSize } from "@t3tools/contracts";
import { ChevronDown, X } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import type { DeviceControls } from "./useDeviceControls";
import { deviceEventLogAtom } from "./deviceHubAtoms";

const TEXT_SIZES: ReadonlyArray<{ value: DeviceTextSize; label: string }> = [
  {
    value: "small",
    get label() {
      return t({ message: "Small" });
    },
  },
  {
    value: "default",
    get label() {
      return t({ message: "Default" });
    },
  },
  {
    value: "large",
    get label() {
      return t({ message: "Large" });
    },
  },
  {
    value: "extra-large",
    get label() {
      return t({ message: "Extra large" });
    },
  },
];

const COLOR_FILTERS = [
  {
    value: "none",
    get label() {
      return t({ message: "None" });
    },
  },
  {
    value: "grayscale",
    get label() {
      return t({ message: "Grayscale" });
    },
  },
  {
    value: "red-green",
    get label() {
      return t({ message: "Red / green (protanopia)" });
    },
  },
  {
    value: "green-red",
    get label() {
      return t({ message: "Green / red (deuteranopia)" });
    },
  },
  {
    value: "blue-yellow",
    get label() {
      return t({ message: "Blue / yellow (tritanopia)" });
    },
  },
] as const;

const ORIENTATIONS = [
  {
    value: "portrait",
    get label() {
      return t({ message: "Portrait" });
    },
  },
  {
    value: "landscape_left",
    get label() {
      return t({ message: "Landscape left" });
    },
  },
  {
    value: "portrait_upside_down",
    get label() {
      return t({ message: "Upside down" });
    },
  },
  {
    value: "landscape_right",
    get label() {
      return t({ message: "Landscape right" });
    },
  },
] as const;

const IOS_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  {
    value: "camera",
    get label() {
      return t({ message: "Camera" });
    },
  },
  {
    value: "microphone",
    get label() {
      return t({ message: "Microphone" });
    },
  },
  {
    value: "photos",
    get label() {
      return t({ message: "Photos" });
    },
  },
  {
    value: "contacts",
    get label() {
      return t({ message: "Contacts" });
    },
  },
  {
    value: "calendar",
    get label() {
      return t({ message: "Calendar" });
    },
  },
  {
    value: "reminders",
    get label() {
      return t({ message: "Reminders" });
    },
  },
  {
    value: "location",
    get label() {
      return t({ message: "Location" });
    },
  },
  {
    value: "notifications",
    get label() {
      return t({ message: "Notifications" });
    },
  },
  {
    value: "motion",
    get label() {
      return t({ message: "Motion" });
    },
  },
  {
    value: "media-library",
    get label() {
      return t({ message: "Media library" });
    },
  },
  {
    value: "faceid",
    get label() {
      return t({ message: "Face ID" });
    },
  },
];

const ANDROID_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  {
    value: "camera",
    get label() {
      return t({ message: "Camera" });
    },
  },
  {
    value: "microphone",
    get label() {
      return t({ message: "Microphone" });
    },
  },
  {
    value: "photos",
    get label() {
      return t({ message: "Photos" });
    },
  },
  {
    value: "contacts",
    get label() {
      return t({ message: "Contacts" });
    },
  },
  {
    value: "calendar",
    get label() {
      return t({ message: "Calendar" });
    },
  },
  {
    value: "location",
    get label() {
      return t({ message: "Location" });
    },
  },
  {
    value: "notifications",
    get label() {
      return t({ message: "Notifications" });
    },
  },
  {
    value: "motion",
    get label() {
      return t({ message: "Physical activity" });
    },
  },
];

const LOCATION_PRESETS = [
  {
    get label() {
      return t({ message: "San Francisco" });
    },
    latitude: 37.7749,
    longitude: -122.4194,
  },
  {
    get label() {
      return t({ message: "New York" });
    },
    latitude: 40.7128,
    longitude: -74.006,
  },
  {
    get label() {
      return t({ message: "London" });
    },
    latitude: 51.5074,
    longitude: -0.1278,
  },
  {
    get label() {
      return t({ message: "Stockholm" });
    },
    latitude: 59.3293,
    longitude: 18.0686,
  },
  {
    get label() {
      return t({ message: "Tokyo" });
    },
    latitude: 35.6762,
    longitude: 139.6503,
  },
] as const;

export function DeviceToolsPanel(props: {
  readonly controls: DeviceControls;
  readonly hostDiagnostics: string | undefined;
  readonly device: DeviceSummary;
  readonly access: DeviceHubAccess | null;
  readonly axOverlay: boolean;
  readonly onAxOverlayChange: (enabled: boolean) => void;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const { device, controls } = props;
  const { detail, pending, error, foregroundApp, disabled, act } = controls;
  const settings = detail?.settings;
  const isIos = device.platform === "ios";

  return (
    <div
      className={cn("flex min-h-0 flex-col border-border bg-background text-sm", props.className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-medium">
          <Trans>Tools</Trans>
        </span>
        {pending ? <Spinner size="sm" /> : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={t({ message: "Close tools" })}
          className="ml-auto"
          onClick={props.onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}
        {detail === null && !error ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Spinner size="sm" />
            <Trans> Reading device settings…</Trans>
          </div>
        ) : null}

        {props.hostDiagnostics ? (
          <Section title={t({ message: "Host diagnostics" })}>
            <p className="whitespace-pre-line text-xs text-muted-foreground">
              {props.hostDiagnostics}
            </p>
          </Section>
        ) : null}

        <Section title={t({ message: "App" })}>
          <Row label={t({ message: "Foreground" })}>
            <span className="truncate font-mono text-xs">{foregroundApp?.id ?? "-"}</span>
          </Row>
          {foregroundApp ? (
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "terminateApp", appId: foregroundApp.id })}
              >
                <Trans>Terminate</Trans>
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "launchApp", appId: foregroundApp.id })}
              >
                <Trans>Relaunch</Trans>
              </Button>
            </div>
          ) : null}
          <SubmitRow
            placeholder="https://… or myapp://"
            action="Open"
            disabled={disabled}
            onSubmit={(url) => act({ type: "openUrl", url })}
          />
          <SubmitRow
            placeholder={
              isIos
                ? t({ message: "Bundle ID to launch" })
                : t({ message: "Package name to launch" })
            }
            action="Launch"
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
          />
        </Section>

        <Section title={isIos ? t({ message: "Simulator" }) : t({ message: "Emulator" })}>
          <Row label={t({ message: "Appearance" })}>
            <ToggleGroup
              aria-label={t({ message: "Appearance" })}
              value={settings?.appearance ? [settings.appearance] : []}
              disabled={disabled}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "light" || next === "dark")
                  void act({ type: "setAppearance", value: next });
              }}
            >
              <Toggle value="light">
                <Trans>Light</Trans>
              </Toggle>
              <Toggle value="dark">
                <Trans>Dark</Trans>
              </Toggle>
            </ToggleGroup>
          </Row>
          <Row label={t({ message: "Text size" })}>
            <ChoiceSelect
              ariaLabel={t({ message: "Text size" })}
              value={settings?.textSize ?? null}
              options={TEXT_SIZES}
              disabled={disabled}
              onChange={(value) => act({ type: "setTextSize", value })}
            />
          </Row>
          {isIos ? (
            <>
              <Row label={t({ message: "Liquid Glass" })}>
                <ToggleGroup
                  aria-label={t({ message: "Liquid Glass" })}
                  value={settings?.liquidGlass ? [settings.liquidGlass] : []}
                  disabled={disabled || settings?.liquidGlass === undefined}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "clear" || next === "tinted") {
                      void act({ type: "setLiquidGlass", value: next });
                    }
                  }}
                >
                  <Toggle value="clear">
                    <Trans>Clear</Trans>
                  </Toggle>
                  <Toggle value="tinted">
                    <Trans>Tinted</Trans>
                  </Toggle>
                </ToggleGroup>
              </Row>
              <Row label={t({ message: "Color filter" })}>
                <ChoiceSelect
                  ariaLabel={t({ message: "Color filter" })}
                  value={settings?.colorFilter ?? null}
                  options={COLOR_FILTERS}
                  disabled={disabled}
                  onChange={(value) => act({ type: "setColorFilter", value })}
                />
              </Row>
            </>
          ) : (
            <Row label={t({ message: "Orientation" })}>
              <ChoiceSelect
                ariaLabel={t({ message: "Orientation" })}
                value={null}
                placeholder={t({ message: "Rotate to…" })}
                options={ORIENTATIONS}
                disabled={disabled}
                onChange={(value) => act({ type: "setOrientation", value })}
              />
            </Row>
          )}
          <SwitchRow
            label={t({ message: "Reduce Motion" })}
            checked={settings?.reduceMotion}
            disabled={disabled}
            onChange={(value) => act({ type: "setToggle", setting: "reduceMotion", value })}
          />
          {isIos ? (
            <>
              <SwitchRow
                label={t({ message: "Increase Contrast" })}
                checked={settings?.increaseContrast}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "increaseContrast", value })}
              />
              <SwitchRow
                label={t({ message: "Reduce Transparency" })}
                checked={settings?.reduceTransparency}
                disabled={disabled}
                onChange={(value) =>
                  act({ type: "setToggle", setting: "reduceTransparency", value })
                }
              />
              <SwitchRow
                label={t({ message: "Show Borders" })}
                checked={settings?.showBorders}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "showBorders", value })}
              />
              <SwitchRow
                label={t({ message: "VoiceOver" })}
                checked={settings?.voiceOver}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "voiceOver", value })}
              />
            </>
          ) : (
            <SwitchRow
              label={t({ message: "Network" })}
              checked={settings?.networkEnabled}
              disabled={disabled}
              onChange={(value) => act({ type: "setToggle", setting: "networkEnabled", value })}
            />
          )}
        </Section>

        <Section title={t({ message: "Accessibility" })}>
          <SwitchRow
            label={t({ message: "Overlay element frames" })}
            checked={props.axOverlay}
            disabled={props.access === null}
            onChange={(value) => {
              props.onAxOverlayChange(value);
              return Promise.resolve();
            }}
          />
        </Section>

        <LocationSection
          disabled={disabled}
          canClear={isIos}
          onSet={(latitude, longitude) => act({ type: "setLocation", latitude, longitude })}
          onClear={() => act({ type: "clearLocation" })}
        />

        <PermissionsSection
          permissions={isIos ? IOS_PERMISSIONS : ANDROID_PERMISSIONS}
          canReset={isIos}
          defaultAppId={foregroundApp?.id ?? ""}
          disabled={disabled}
          onDecide={(appId, permission, decision) =>
            act({ type: "setPermission", appId, permission, decision })
          }
        />

        {isIos ? (
          <Section title={t({ message: "Push notification" })}>
            <SubmitRow
              placeholder={t({ message: "Alert text" })}
              action="Send"
              disabled={disabled || !foregroundApp}
              onSubmit={(payload) =>
                foregroundApp
                  ? act({ type: "sendPush", appId: foregroundApp.id, payload })
                  : Promise.resolve(false)
              }
            />
            {!foregroundApp ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Open an app first.</Trans>
              </p>
            ) : null}
          </Section>
        ) : null}

        {isIos && props.access ? <EventLogSection access={props.access} device={device} /> : null}
      </div>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 items-center justify-end">{props.children}</div>
    </div>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly checked: boolean | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => Promise<unknown>;
}) {
  return (
    <Row label={props.label}>
      <Switch
        size="sm"
        aria-label={props.label}
        checked={props.checked ?? false}
        disabled={props.disabled || props.checked === undefined}
        onCheckedChange={(checked) => void props.onChange(checked)}
      />
    </Row>
  );
}

function ChoiceSelect<V extends string>(props: {
  readonly ariaLabel: string;
  readonly value: V | null;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: V) => Promise<unknown>;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null && value !== props.value) void props.onChange(value as V);
      }}
    >
      <SelectTrigger size="xs" className="w-40" aria-label={props.ariaLabel}>
        <SelectValue>
          {current ? (
            current.label
          ) : (
            <span className="text-muted-foreground">
              {props.placeholder ?? <Trans>Unknown</Trans>}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SubmitRow(props: {
  readonly placeholder: string;
  readonly action: string;
  readonly disabled: boolean;
  readonly onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void props.onSubmit(trimmed).then((sent) => {
      if (sent) setValue("");
    });
  };
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        size="compact"
        font="mono"
        className="min-w-0 flex-1"
        placeholder={props.placeholder}
        value={value}
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        type="submit"
        size="xs"
        variant="outline"
        disabled={props.disabled || value.trim().length === 0}
      >
        {props.action}
      </Button>
    </form>
  );
}

function LocationSection(props: {
  readonly disabled: boolean;
  readonly canClear: boolean;
  readonly onSet: (latitude: number, longitude: number) => Promise<unknown>;
  readonly onClear: () => Promise<unknown>;
}) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid =
    latitude.trim() !== "" &&
    longitude.trim() !== "" &&
    Math.abs(parsed.latitude) <= 90 &&
    Math.abs(parsed.longitude) <= 180;
  return (
    <Section title={t({ message: "Location" })}>
      <div className="flex gap-1.5">
        <Input
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          placeholder={t({ message: "Latitude" })}
          inputMode="decimal"
          value={latitude}
          disabled={props.disabled}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <Input
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          placeholder={t({ message: "Longitude" })}
          inputMode="decimal"
          value={longitude}
          disabled={props.disabled}
          onChange={(event) => setLongitude(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select<string | null>
          value={null}
          disabled={props.disabled}
          onValueChange={(value) => {
            const preset = LOCATION_PRESETS.find((candidate) => candidate.label === value);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void props.onSet(preset.latitude, preset.longitude);
          }}
        >
          <SelectTrigger size="xs" className="w-32" aria-label={t({ message: "Location preset" })}>
            <SelectValue>
              <span className="text-muted-foreground">
                <Trans>Preset…</Trans>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {LOCATION_PRESETS.map((preset) => (
              <SelectItem key={preset.label} value={preset.label}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !valid}
          onClick={() => void props.onSet(parsed.latitude, parsed.longitude)}
        >
          <Trans>Set</Trans>
        </Button>
        {props.canClear ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => {
              setLatitude("");
              setLongitude("");
              void props.onClear();
            }}
          >
            <Trans>Clear</Trans>
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function PermissionsSection(props: {
  readonly permissions: ReadonlyArray<{ value: DevicePermission; label: string }>;
  readonly canReset: boolean;
  readonly defaultAppId: string;
  readonly disabled: boolean;
  readonly onDecide: (
    appId: string,
    permission: DevicePermission,
    decision: "grant" | "revoke" | "reset",
  ) => Promise<unknown>;
}) {
  const [appId, setAppId] = useState("");
  const [permission, setPermission] = useState<DevicePermission>("camera");
  const resolvedAppId = appId.trim() || props.defaultAppId;
  const decide = (decision: "grant" | "revoke" | "reset") =>
    void props.onDecide(resolvedAppId, permission, decision);
  return (
    <Section title={t({ message: "Permissions" })}>
      <Input
        size="compact"
        font="mono"
        placeholder={props.defaultAppId || t({ message: "App ID" })}
        value={appId}
        disabled={props.disabled}
        onChange={(event) => setAppId(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceSelect
          ariaLabel={t({ message: "Permission" })}
          value={permission}
          options={props.permissions}
          disabled={props.disabled}
          onChange={(value) => {
            setPermission(value);
            return Promise.resolve();
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("grant")}
        >
          <Trans>Grant</Trans>
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("revoke")}
        >
          <Trans>Revoke</Trans>
        </Button>
        {props.canReset ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled || !resolvedAppId}
            onClick={() => decide("reset")}
          >
            <Trans>Reset</Trans>
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function EventLogSection(props: {
  readonly access: DeviceHubAccess;
  readonly device: DeviceSummary;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 border-b px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">
        <Trans>Event log</Trans>
        <ChevronDown
          className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <EventLogEntries access={props.access} device={props.device} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

// The panel unmounts while closed, so the log streams only while it is open.
function EventLogEntries(props: {
  readonly access: DeviceHubAccess;
  readonly device: DeviceSummary;
}) {
  const entries = useAtomValue(
    deviceEventLogAtom({
      access: props.access,
      platform: props.device.platform,
      deviceId: props.device.id,
    }),
  );
  return (
    <ol className="max-h-64 overflow-y-auto px-3 py-2 font-mono text-2xs leading-relaxed">
      {entries.length === 0 ? (
        <li className="text-muted-foreground">
          <Trans>No events yet.</Trans>
        </li>
      ) : (
        entries.map((entry) => (
          <li key={entry.id} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{entry.timestamp.slice(11, 19)}</span>
            <span className="truncate">{entry.summary}</span>
          </li>
        ))
      )}
    </ol>
  );
}
