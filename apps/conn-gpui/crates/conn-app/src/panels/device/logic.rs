//! Pure domain logic, state derivations, validation, and formatting for the Device surface.
//!
//! Mirrors Conn's `DevicePanel.tsx`, `DeviceSetup.tsx`, `DeviceToolsPanel.tsx`,
//! `DeviceToolVersions.tsx`, `deviceFrameLayout.ts`, `deviceHostConnectionChecks.ts`,
//! `easDeviceHostsSettings.logic.ts`, and `simlockDeviceHostsSettings.logic.ts`.

use std::cmp::Ordering;
use std::collections::HashSet;

use conn_client::ClientError;
use conn_contract::{
    DeviceColorFilter, DeviceEasAccount, DeviceEasAccountCredentialSource, DeviceHostStatus,
    DeviceHostStatusesValue, DeviceOrientation, DevicePermission, DevicePlatform,
    DevicePlatformAvailability, DeviceServiceState, DeviceServiceStateEasHostsItem,
    DeviceServiceStateHostsItem, DeviceServiceStateHostsItemKind,
    DeviceServiceStateSimlockHostsItem, DeviceSimlockIdentity, DeviceSimlockIdentityTokenSource,
    DeviceSummary, DeviceTextSize, DeviceToolVersion, DeviceToolVersions, EasDeviceHostConfig,
    SettingsSecretValue, SimlockDeviceHostConfig, SshDeviceHostConfig, lit,
};

/// Controls rail width (`CONTROLS_RAIL_WIDTH` in `DeviceStreamView.tsx`, `w-14` = 56px).
pub(super) const CONTROLS_RAIL_WIDTH_PX: f32 = 56.0;

/// Text size options (`TEXT_SIZES` in `DeviceToolsPanel.tsx`).
pub(super) const TEXT_SIZES: &[(DeviceTextSize, &str)] = &[
    (DeviceTextSize::Small, "Small"),
    (DeviceTextSize::Default, "Default"),
    (DeviceTextSize::Large, "Large"),
    (DeviceTextSize::ExtraLarge, "Extra large"),
];

/// Color filter options (`COLOR_FILTERS` in `DeviceToolsPanel.tsx`).
pub(super) const COLOR_FILTERS: &[(DeviceColorFilter, &str)] = &[
    (DeviceColorFilter::None, "None"),
    (DeviceColorFilter::Grayscale, "Grayscale"),
    (DeviceColorFilter::RedGreen, "Red / green (protanopia)"),
    (DeviceColorFilter::GreenRed, "Green / red (deuteranopia)"),
    (DeviceColorFilter::BlueYellow, "Blue / yellow (tritanopia)"),
];

/// Android orientation options (`ORIENTATIONS` in `DeviceToolsPanel.tsx`).
pub(super) const ORIENTATIONS: &[(DeviceOrientation, &str)] = &[
    (DeviceOrientation::Portrait, "Portrait"),
    (DeviceOrientation::LandscapeLeft, "Landscape left"),
    (DeviceOrientation::PortraitUpsideDown, "Upside down"),
    (DeviceOrientation::LandscapeRight, "Landscape right"),
];

/// iOS permission choices (`IOS_PERMISSIONS` in `DeviceToolsPanel.tsx`).
pub(super) const IOS_PERMISSIONS: &[(DevicePermission, &str)] = &[
    (DevicePermission::Camera, "Camera"),
    (DevicePermission::Microphone, "Microphone"),
    (DevicePermission::Photos, "Photos"),
    (DevicePermission::Contacts, "Contacts"),
    (DevicePermission::Calendar, "Calendar"),
    (DevicePermission::Reminders, "Reminders"),
    (DevicePermission::Location, "Location"),
    (DevicePermission::Notifications, "Notifications"),
    (DevicePermission::Motion, "Motion"),
    (DevicePermission::MediaLibrary, "Media library"),
    (DevicePermission::Faceid, "Face ID"),
];

/// Android permission choices (`ANDROID_PERMISSIONS` in `DeviceToolsPanel.tsx`).
pub(super) const ANDROID_PERMISSIONS: &[(DevicePermission, &str)] = &[
    (DevicePermission::Camera, "Camera"),
    (DevicePermission::Microphone, "Microphone"),
    (DevicePermission::Photos, "Photos"),
    (DevicePermission::Contacts, "Contacts"),
    (DevicePermission::Calendar, "Calendar"),
    (DevicePermission::Location, "Location"),
    (DevicePermission::Notifications, "Notifications"),
    (DevicePermission::Motion, "Physical activity"),
];

/// City coordinate presets (`LOCATION_PRESETS` in `DeviceToolsPanel.tsx`).
pub(super) const LOCATION_PRESETS: &[(&str, f64, f64)] = &[
    ("San Francisco", 37.7749, -122.4194),
    ("New York", 40.7128, -74.006),
    ("London", 51.5074, -0.1278),
    ("Stockholm", 59.3293, 18.0686),
    ("Tokyo", 35.6762, 139.6503),
];

/// Every superheroicon asset path drawn by the Device surface (checked in unit tests).
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "verified by embedded-asset unit test")
)]
pub(super) const USED_SUPERHERO_ICONS: &[&str] = &[
    "superhero/add.svg",
    "superhero/adjust.svg",
    "superhero/arrow-up-right.svg",
    "superhero/camera.svg",
    "superhero/check.svg",
    "superhero/chevron-down.svg",
    "superhero/chevron-left.svg",
    "superhero/close.svg",
    "superhero/cloud.svg",
    "superhero/delete.svg",
    "superhero/desktop.svg",
    "superhero/edit.svg",
    "superhero/error-circle.svg",
    "superhero/home.svg",
    "superhero/more-horizontal.svg",
    "superhero/package.svg",
    "superhero/phone.svg",
    "superhero/picture-in-picture.svg",
    "superhero/play.svg",
    "superhero/power.svg",
    "superhero/refresh.svg",
    "superhero/remove.svg",
    "superhero/retry.svg",
    "superhero/server.svg",
    "superhero/settings.svg",
    "superhero/spinner.svg",
    "superhero/stop.svg",
    "superhero/theme-dark.svg",
    "superhero/theme-light.svg",
    "superhero/type.svg",
];

/// Unique identifier for a device on a specific host.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct DeviceKey {
    pub(super) host_id: String,
    pub(super) device_id: String,
}

impl DeviceKey {
    #[must_use]
    pub(super) fn from_summary(device: &DeviceSummary) -> Self {
        Self {
            host_id: device.host_id.clone(),
            device_id: device.id.clone(),
        }
    }

    #[must_use]
    pub(super) fn new(host_id: impl Into<String>, device_id: impl Into<String>) -> Self {
        Self {
            host_id: host_id.into(),
            device_id: device_id.into(),
        }
    }
}

/// Kind of device host (`DeviceHostSummary["kind"]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum HostKind {
    Local,
    Ssh,
    Eas,
    Simlock,
}

impl HostKind {
    /// Local and SSH hosts run host-side device settings/tools commands; Expo and Simlock do not.
    #[must_use]
    pub(super) const fn runs_host_commands(self) -> bool {
        matches!(self, Self::Local | Self::Ssh)
    }

    #[must_use]
    pub(super) const fn badge_label(self) -> Option<&'static str> {
        match self {
            Self::Local => None,
            Self::Ssh => Some("SSH"),
            Self::Eas => Some("Expo"),
            Self::Simlock => Some("Simlock"),
        }
    }
}

/// Borrowed view over any host entry in [`DeviceServiceState`].
#[derive(Clone, Copy, Debug)]
pub(super) struct HostView<'a> {
    pub(super) id: &'a str,
    pub(super) label: &'a str,
    pub(super) kind: HostKind,
    pub(super) platforms: &'a [DevicePlatformAvailability],
    pub(super) tools: Option<&'a DeviceToolVersions>,
    pub(super) tool_inspection_error: Option<&'a str>,
    pub(super) agent_device_installed: bool,
}

impl<'a> HostView<'a> {
    fn from_local_or_ssh(item: &'a DeviceServiceStateHostsItem) -> Self {
        Self {
            id: &item.id,
            label: &item.label,
            kind: match item.kind {
                DeviceServiceStateHostsItemKind::Local => HostKind::Local,
                DeviceServiceStateHostsItemKind::Ssh => HostKind::Ssh,
            },
            platforms: &item.platforms,
            tools: item.tools.as_ref(),
            tool_inspection_error: item.tool_inspection_error.as_deref(),
            agent_device_installed: item.agent_device_installed,
        }
    }

    fn from_eas(item: &'a DeviceServiceStateEasHostsItem) -> Self {
        Self {
            id: &item.id,
            label: &item.label,
            kind: HostKind::Eas,
            platforms: &item.platforms,
            tools: item.tools.as_ref(),
            tool_inspection_error: item.tool_inspection_error.as_deref(),
            agent_device_installed: item.agent_device_installed,
        }
    }

    fn from_simlock(item: &'a DeviceServiceStateSimlockHostsItem) -> Self {
        Self {
            id: &item.id,
            label: &item.label,
            kind: HostKind::Simlock,
            platforms: &item.platforms,
            tools: item.tools.as_ref(),
            tool_inspection_error: item.tool_inspection_error.as_deref(),
            agent_device_installed: item.agent_device_installed,
        }
    }
}

/// Empty initial [`DeviceServiceState`] matching `EMPTY_DEVICE_STATE` in `state/device.ts`.
#[must_use]
pub(super) fn empty_device_state() -> DeviceServiceState {
    DeviceServiceState {
        supports_host_retry: None,
        supports_tool_update: None,
        supports_tool_inspection: None,
        supports_eas_hosts: None,
        supports_simlock_hosts: None,
        host_status: DeviceHostStatus::Disabled,
        host_status_detail: None,
        host_statuses: std::collections::BTreeMap::new(),
        devices: Vec::new(),
        sessions: Vec::new(),
        booting_devices: None,
        onboarding_completed: false,
        agent_access_enabled: false,
        hub_base_path: "/api/device-hub".to_owned(),
        revision: 0,
        hosts: Vec::new(),
        eas_hosts: None,
        simlock_hosts: None,
    }
}

/// Returns every host known to `state` (local, SSH, EAS, Simlock) in display order, deduplicated by id.
#[must_use]
pub(super) fn all_hosts(state: &DeviceServiceState) -> Vec<HostView<'_>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for host in &state.hosts {
        if seen.insert(host.id.as_str()) {
            out.push(HostView::from_local_or_ssh(host));
        }
    }
    if let Some(eas_hosts) = &state.eas_hosts {
        for host in eas_hosts {
            if seen.insert(host.id.as_str()) {
                out.push(HostView::from_eas(host));
            }
        }
    }
    if let Some(simlock_hosts) = &state.simlock_hosts {
        for host in simlock_hosts {
            if seen.insert(host.id.as_str()) {
                out.push(HostView::from_simlock(host));
            }
        }
    }
    out
}

/// Finds a host by ID across local/SSH, EAS, and Simlock host lists.
#[must_use]
pub(super) fn find_host<'a>(state: &'a DeviceServiceState, host_id: &str) -> Option<HostView<'a>> {
    all_hosts(state).into_iter().find(|host| host.id == host_id)
}

/// Platform display name (`platformName` in `DeviceSetup.tsx`).
#[must_use]
pub(super) const fn platform_name(platform: DevicePlatform) -> &'static str {
    match platform {
        DevicePlatform::Ios => "iOS",
        DevicePlatform::Android => "Android",
    }
}

/// Section heading for a platform group (`DevicePanel.tsx`).
#[must_use]
pub(super) const fn platform_group_title(platform: DevicePlatform) -> &'static str {
    match platform {
        DevicePlatform::Ios => "iOS Simulators",
        DevicePlatform::Android => "Android Emulators",
    }
}

/// Grouped devices for one platform, matching `groupDevices` in `DevicePanel.tsx`.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct DeviceGroup {
    pub(super) platform: DevicePlatform,
    pub(super) devices: Vec<DeviceSummary>,
}

/// Groups devices by platform (iOS then Android), with running devices first and names sorted
/// case-insensitively ascending.
#[must_use]
pub(super) fn group_devices(state: &DeviceServiceState) -> Vec<DeviceGroup> {
    let mut groups = Vec::new();
    for platform in [DevicePlatform::Ios, DevicePlatform::Android] {
        let mut devices: Vec<DeviceSummary> = state
            .devices
            .iter()
            .filter(|device| device.platform == platform)
            .cloned()
            .collect();
        devices.sort_by(|a, b| {
            b.booted
                .cmp(&a.booted)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });
        if !devices.is_empty() {
            groups.push(DeviceGroup { platform, devices });
        }
    }
    groups
}

/// Readiness derived from both local `host_status` and remote `host_statuses` (`deviceHubReadiness`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct HubReadiness {
    pub(super) ready: bool,
    pub(super) busy: bool,
}

#[must_use]
pub(super) fn device_hub_readiness(state: &DeviceServiceState) -> HubReadiness {
    let ready = state.host_status == DeviceHostStatus::Ready
        || state
            .host_statuses
            .values()
            .any(|status| status.status == DeviceHostStatus::Ready);
    let busy = !ready
        && std::iter::once(state.host_status)
            .chain(state.host_statuses.values().map(|s| s.status))
            .any(|status| {
                matches!(
                    status,
                    DeviceHostStatus::Installing | DeviceHostStatus::Starting
                )
            });
    HubReadiness { ready, busy }
}

/// Platforms whose latest listing on a ready host may be missing devices (`incompleteListings`).
#[must_use]
pub(super) fn incomplete_listings(status: Option<&DeviceHostStatusesValue>) -> Vec<DevicePlatform> {
    let Some(status) = status else {
        return Vec::new();
    };
    if status.status != DeviceHostStatus::Ready {
        return Vec::new();
    }
    [DevicePlatform::Ios, DevicePlatform::Android]
        .into_iter()
        .filter(|platform| {
            status
                .incomplete_platforms
                .as_ref()
                .is_some_and(|list| list.contains(platform))
                || (*platform == DevicePlatform::Android
                    && status.android_discovery_incomplete == Some(true))
        })
        .collect()
}

/// Whether any ready host reported uncertain Android discovery (`isAndroidDiscoveryUncertain`).
#[must_use]
pub(super) fn is_android_discovery_uncertain(state: &DeviceServiceState) -> bool {
    state
        .host_statuses
        .values()
        .any(|status| incomplete_listings(Some(status)).contains(&DevicePlatform::Android))
}

/// Discovery warning attached to a ready host (`diagnostics` in `DevicePanel.tsx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct HostDiagnostic {
    pub(super) host_id: String,
    pub(super) label: String,
    pub(super) detail: String,
    pub(super) incomplete_platforms: Vec<DevicePlatform>,
}

impl HostDiagnostic {
    /// Dismissal key matching `cause` in `DeviceDiscoveryWarning`.
    #[must_use]
    pub(super) fn cause_key(&self) -> String {
        let plats = self
            .incomplete_platforms
            .iter()
            .map(|p| platform_name(*p))
            .collect::<Vec<_>>()
            .join(",");
        format!("{plats}\0{}", self.detail)
    }
}

#[must_use]
pub(super) fn host_diagnostics(state: &DeviceServiceState) -> Vec<HostDiagnostic> {
    all_hosts(state)
        .into_iter()
        .filter_map(|host| {
            let status = state.host_statuses.get(host.id);
            let detail = status.and_then(|s| s.detail.as_deref()).or_else(|| {
                (host.kind == HostKind::Local)
                    .then_some(state.host_status_detail.as_deref())
                    .flatten()
            });
            let effective_status = status.map_or(state.host_status, |s| s.status);
            if effective_status == DeviceHostStatus::Ready {
                detail.map(|detail| HostDiagnostic {
                    host_id: host.id.to_owned(),
                    label: host.label.to_owned(),
                    detail: detail.to_owned(),
                    incomplete_platforms: incomplete_listings(status),
                })
            } else {
                None
            }
        })
        .collect()
}

/// Exact warning copy from `DeviceDiscoveryWarning` in `DevicePanel.tsx`.
#[must_use]
pub(super) fn discovery_warning_text(
    label: &str,
    incomplete_platforms: &[DevicePlatform],
) -> String {
    match incomplete_platforms {
        [first, second, ..] => format!(
            "{} and {} lists on {label} may be incomplete.",
            platform_name(*first),
            platform_name(*second)
        ),
        [platform] => format!(
            "{} list on {label} may be incomplete.",
            platform_name(*platform)
        ),
        [] => format!("Device discovery on {label} reported a warning."),
    }
}

/// Whether the picker should show Conn's missing-AVD hint below the device list (`DevicePanel.tsx`).
#[must_use]
pub(super) fn show_missing_android_avd_hint(state: &DeviceServiceState) -> bool {
    let readiness = device_hub_readiness(state);
    if !readiness.ready || is_android_discovery_uncertain(state) {
        return false;
    }
    let has_android_device = state
        .devices
        .iter()
        .any(|d| d.platform == DevicePlatform::Android);
    if has_android_device {
        return false;
    }
    let has_unavailable_android = all_hosts(state).iter().any(|host| {
        host.platforms
            .iter()
            .any(|p| p.platform == DevicePlatform::Android && !p.available)
    });
    !has_unavailable_android
}

/// Result of [`platform_setup_status`], matching `DeviceSetup.tsx`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PlatformSetupStatus {
    pub(super) ready: bool,
    pub(super) message: String,
}

#[must_use]
pub(super) fn platform_setup_status(
    state: &DeviceServiceState,
    platform: DevicePlatform,
) -> PlatformSetupStatus {
    let has_devices = state.devices.iter().any(|d| d.platform == platform);
    if platform == DevicePlatform::Android && !has_devices && is_android_discovery_uncertain(state)
    {
        return PlatformSetupStatus {
            ready: false,
            message:
                "The Android device list may be incomplete. Check the device host and try again."
                    .to_owned(),
        };
    }

    let hosts = all_hosts(state);
    let mut availabilities: Vec<(&DevicePlatformAvailability, HostView<'_>)> = Vec::new();
    for host in hosts {
        for candidate in host.platforms {
            if candidate.platform == platform {
                availabilities.push((candidate, host));
            }
        }
    }
    let supporting_hosts: Vec<HostView<'_>> = availabilities
        .iter()
        .filter(|(candidate, _)| candidate.available)
        .map(|(_, host)| *host)
        .collect();

    if supporting_hosts.is_empty() {
        let message = availabilities
            .first()
            .and_then(|(candidate, _)| candidate.reason.clone())
            .unwrap_or_else(|| format!("{} support was not detected.", platform_name(platform)));
        return PlatformSetupStatus {
            ready: false,
            message,
        };
    }

    let ready_hosts: Vec<HostView<'_>> = supporting_hosts
        .iter()
        .copied()
        .filter(|host| {
            state
                .host_statuses
                .get(host.id)
                .is_some_and(|s| s.status == DeviceHostStatus::Ready)
                || (host.kind == HostKind::Local && state.host_status == DeviceHostStatus::Ready)
        })
        .collect();

    if !ready_hosts.is_empty() && !has_devices {
        if ready_hosts.iter().any(|host| {
            state
                .host_statuses
                .get(host.id)
                .and_then(|s| s.incomplete_platforms.as_ref())
                .is_some_and(|list| list.contains(&platform))
        }) {
            return PlatformSetupStatus {
                ready: false,
                message: format!(
                    "No {} devices were listed because device discovery reported a problem.",
                    platform_name(platform)
                ),
            };
        }
        let message = match platform {
            DevicePlatform::Ios => "Xcode is installed, but no iOS Simulator is available. Install a runtime in Xcode Settings → Components.".to_owned(),
            DevicePlatform::Android => "The Android SDK is installed, but no virtual device exists. Create one in Android Studio → Device Manager.".to_owned(),
        };
        return PlatformSetupStatus {
            ready: false,
            message,
        };
    }

    let remote_host = supporting_hosts
        .iter()
        .all(|host| host.kind != HostKind::Local)
        .then(|| supporting_hosts.first().copied())
        .flatten();

    let message = match (remote_host, platform) {
        (Some(host), DevicePlatform::Ios) if host.kind == HostKind::Eas => {
            format!(
                "{} starts iOS Simulators in the cloud with Expo Simulators.",
                host.label
            )
        }
        (Some(host), DevicePlatform::Android) if host.kind == HostKind::Eas => {
            format!(
                "{} starts Android emulators in the cloud with Expo Simulators.",
                host.label
            )
        }
        (Some(host), DevicePlatform::Ios) => {
            format!("Xcode and iOS Simulator are available on {}.", host.label)
        }
        (None, DevicePlatform::Ios) => "Xcode and iOS Simulator are available.".to_owned(),
        (Some(host), DevicePlatform::Android) => {
            format!(
                "The Android SDK and Emulator are available on {}.",
                host.label
            )
        }
        (None, DevicePlatform::Android) => "The Android SDK and Emulator are available.".to_owned(),
    };
    PlatformSetupStatus {
        ready: true,
        message,
    }
}

/// Active version displayed for a device tool (`DeviceToolVersions.tsx`).
#[must_use]
pub(super) fn active_tool_version(tool: &DeviceToolVersion) -> Option<&str> {
    if let Some(running) = tool.running_version.as_deref() {
        return Some(running);
    }
    if tool
        .installed_versions
        .iter()
        .any(|v| v == &tool.required_version)
    {
        return Some(tool.required_version.as_str());
    }
    tool.installed_versions
        .iter()
        .map(String::as_str)
        .max_by(|a, b| compare_versions_numeric(a, b))
}

fn compare_versions_numeric(a: &str, b: &str) -> Ordering {
    let mut a_parts = a.split(['.', '-', '+']);
    let mut b_parts = b.split(['.', '-', '+']);
    loop {
        match (a_parts.next(), b_parts.next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ap), Some(bp)) => {
                let ord = match (ap.parse::<u64>(), bp.parse::<u64>()) {
                    (Ok(an), Ok(bn)) => an.cmp(&bn),
                    _ => ap.cmp(bp),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

/// Fitted viewport rectangle (`fitDeviceFrame` in `deviceFrameLayout.ts`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct DeviceFrameSize {
    pub(super) width: f32,
    pub(super) height: f32,
}

#[must_use]
pub(super) fn fit_device_frame(
    aspect: f32,
    width: f32,
    height: f32,
    right_inset: f32,
) -> DeviceFrameSize {
    let available_width = (width - right_inset).max(0.0);
    if available_width <= 0.0 || height <= 0.0 || aspect <= 0.0 {
        return DeviceFrameSize {
            width: 0.0,
            height: 0.0,
        };
    }
    let by_height_width = height * aspect;
    if by_height_width <= available_width {
        DeviceFrameSize {
            width: by_height_width,
            height,
        }
    } else {
        DeviceFrameSize {
            width: available_width,
            height: available_width / aspect,
        }
    }
}

/// Default portrait screen aspect ratio (`screenAspect` in `DeviceStreamView.tsx`).
#[must_use]
pub(super) fn default_screen_aspect(platform: DevicePlatform) -> f32 {
    match platform {
        DevicePlatform::Ios => 9.0 / 19.5,
        DevicePlatform::Android => 9.0 / 20.0,
    }
}

/// Parses and validates latitude/longitude inputs (`LocationSection` in `DeviceToolsPanel.tsx`).
#[must_use]
pub(super) fn parse_coordinates(latitude: &str, longitude: &str) -> Option<(f64, f64)> {
    let lat_trim = latitude.trim();
    let lon_trim = longitude.trim();
    if lat_trim.is_empty() || lon_trim.is_empty() {
        return None;
    }
    let lat = lat_trim.parse::<f64>().ok()?;
    let lon = lon_trim.parse::<f64>().ok()?;
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    Some((lat, lon))
}

/// Validates an SSH host form draft into an [`SshDeviceHostConfig`].
pub(super) fn build_ssh_host_config(
    id: String,
    label: &str,
    target: &str,
    identity_file: &str,
    port_text: &str,
) -> Result<SshDeviceHostConfig, &'static str> {
    let label = label.trim();
    let target = target.trim();
    if label.is_empty() {
        return Err("Enter a host name.");
    }
    if target.is_empty() {
        return Err("Enter an SSH target (user@host or SSH alias).");
    }
    let port = if port_text.trim().is_empty() {
        None
    } else {
        let parsed = port_text
            .trim()
            .parse::<i64>()
            .map_err(|_| "Port must be a number between 1 and 65535.")?;
        if !(1..=65_535).contains(&parsed) {
            return Err("Port must be between 1 and 65535.");
        }
        Some(parsed)
    };
    let identity_file = {
        let trimmed = identity_file.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    };
    Ok(SshDeviceHostConfig {
        kind: Some(lit::Ssh),
        id,
        label: label.to_owned(),
        target: target.to_owned(),
        identity_file,
        port,
    })
}

/// Validates an Expo (EAS) host form draft (`EasDeviceHostEditor.tsx`).
pub(super) fn build_eas_host_config(
    id: String,
    label: &str,
    access_token: Option<SettingsSecretValue>,
    app_id: Option<String>,
    max_concurrent_text: &str,
    max_session_text: &str,
    idle_text: &str,
) -> Result<EasDeviceHostConfig, &'static str> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Give the host a label and limits within the ranges shown.");
    }
    let max_concurrent = max_concurrent_text
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|v| (1..=20).contains(v))
        .ok_or("Give the host a label and limits within the ranges shown.")?;
    let max_session = max_session_text
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|v| (1..=115).contains(v))
        .ok_or("Give the host a label and limits within the ranges shown.")?;
    let idle = idle_text
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|v| (1..=60).contains(v))
        .ok_or("Give the host a label and limits within the ranges shown.")?;
    if idle >= max_session {
        return Err("Idle minutes must be smaller than session minutes.");
    }
    Ok(EasDeviceHostConfig {
        kind: lit::Eas,
        id,
        label: label.to_owned(),
        app_id: app_id.filter(|s| !s.trim().is_empty()),
        access_token,
        max_session_minutes: Some(max_session),
        idle_minutes: Some(idle),
        max_concurrent_sessions: Some(max_concurrent),
    })
}

/// Validates a Simlock host form draft (`SimlockDeviceHostEditor.tsx`).
pub(super) fn build_simlock_host_config(
    id: String,
    label: &str,
    gateway_url: &str,
    agent_token: Option<SettingsSecretValue>,
    max_leases_text: &str,
    max_lease_minutes_text: &str,
) -> Result<SimlockDeviceHostConfig, &'static str> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Give the host a label.");
    }
    let gateway_url = gateway_url.trim();
    let parsed_url = url::Url::parse(gateway_url).ok();
    let valid_origin = parsed_url.is_some_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.host_str().is_some()
            && (u.path().is_empty() || u.path() == "/")
            && u.query().is_none()
            && u.fragment().is_none()
    });
    if !valid_origin {
        return Err("Enter the gateway's origin, such as https://gateway.example.ts.net:4700.");
    }
    let max_leases = max_leases_text
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|v| (1..=20).contains(v))
        .ok_or("Keep the limits within the ranges shown.")?;
    let max_lease_minutes = max_lease_minutes_text
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|v| (5..=240).contains(v))
        .ok_or("Keep the limits within the ranges shown.")?;
    Ok(SimlockDeviceHostConfig {
        kind: lit::Simlock,
        id,
        label: label.to_owned(),
        gateway_url: gateway_url.trim_end_matches('/').to_owned(),
        agent_token,
        max_leases: Some(max_leases),
        max_lease_minutes: Some(max_lease_minutes),
    })
}

/// Signed-in message for [`DeviceEasAccount`] (`SIGNED_IN_MESSAGES` in `EasDeviceHostEditor.tsx`).
#[must_use]
pub(super) fn eas_account_message(account: &DeviceEasAccount) -> String {
    match account.credential_source {
        DeviceEasAccountCredentialSource::Settings => format!(
            "Signed in as {} with the access token saved here.",
            account.signed_in_as
        ),
        DeviceEasAccountCredentialSource::Env => format!(
            "Signed in as {} with EXPO_TOKEN on the server.",
            account.signed_in_as
        ),
        DeviceEasAccountCredentialSource::EasLogin => format!(
            "Signed in as {} with the server's eas login.",
            account.signed_in_as
        ),
    }
}

/// Identity message for [`DeviceSimlockIdentity`] (`SimlockDeviceHostEditor.tsx`).
#[must_use]
pub(super) fn simlock_identity_message(identity: &DeviceSimlockIdentity) -> String {
    match identity.token_source {
        DeviceSimlockIdentityTokenSource::Env => format!(
            "Using this machine's agent-device token ({}).",
            identity.signed_in_as
        ),
        DeviceSimlockIdentityTokenSource::Entered | DeviceSimlockIdentityTokenSource::Settings => {
            format!("Accepted as {}.", identity.signed_in_as)
        }
    }
}

/// Extracts a concise human-readable message from a [`ClientError`] returned by `conn-server`.
#[must_use]
pub(super) fn format_client_error(error: &ClientError) -> String {
    match error {
        ClientError::Rpc(value) => format_rpc_value(value),
        ClientError::Connection(msg) | ClientError::Auth(msg) => msg.clone(),
        ClientError::Closed => "Disconnected from server.".to_owned(),
        ClientError::Codec(err) => format!("Unexpected server response: {err}"),
        ClientError::InvalidUrl(err) => format!("Invalid server URL: {err}"),
    }
}

fn format_rpc_value(value: &serde_json::Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_owned();
    }
    if let Some(obj) = value.as_object() {
        if let Some(tag) = obj.get("_tag").and_then(serde_json::Value::as_str) {
            match tag {
                "DeviceHostUnavailableError" => {
                    if let Some(reason) = obj.get("reason").and_then(serde_json::Value::as_str) {
                        return reason.to_owned();
                    }
                }
                "DevicePlatformUnavailableError" => {
                    if let Some(reason) = obj.get("reason").and_then(serde_json::Value::as_str) {
                        return reason.to_owned();
                    }
                }
                "DeviceNotFoundError" => {
                    let id = obj
                        .get("deviceId")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("device");
                    return format!("Device `{id}` was not found.");
                }
                "DeviceBootError" => {
                    if let Some(diag) = obj.get("diagnostics").and_then(serde_json::Value::as_str) {
                        return diag.to_owned();
                    }
                    let reason = obj
                        .get("reason")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("launch_failed");
                    return match reason {
                        "disk_space" => "Not enough disk space to start this device.".to_owned(),
                        "timeout" => "Timed out waiting for the device to start.".to_owned(),
                        _ => "Device failed to start.".to_owned(),
                    };
                }
                "DeviceOperationError" => {
                    if let Some(cause) = obj.get("cause").and_then(serde_json::Value::as_str) {
                        return cause.to_owned();
                    }
                    if let Some(op) = obj.get("operation").and_then(serde_json::Value::as_str) {
                        return format!("Device operation `{op}` failed.");
                    }
                }
                "DeviceActionUnavailableError" => {
                    let op = obj
                        .get("operation")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Action");
                    return format!("{op} is not supported on this device.");
                }
                "DeviceEasAccountError" | "DeviceSimlockIdentityError" => {
                    if let Some(reason) = obj.get("reason").and_then(serde_json::Value::as_str) {
                        return reason.to_owned();
                    }
                }
                _ => {}
            }
        }
        for key in ["message", "reason", "detail", "error"] {
            if let Some(text) = obj.get(key).and_then(serde_json::Value::as_str)
                && !text.trim().is_empty()
            {
                return text.to_owned();
            }
        }
        if let Some(cause) = obj.get("cause") {
            let inner = format_rpc_value(cause);
            if !inner.is_empty() {
                return inner;
            }
        }
    }
    value.to_string()
}

/// Label for a [`DeviceTextSize`].
#[must_use]
pub(super) const fn text_size_label(size: DeviceTextSize) -> &'static str {
    match size {
        DeviceTextSize::Small => "Small",
        DeviceTextSize::Default => "Default",
        DeviceTextSize::Large => "Large",
        DeviceTextSize::ExtraLarge => "Extra large",
    }
}

/// Label for a [`DeviceColorFilter`].
#[must_use]
pub(super) const fn color_filter_label(filter: DeviceColorFilter) -> &'static str {
    match filter {
        DeviceColorFilter::None => "None",
        DeviceColorFilter::Grayscale => "Grayscale",
        DeviceColorFilter::RedGreen => "Red / green (protanopia)",
        DeviceColorFilter::GreenRed => "Green / red (deuteranopia)",
        DeviceColorFilter::BlueYellow => "Blue / yellow (tritanopia)",
    }
}

/// Label for a [`DevicePermission`] on `platform`.
#[must_use]
pub(super) const fn permission_label(
    permission: DevicePermission,
    platform: DevicePlatform,
) -> &'static str {
    match (permission, platform) {
        (DevicePermission::Motion, DevicePlatform::Android) => "Physical activity",
        (DevicePermission::Camera, _) => "Camera",
        (DevicePermission::Microphone, _) => "Microphone",
        (DevicePermission::Photos, _) => "Photos",
        (DevicePermission::Contacts, _) => "Contacts",
        (DevicePermission::Calendar, _) => "Calendar",
        (DevicePermission::Reminders, _) => "Reminders",
        (DevicePermission::Location, _) => "Location",
        (DevicePermission::Notifications, _) => "Notifications",
        (DevicePermission::Motion, DevicePlatform::Ios) => "Motion",
        (DevicePermission::MediaLibrary, _) => "Media library",
        (DevicePermission::Faceid, _) => "Face ID",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::AssetSource as _;

    fn sample_local_host(ios_avail: bool, android_avail: bool) -> DeviceServiceStateHostsItem {
        DeviceServiceStateHostsItem {
            id: "local".to_owned(),
            label: "This Mac".to_owned(),
            platforms: vec![
                DevicePlatformAvailability {
                    platform: DevicePlatform::Ios,
                    available: ios_avail,
                    reason: (!ios_avail).then(|| "Xcode is not installed.".to_owned()),
                },
                DevicePlatformAvailability {
                    platform: DevicePlatform::Android,
                    available: android_avail,
                    reason: (!android_avail).then(|| "Android SDK not found.".to_owned()),
                },
            ],
            tools: None,
            tool_inspection_error: None,
            hub_installed: true,
            agent_device_installed: true,
            kind: DeviceServiceStateHostsItemKind::Local,
        }
    }

    fn sample_device(
        host_id: &str,
        id: &str,
        platform: DevicePlatform,
        name: &str,
        booted: bool,
    ) -> DeviceSummary {
        DeviceSummary {
            host_id: host_id.to_owned(),
            id: id.to_owned(),
            platform,
            name: name.to_owned(),
            version: "18.2".to_owned(),
            booted,
            physical: false,
        }
    }

    #[test]
    fn group_devices_orders_ios_then_android_and_booted_first() {
        let mut state = empty_device_state();
        state.devices = vec![
            sample_device("local", "a2", DevicePlatform::Android, "Pixel 8", false),
            sample_device("local", "i2", DevicePlatform::Ios, "iPhone 16", false),
            sample_device("local", "i1", DevicePlatform::Ios, "iPhone 15 Pro", true),
            sample_device("local", "i3", DevicePlatform::Ios, "iPad Air", false),
            sample_device("local", "a1", DevicePlatform::Android, "Pixel 7", true),
        ];
        let grouped = group_devices(&state);
        assert_eq!(grouped.len(), 2, "two platforms");
        assert_eq!(grouped[0].platform, DevicePlatform::Ios, "iOS first");
        assert_eq!(
            grouped[0]
                .devices
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            vec!["iPhone 15 Pro", "iPad Air", "iPhone 16"]
        );
        assert_eq!(
            grouped[1].platform,
            DevicePlatform::Android,
            "Android second"
        );
        assert_eq!(
            grouped[1]
                .devices
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Pixel 7", "Pixel 8"]
        );
    }

    #[test]
    fn hub_readiness_counts_remote_hosts() {
        let mut state = empty_device_state();
        state.host_status = DeviceHostStatus::Idle;
        state.host_statuses.insert(
            "ssh-1".to_owned(),
            DeviceHostStatusesValue {
                status: DeviceHostStatus::Installing,
                detail: None,
                android_discovery_incomplete: None,
                incomplete_platforms: None,
            },
        );
        assert_eq!(
            device_hub_readiness(&state),
            HubReadiness {
                ready: false,
                busy: true
            }
        );

        state.host_statuses.insert(
            "ssh-2".to_owned(),
            DeviceHostStatusesValue {
                status: DeviceHostStatus::Ready,
                detail: None,
                android_discovery_incomplete: None,
                incomplete_platforms: None,
            },
        );
        assert_eq!(
            device_hub_readiness(&state),
            HubReadiness {
                ready: true,
                busy: false
            }
        );
    }

    #[test]
    fn platform_setup_status_reports_missing_runtime_and_eas_cloud() {
        let mut state = empty_device_state();
        state.host_status = DeviceHostStatus::Ready;
        state.hosts.push(sample_local_host(true, false));

        let ios = platform_setup_status(&state, DevicePlatform::Ios);
        assert!(!ios.ready, "no simulators yet");
        assert!(
            ios.message.contains("Xcode Settings → Components"),
            "got: {}",
            ios.message
        );

        let android = platform_setup_status(&state, DevicePlatform::Android);
        assert!(!android.ready);
        assert_eq!(android.message, "Android SDK not found.");

        state.hosts.clear();
        state.eas_hosts = Some(vec![DeviceServiceStateEasHostsItem {
            id: "eas-1".to_owned(),
            label: "Expo Cloud".to_owned(),
            platforms: vec![DevicePlatformAvailability {
                platform: DevicePlatform::Ios,
                available: true,
                reason: None,
            }],
            tools: None,
            tool_inspection_error: None,
            hub_installed: true,
            agent_device_installed: false,
            kind: lit::Eas,
        }]);
        state.devices.push(sample_device(
            "eas-1",
            "d1",
            DevicePlatform::Ios,
            "iPhone 16",
            false,
        ));
        let eas_ios = platform_setup_status(&state, DevicePlatform::Ios);
        assert!(eas_ios.ready);
        assert_eq!(
            eas_ios.message,
            "Expo Cloud starts iOS Simulators in the cloud with Expo Simulators."
        );
    }

    #[test]
    fn incomplete_listings_and_warning_copy() {
        let status = DeviceHostStatusesValue {
            status: DeviceHostStatus::Ready,
            detail: Some("adb timed out".to_owned()),
            android_discovery_incomplete: Some(true),
            incomplete_platforms: Some(vec![DevicePlatform::Ios]),
        };
        let incomplete = incomplete_listings(Some(&status));
        assert_eq!(
            incomplete,
            vec![DevicePlatform::Ios, DevicePlatform::Android]
        );
        assert_eq!(
            discovery_warning_text("Mac mini", &incomplete),
            "iOS and Android lists on Mac mini may be incomplete."
        );
        assert_eq!(
            discovery_warning_text("Mac mini", &[DevicePlatform::Android]),
            "Android list on Mac mini may be incomplete."
        );
        assert_eq!(
            discovery_warning_text("Mac mini", &[]),
            "Device discovery on Mac mini reported a warning."
        );
    }

    #[test]
    fn active_tool_version_prefers_running_then_required_then_highest_numeric() {
        let running = DeviceToolVersion {
            required_version: "0.15.0".to_owned(),
            installed_versions: vec!["0.14.0".to_owned(), "0.15.0".to_owned()],
            running_version: Some("0.14.0".to_owned()),
        };
        assert_eq!(active_tool_version(&running), Some("0.14.0"));

        let required = DeviceToolVersion {
            required_version: "0.15.0".to_owned(),
            installed_versions: vec!["0.15.0".to_owned(), "0.16.0".to_owned()],
            running_version: None,
        };
        assert_eq!(active_tool_version(&required), Some("0.15.0"));

        let numeric = DeviceToolVersion {
            required_version: "0.20.0".to_owned(),
            installed_versions: vec!["0.9.0".to_owned(), "0.15.2".to_owned(), "0.10.0".to_owned()],
            running_version: None,
        };
        assert_eq!(active_tool_version(&numeric), Some("0.15.2"));
    }

    #[test]
    fn fit_device_frame_preserves_aspect_with_rail_inset() {
        let fitted = fit_device_frame(0.5, 456.0, 600.0, CONTROLS_RAIL_WIDTH_PX);
        assert!((fitted.width - 300.0).abs() < 0.01);
        assert!((fitted.height - 600.0).abs() < 0.01);

        let narrow = fit_device_frame(0.5, 256.0, 600.0, CONTROLS_RAIL_WIDTH_PX);
        assert!((narrow.width - 200.0).abs() < 0.01);
        assert!((narrow.height - 400.0).abs() < 0.01);
    }

    #[test]
    fn coordinate_and_host_draft_validation() {
        assert_eq!(
            parse_coordinates("37.7749", "-122.4194"),
            Some((37.7749, -122.4194))
        );
        assert_eq!(parse_coordinates("91", "0"), None);
        assert_eq!(parse_coordinates("0", "-181"), None);
        assert_eq!(parse_coordinates("", "0"), None);

        assert!(build_ssh_host_config("id".into(), "Mac mini", "nick@mini", "", "22").is_ok());
        assert!(build_ssh_host_config("id".into(), "Mac mini", "nick@mini", "", "70000").is_err());

        assert!(build_eas_host_config("id".into(), "Expo", None, None, "2", "30", "10").is_ok());
        assert_eq!(
            build_eas_host_config("id".into(), "Expo", None, None, "2", "10", "10").unwrap_err(),
            "Idle minutes must be smaller than session minutes."
        );

        assert!(
            build_simlock_host_config(
                "id".into(),
                "Simlock",
                "https://gateway.example.ts.net:4700",
                None,
                "2",
                "60"
            )
            .is_ok()
        );
        assert!(
            build_simlock_host_config(
                "id".into(),
                "Simlock",
                "https://gateway.example.ts.net/extra",
                None,
                "2",
                "60"
            )
            .is_err()
        );
    }

    #[test]
    fn format_rpc_errors_extracts_human_messages() {
        let err = ClientError::Rpc(serde_json::json!({
            "_tag": "DeviceBootError",
            "reason": "timeout",
            "hostId": "local",
            "deviceId": "sim-1"
        }));
        assert_eq!(
            format_client_error(&err),
            "Timed out waiting for the device to start."
        );

        let err_diag = ClientError::Rpc(serde_json::json!({
            "_tag": "DeviceHostUnavailableError",
            "reason": "SSH connection refused"
        }));
        assert_eq!(format_client_error(&err_diag), "SSH connection refused");
    }

    #[test]
    fn every_device_superhero_icon_exists_in_embedded_assets() {
        let assets = crate::superhero::AppAssets;
        for path in USED_SUPERHERO_ICONS {
            let loaded = assets.load(path).expect("asset lookup should succeed");
            assert!(
                loaded.is_some(),
                "device panel superheroicon `{path}` must exist in embedded assets"
            );
        }
    }
}
