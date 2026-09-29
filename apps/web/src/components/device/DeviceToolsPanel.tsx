import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DevicePermission, DeviceSummary, DeviceTextSize } from "@t3tools/contracts";
import type { resources } from "@t3tools/i18n";
import { useTranslation } from "@t3tools/i18n/react";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";

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
import { type DeviceEventLogEntry, subscribeDeviceEventLog } from "./deviceHubApi";
type DeviceToolsKey = keyof typeof resources.en.deviceTools;

const TEXT_SIZES: ReadonlyArray<{ value: DeviceTextSize; labelKey: DeviceToolsKey }> = [
  { value: "small", labelKey: "sizeSmall" },
  { value: "default", labelKey: "sizeDefault" },
  { value: "large", labelKey: "sizeLarge" },
  { value: "extra-large", labelKey: "sizeExtraLarge" },
];

const COLOR_FILTERS = [
  { value: "none", labelKey: "filterNone" },
  { value: "grayscale", labelKey: "filterGrayscale" },
  { value: "red-green", labelKey: "filterRedGreenProtanopia" },
  { value: "green-red", labelKey: "filterGreenRedDeuteranopia" },
  { value: "blue-yellow", labelKey: "filterBlueYellowTritanopia" },
] as const;

const ORIENTATIONS = [
  { value: "portrait", labelKey: "portrait" },
  { value: "landscape_left", labelKey: "landscapeLeft" },
  { value: "portrait_upside_down", labelKey: "upsideDown" },
  { value: "landscape_right", labelKey: "landscapeRight" },
] as const;

const IOS_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; labelKey: DeviceToolsKey }> = [
  { value: "camera", labelKey: "camera" },
  { value: "microphone", labelKey: "microphone" },
  { value: "photos", labelKey: "photos" },
  { value: "contacts", labelKey: "contacts" },
  { value: "calendar", labelKey: "calendar" },
  { value: "reminders", labelKey: "reminders" },
  { value: "location", labelKey: "locationPermission" },
  { value: "notifications", labelKey: "notifications" },
  { value: "motion", labelKey: "motion" },
  { value: "media-library", labelKey: "mediaLibrary" },
  { value: "faceid", labelKey: "faceId" },
];

const ANDROID_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; labelKey: DeviceToolsKey }> = [
  { value: "camera", labelKey: "camera" },
  { value: "microphone", labelKey: "microphone" },
  { value: "photos", labelKey: "photos" },
  { value: "contacts", labelKey: "contacts" },
  { value: "calendar", labelKey: "calendar" },
  { value: "location", labelKey: "locationPermission" },
  { value: "notifications", labelKey: "notifications" },
  { value: "motion", labelKey: "physicalActivity" },
];

const LOCATION_PRESETS = [
  { labelKey: "locationSanFrancisco", latitude: 37.7749, longitude: -122.4194 },
  { labelKey: "locationNewYork", latitude: 40.7128, longitude: -74.006 },
  { labelKey: "locationLondon", latitude: 51.5074, longitude: -0.1278 },
  { labelKey: "locationStockholm", latitude: 59.3293, longitude: 18.0686 },
  { labelKey: "locationTokyo", latitude: 35.6762, longitude: 139.6503 },
] as const;

/**
 * The Tools drawer for one open device: current settings read from the device,
 * one control per supported action, and the read-only feeds the hub exposes.
 * Every change is a `device.action` round trip; the returned detail replaces
 * local state so the controls never show a value the device did not confirm.
 */
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
  const { t } = useTranslation("deviceTools");
  const { device, controls } = props;
  const { detail, pending, error, foregroundApp, disabled, act } = controls;
  const settings = detail?.settings;
  const isIos = device.platform === "ios";

  return (
    <div
      className={cn("flex min-h-0 flex-col border-border bg-background text-sm", props.className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-medium">{t("tools")}</span>
        {pending ? <Spinner size="sm" /> : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={t("closeTools")}
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
            <Spinner size="sm" /> {t("readingDeviceSettings")}
          </div>
        ) : null}

        {props.hostDiagnostics ? (
          <Section title={t("hostDiagnostics")}>
            <p className="whitespace-pre-line text-xs text-muted-foreground">
              {props.hostDiagnostics}
            </p>
          </Section>
        ) : null}

        <Section title={t("app")}>
          <Row label={t("foreground")}>
            <span className="truncate font-mono text-xs">{foregroundApp?.id ?? "—"}</span>
          </Row>
          {foregroundApp ? (
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "terminateApp", appId: foregroundApp.id })}
              >
                {t("terminate")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "launchApp", appId: foregroundApp.id })}
              >
                {t("relaunch")}
              </Button>
            </div>
          ) : null}
          <SubmitRow
            placeholder={t("urlOrScheme")}
            action={t("open")}
            disabled={disabled}
            onSubmit={(url) => act({ type: "openUrl", url })}
          />
          <SubmitRow
            placeholder={t(isIos ? "bundleIdToLaunch" : "packageNameToLaunch")}
            action={t("launch")}
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
          />
        </Section>

        <Section title={t(isIos ? "simulator" : "emulator")}>
          <Row label={t("appearance")}>
            <ToggleGroup
              aria-label={t("appearance")}
              value={settings?.appearance ? [settings.appearance] : []}
              disabled={disabled}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "light" || next === "dark")
                  void act({ type: "setAppearance", value: next });
              }}
            >
              <Toggle value="light">{t("light")}</Toggle>
              <Toggle value="dark">{t("dark")}</Toggle>
            </ToggleGroup>
          </Row>
          <Row label={t("textSize")}>
            <ChoiceSelect
              ariaLabel={t("textSize")}
              value={settings?.textSize ?? null}
              options={TEXT_SIZES}
              disabled={disabled}
              onChange={(value) => act({ type: "setTextSize", value })}
            />
          </Row>
          {isIos ? (
            <>
              <Row label={t("liquidGlass")}>
                <ToggleGroup
                  aria-label={t("liquidGlass")}
                  value={settings?.liquidGlass ? [settings.liquidGlass] : []}
                  disabled={disabled || settings?.liquidGlass === undefined}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "clear" || next === "tinted") {
                      void act({ type: "setLiquidGlass", value: next });
                    }
                  }}
                >
                  <Toggle value="clear">{t("glassClear")}</Toggle>
                  <Toggle value="tinted">{t("tinted")}</Toggle>
                </ToggleGroup>
              </Row>
              <Row label={t("colorFilter")}>
                <ChoiceSelect
                  ariaLabel={t("colorFilter")}
                  value={settings?.colorFilter ?? null}
                  options={COLOR_FILTERS}
                  disabled={disabled}
                  onChange={(value) => act({ type: "setColorFilter", value })}
                />
              </Row>
            </>
          ) : (
            <Row label={t("orientation")}>
              <ChoiceSelect
                ariaLabel={t("orientation")}
                value={null}
                placeholder={t("rotateTo")}
                options={ORIENTATIONS}
                disabled={disabled}
                onChange={(value) => act({ type: "setOrientation", value })}
              />
            </Row>
          )}
          <SwitchRow
            label={t("reduceMotion")}
            checked={settings?.reduceMotion}
            disabled={disabled}
            onChange={(value) => act({ type: "setToggle", setting: "reduceMotion", value })}
          />
          {isIos ? (
            <>
              <SwitchRow
                label={t("increaseContrast")}
                checked={settings?.increaseContrast}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "increaseContrast", value })}
              />
              <SwitchRow
                label={t("reduceTransparency")}
                checked={settings?.reduceTransparency}
                disabled={disabled}
                onChange={(value) =>
                  act({ type: "setToggle", setting: "reduceTransparency", value })
                }
              />
              <SwitchRow
                label={t("showBorders")}
                checked={settings?.showBorders}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "showBorders", value })}
              />
              <SwitchRow
                label={t("voiceOver")}
                checked={settings?.voiceOver}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "voiceOver", value })}
              />
            </>
          ) : (
            <SwitchRow
              label={t("network")}
              checked={settings?.networkEnabled}
              disabled={disabled}
              onChange={(value) => act({ type: "setToggle", setting: "networkEnabled", value })}
            />
          )}
        </Section>

        <Section title={t("accessibility")}>
          <SwitchRow
            label={t("overlayElementFrames")}
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
          <Section title={t("pushNotification")}>
            <SubmitRow
              placeholder={t("alertText")}
              action={t("send")}
              disabled={disabled || !foregroundApp}
              onSubmit={(payload) =>
                foregroundApp
                  ? act({ type: "sendPush", appId: foregroundApp.id, payload })
                  : Promise.resolve()
              }
            />
            {!foregroundApp ? (
              <p className="text-xs text-muted-foreground">{t("openAppFirst")}</p>
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
  readonly onChange: (value: boolean) => Promise<void>;
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
  readonly options: ReadonlyArray<{ readonly value: V; readonly labelKey: DeviceToolsKey }>;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: V) => Promise<void>;
}) {
  const { t } = useTranslation("deviceTools");
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
            t(current.labelKey)
          ) : (
            <span className="text-muted-foreground">{props.placeholder ?? t("unknown")}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {t(option.labelKey)}
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
  readonly onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void props.onSubmit(trimmed).then(() => setValue(""));
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
  readonly onSet: (latitude: number, longitude: number) => Promise<void>;
  readonly onClear: () => Promise<void>;
}) {
  const { t } = useTranslation("deviceTools");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid =
    latitude.trim() !== "" &&
    longitude.trim() !== "" &&
    Math.abs(parsed.latitude) <= 90 &&
    Math.abs(parsed.longitude) <= 180;
  return (
    <Section title={t("location")}>
      <div className="flex gap-1.5">
        <Input
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          placeholder={t("latitude")}
          inputMode="decimal"
          value={latitude}
          disabled={props.disabled}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <Input
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          placeholder={t("longitude")}
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
            const preset = LOCATION_PRESETS.find((candidate) => candidate.labelKey === value);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void props.onSet(preset.latitude, preset.longitude);
          }}
        >
          <SelectTrigger size="xs" className="w-32" aria-label={t("locationPreset")}>
            <SelectValue>
              <span className="text-muted-foreground">{t("preset")}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {LOCATION_PRESETS.map((preset) => (
              <SelectItem key={preset.labelKey} value={preset.labelKey}>
                {t(preset.labelKey)}
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
          {t("set")}
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
            {t("clear")}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function PermissionsSection(props: {
  readonly permissions: ReadonlyArray<{ value: DevicePermission; labelKey: DeviceToolsKey }>;
  readonly canReset: boolean;
  readonly defaultAppId: string;
  readonly disabled: boolean;
  readonly onDecide: (
    appId: string,
    permission: DevicePermission,
    decision: "grant" | "revoke" | "reset",
  ) => Promise<void>;
}) {
  const { t } = useTranslation("deviceTools");
  const [appId, setAppId] = useState("");
  const [permission, setPermission] = useState<DevicePermission>("camera");
  const resolvedAppId = appId.trim() || props.defaultAppId;
  const decide = (decision: "grant" | "revoke" | "reset") =>
    void props.onDecide(resolvedAppId, permission, decision);
  return (
    <Section title={t("permissions")}>
      <Input
        size="compact"
        font="mono"
        placeholder={props.defaultAppId || t("appId")}
        value={appId}
        disabled={props.disabled}
        onChange={(event) => setAppId(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceSelect
          ariaLabel={t("permission")}
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
          {t("grant")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("revoke")}
        >
          {t("revoke")}
        </Button>
        {props.canReset ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled || !resolvedAppId}
            onClick={() => decide("reset")}
          >
            {t("reset")}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

const EVENT_LOG_LIMIT = 100;

function EventLogSection(props: {
  readonly access: DeviceHubAccess;
  readonly device: DeviceSummary;
}) {
  const { t } = useTranslation("deviceTools");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ReadonlyArray<DeviceEventLogEntry>>([]);

  useEffect(() => {
    if (!open) return;
    const unsubscribe = subscribeDeviceEventLog(
      { access: props.access, platform: props.device.platform, deviceId: props.device.id },
      (incoming, reset) => {
        setEntries((current) => {
          const merged = reset ? [...incoming] : [...current, ...incoming];
          return merged.length > EVENT_LOG_LIMIT ? merged.slice(-EVENT_LOG_LIMIT) : merged;
        });
      },
    );
    return () => {
      unsubscribe();
      setEntries([]);
    };
  }, [open, props.access, props.device.id, props.device.platform]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 border-b px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">
        {t("eventLog")}
        <ChevronDown
          className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ol className="max-h-64 overflow-y-auto px-3 py-2 font-mono text-2xs leading-relaxed">
          {entries.length === 0 ? (
            <li className="text-muted-foreground">{t("noEventsYet")}</li>
          ) : (
            entries.map((entry) => (
              <li key={entry.id} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">
                  {entry.timestamp.slice(11, 19)}
                </span>
                <span className="truncate">{entry.summary}</span>
              </li>
            ))
          )}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}
