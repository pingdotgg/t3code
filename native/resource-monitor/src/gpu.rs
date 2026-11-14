use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGpu {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utilization_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_used_bytes: Option<u64>,
}

#[derive(Debug, Default)]
pub struct GpuReading {
    pub gpus: Vec<HostGpu>,
    pub unavailable_reason: Option<String>,
}

impl GpuReading {
    /// An empty list always carries a reason, so "no GPU" never reads as a blank.
    fn new(gpus: Vec<HostGpu>, problems: Vec<String>) -> Self {
        let unavailable_reason = if problems.is_empty() {
            gpus.is_empty().then(|| "No GPU found".to_owned())
        } else {
            Some(problems.join("; "))
        };
        Self {
            gpus,
            unavailable_reason,
        }
    }
}

pub fn read_gpus() -> GpuReading {
    platform::read()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{GpuReading, HostGpu};
    use objc2_core_foundation::{
        CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, kCFAllocatorDefault,
    };
    use objc2_io_kit::{
        IOIteratorNext, IOObjectCopyClass, IOObjectRelease, IORegistryEntryCreateCFProperty,
        IORegistryEntrySearchCFProperty, IOServiceGetMatchingServices, IOServiceMatching,
        io_iterator_t, io_registry_entry_t, kIORegistryIterateParents,
        kIORegistryIterateRecursively, kIOReturnSuccess, kIOServicePlane,
    };

    // MACH_PORT_NULL selects the default main port on every macOS version.
    const DEFAULT_MAIN_PORT: u32 = 0;

    pub fn read() -> GpuReading {
        match accelerators() {
            Ok(gpus) => GpuReading::new(gpus, Vec::new()),
            Err(reason) => GpuReading::new(Vec::new(), vec![reason]),
        }
    }

    fn accelerators() -> Result<Vec<HostGpu>, String> {
        // SAFETY: IOServiceMatching takes a NUL-terminated class name.
        let matching = unsafe { IOServiceMatching(c"IOAccelerator".as_ptr()) }
            .ok_or("IOKit has no IOAccelerator matching")?;
        let matching = CFRetained::<CFDictionary>::from(&matching);
        let mut iterator: io_iterator_t = 0;
        // SAFETY: the matching dictionary is consumed and `iterator` is a valid out pointer.
        let status = unsafe {
            IOServiceGetMatchingServices(DEFAULT_MAIN_PORT, Some(matching), &mut iterator)
        };
        if status != kIOReturnSuccess {
            return Err(format!("IOKit GPU lookup failed ({status})"));
        }
        let mut gpus = Vec::new();
        loop {
            let service = IOIteratorNext(iterator);
            if service == 0 {
                break;
            }
            gpus.push(accelerator(service));
            IOObjectRelease(service);
        }
        IOObjectRelease(iterator);
        Ok(gpus)
    }

    fn accelerator(service: io_registry_entry_t) -> HostGpu {
        // Intel Macs keep `model` and `VRAM,totalMB` on the parent PCI device.
        let name = search(service, "model")
            .and_then(|value| text(&value))
            .or_else(|| IOObjectCopyClass(service).map(|class| class.to_string()))
            .unwrap_or_else(|| "GPU".to_owned());
        let statistics = property(service, "PerformanceStatistics")
            .and_then(|value| value.downcast::<CFDictionary>().ok());
        let stat = |key: &str| statistics.as_deref().and_then(|stats| number(stats, key));
        let vram_total = search(service, "VRAM,totalMB")
            .and_then(|value| value.downcast_ref::<CFNumber>().and_then(CFNumber::as_i64))
            .and_then(|mb| u64::try_from(mb).ok())
            .filter(|mb| *mb > 0)
            .map(|mb| mb * 1024 * 1024);
        // Discrete AMD reports VRAM in use; Apple Silicon and Intel share system memory, where
        // "In use system memory" is what the GPU driver holds of it. No total is invented there.
        let vram_used = stat("vramUsedBytes");
        let memory_used_bytes = match (vram_total, vram_used) {
            (_, Some(used)) => u64::try_from(used).ok(),
            (None, None) => stat("In use system memory").and_then(|used| u64::try_from(used).ok()),
            (Some(_), None) => None,
        };
        HostGpu {
            name: name.trim().to_owned(),
            utilization_percent: stat("Device Utilization %").map(|value| value as f64),
            memory_total_bytes: vram_total,
            memory_used_bytes,
        }
    }

    fn property(service: io_registry_entry_t, key: &str) -> Option<CFRetained<CFType>> {
        let key = CFString::from_str(key);
        // SAFETY: `service` is a live registry entry and `key` a valid CFString.
        unsafe { IORegistryEntryCreateCFProperty(service, Some(&key), kCFAllocatorDefault, 0) }
    }

    fn search(service: io_registry_entry_t, key: &str) -> Option<CFRetained<CFType>> {
        let key = CFString::from_str(key);
        // SAFETY: the plane name is NUL-terminated and IOKit only reads it.
        unsafe {
            IORegistryEntrySearchCFProperty(
                service,
                kIOServicePlane.as_ptr().cast_mut().cast(),
                Some(&key),
                kCFAllocatorDefault,
                kIORegistryIterateRecursively | kIORegistryIterateParents,
            )
        }
    }

    fn text(value: &CFType) -> Option<String> {
        if let Some(string) = value.downcast_ref::<CFString>() {
            return Some(string.to_string());
        }
        let bytes = value.downcast_ref::<CFData>()?.to_vec();
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
    }

    fn number(dictionary: &CFDictionary, key: &str) -> Option<i64> {
        let key = CFString::from_str(key);
        let key: *const CFString = &*key;
        // SAFETY: values of an IOKit property dictionary are CF objects, checked before use.
        let value = unsafe { dictionary.value(key.cast()).cast::<CFType>().as_ref() }?;
        value.downcast_ref::<CFNumber>()?.as_i64()
    }
}

#[cfg(any(target_os = "linux", test))]
mod linux_parse {
    use super::HostGpu;

    const MIB: u64 = 1024 * 1024;

    /// One `nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used
    /// --format=csv,noheader,nounits` line per GPU; unsupported fields read `[N/A]`.
    pub fn parse_nvidia_smi(output: &str) -> Vec<HostGpu> {
        output
            .lines()
            .filter_map(|line| {
                let mut fields = line.rsplitn(4, ',').map(str::trim);
                let used = fields.next()?;
                let total = fields.next()?;
                let utilization = fields.next()?;
                let name = fields.next()?;
                if name.is_empty() {
                    return None;
                }
                let mib = |value: &str| value.parse::<u64>().ok().map(|value| value * MIB);
                Some(HostGpu {
                    name: name.to_owned(),
                    utilization_percent: utilization.parse::<f64>().ok(),
                    memory_total_bytes: mib(total),
                    memory_used_bytes: mib(used),
                })
            })
            .collect()
    }

    /// Looks up a device name in a pci.ids database (vendor lines flush left, devices
    /// indented by one tab).
    pub fn pci_device_name(database: &str, vendor: u16, device: u16) -> Option<String> {
        let vendor_prefix = format!("{vendor:04x}  ");
        let device_prefix = format!("\t{device:04x}  ");
        let mut in_vendor = false;
        for line in database.lines() {
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if !line.starts_with('\t') {
                if in_vendor {
                    return None;
                }
                in_vendor = line.starts_with(&vendor_prefix);
            } else if in_vendor && let Some(name) = line.strip_prefix(&device_prefix) {
                return Some(name.trim().to_owned());
            }
        }
        None
    }

    pub fn parse_hex_id(text: &str) -> Option<u16> {
        u16::from_str_radix(text.trim().trim_start_matches("0x"), 16).ok()
    }

    pub fn vendor_name(vendor: u16) -> &'static str {
        match vendor {
            0x1002 => "AMD",
            0x10de => "NVIDIA",
            0x8086 => "Intel",
            _ => "GPU",
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::linux_parse::{parse_hex_id, parse_nvidia_smi, pci_device_name, vendor_name};
    use super::{GpuReading, HostGpu};
    use std::fs;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const NVIDIA: u16 = 0x10de;
    const AMD: u16 = 0x1002;
    const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_secs(2);
    const PCI_IDS: [&str; 3] = [
        "/usr/share/hwdata/pci.ids",
        "/usr/share/misc/pci.ids",
        "/usr/share/pci.ids",
    ];

    struct Card {
        vendor: u16,
        device: u16,
        path: PathBuf,
    }

    pub fn read() -> GpuReading {
        let mut problems = Vec::new();
        let cards = match drm_cards() {
            Ok(cards) => cards,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                problems.push(format!("cannot read /sys/class/drm: {error}"));
                Vec::new()
            }
        };
        let nvidia = nvidia_smi();
        let has_nvidia_card = cards.iter().any(|card| card.vendor == NVIDIA);
        let mut pci_ids: Option<Option<String>> = None;
        let mut gpus = Vec::new();
        for card in &cards {
            if card.vendor == NVIDIA && matches!(nvidia, Some(Ok(_))) {
                continue;
            }
            let name = read_trimmed(&card.path.join("product_name"))
                .filter(|name| !name.is_empty())
                .or_else(|| {
                    pci_ids
                        .get_or_insert_with(|| {
                            PCI_IDS
                                .iter()
                                .find_map(|path| fs::read_to_string(path).ok())
                        })
                        .as_deref()
                        .and_then(|database| pci_device_name(database, card.vendor, card.device))
                        .map(|device| format!("{} {device}", vendor_name(card.vendor)))
                })
                .unwrap_or_else(|| {
                    format!(
                        "{} {:04x}:{:04x}",
                        vendor_name(card.vendor),
                        card.vendor,
                        card.device
                    )
                });
            let mut gpu = HostGpu {
                name,
                ..HostGpu::default()
            };
            if card.vendor == AMD {
                gpu.utilization_percent =
                    read_trimmed(&card.path.join("gpu_busy_percent")).and_then(|v| v.parse().ok());
                gpu.memory_total_bytes = read_trimmed(&card.path.join("mem_info_vram_total"))
                    .and_then(|v| v.parse().ok());
                gpu.memory_used_bytes = read_trimmed(&card.path.join("mem_info_vram_used"))
                    .and_then(|v| v.parse().ok());
            }
            gpus.push(gpu);
        }
        match nvidia {
            Some(Ok(nvidia_gpus)) => gpus.extend(nvidia_gpus),
            Some(Err(reason)) => problems.push(reason),
            None if has_nvidia_card => {
                problems.push("nvidia-smi not found; NVIDIA load and memory are unavailable".into())
            }
            None => {}
        }
        GpuReading::new(gpus, problems)
    }

    fn drm_cards() -> std::io::Result<Vec<Card>> {
        let mut cards = Vec::new();
        for entry in fs::read_dir("/sys/class/drm")? {
            let entry = entry?;
            let file_name = entry.file_name();
            let Some(index) = file_name
                .to_str()
                .and_then(|name| name.strip_prefix("card"))
            else {
                continue;
            };
            // Connectors are listed as card0-HDMI-A-1 and so on.
            if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            let path = entry.path().join("device");
            let (Some(vendor), Some(device)) = (
                read_trimmed(&path.join("vendor")).and_then(|v| parse_hex_id(&v)),
                read_trimmed(&path.join("device")).and_then(|v| parse_hex_id(&v)),
            ) else {
                continue;
            };
            cards.push(Card {
                vendor,
                device,
                path,
            });
        }
        cards.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(cards)
    }

    fn read_trimmed(path: &Path) -> Option<String> {
        fs::read_to_string(path)
            .ok()
            .map(|text| text.trim().to_owned())
    }

    fn find_nvidia_smi() -> Option<PathBuf> {
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
            .chain(["/usr/bin".into(), "/usr/lib/wsl/lib".into()])
            .map(|dir| dir.join("nvidia-smi"))
            .find(|candidate| candidate.is_file())
    }

    /// `None` when the binary is absent; otherwise its GPUs or why it failed.
    fn nvidia_smi() -> Option<Result<Vec<HostGpu>, String>> {
        let binary = find_nvidia_smi()?;
        let mut child = match Command::new(binary)
            .args([
                "--query-gpu=name,utilization.gpu,memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => return Some(Err(format!("nvidia-smi failed to start: {error}"))),
        };
        let deadline = Instant::now() + NVIDIA_SMI_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                _ => break None,
            }
        };
        let Some(status) = status else {
            let _ = child.kill();
            let _ = child.wait();
            return Some(Err("nvidia-smi timed out".into()));
        };
        let mut output = String::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_string(&mut output);
        }
        if !status.success() {
            return Some(Err(format!("nvidia-smi exited with {status}")));
        }
        Some(Ok(parse_nvidia_smi(&output)))
    }
}

#[cfg(any(windows, test))]
mod windows_parse {
    use std::collections::HashMap;

    /// PDH GPU instances embed the adapter LUID as `luid_0x<high>_0x<low>`.
    pub fn instance_luid(instance: &str) -> Option<(u32, u32)> {
        let rest = &instance[instance.find("luid_0x")? + "luid_0x".len()..];
        let (high, rest) = rest.split_once("_0x")?;
        let low = rest.get(..8)?;
        Some((
            u32::from_str_radix(high, 16).ok()?,
            u32::from_str_radix(low, 16).ok()?,
        ))
    }

    /// Task Manager's GPU load: per engine, sum the processes using it; the busiest engine wins.
    pub fn adapter_utilization<'a>(
        samples: impl IntoIterator<Item = (&'a str, f64)>,
    ) -> HashMap<(u32, u32), f64> {
        let mut engines: HashMap<(u32, u32, &str), f64> = HashMap::new();
        for (instance, value) in samples {
            let (Some(luid), Some(at)) = (instance_luid(instance), instance.find("_phys_")) else {
                continue;
            };
            let engine = instance[at..].split("_engtype_").next().unwrap_or_default();
            *engines.entry((luid.0, luid.1, engine)).or_default() += value;
        }
        let mut adapters: HashMap<(u32, u32), f64> = HashMap::new();
        for ((high, low, _), value) in engines {
            let busiest = adapters.entry((high, low)).or_default();
            *busiest = busiest.max(value.clamp(0.0, 100.0));
        }
        adapters
    }
}

#[cfg(windows)]
mod platform {
    use super::windows_parse::{adapter_utilization, instance_luid};
    use super::{GpuReading, HostGpu};
    use std::collections::HashMap;
    use std::thread;
    use std::time::Duration;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
    };
    use windows::Win32::System::Performance::{
        PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT, PDH_FMT_COUNTERVALUE_ITEM_W,
        PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW,
    };
    use windows::core::{PCWSTR, w};

    // Utilization Percentage is a rate counter, so it needs two collections.
    const RATE_WINDOW: Duration = Duration::from_millis(250);

    struct Adapter {
        luid: (u32, u32),
        gpu: HostGpu,
    }

    pub fn read() -> GpuReading {
        let adapters = match adapters() {
            Ok(adapters) => adapters,
            Err(error) => {
                return GpuReading::new(Vec::new(), vec![format!("DXGI unavailable: {error}")]);
            }
        };
        let mut problems = Vec::new();
        let (utilization, dedicated_used) = match counters() {
            Ok(values) => values,
            Err(reason) => {
                if !adapters.is_empty() {
                    problems.push(reason);
                }
                (HashMap::new(), HashMap::new())
            }
        };
        let gpus = adapters
            .into_iter()
            .map(|Adapter { luid, mut gpu }| {
                gpu.utilization_percent = utilization.get(&luid).copied();
                gpu.memory_used_bytes = dedicated_used.get(&luid).copied();
                gpu
            })
            .collect();
        GpuReading::new(gpus, problems)
    }

    fn adapters() -> windows::core::Result<Vec<Adapter>> {
        // SAFETY: plain COM factory creation; no apartment is required for DXGI.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
        let mut adapters = Vec::new();
        let mut index = 0;
        // EnumAdapters1 fails with DXGI_ERROR_NOT_FOUND past the last adapter.
        while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
            index += 1;
            let desc = unsafe { adapter.GetDesc1()? };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let end = desc
                .Description
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(desc.Description.len());
            let luid = (desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart);
            // One physical GPU can surface once per output; the LUID identifies it.
            if adapters.iter().any(|known: &Adapter| known.luid == luid) {
                continue;
            }
            adapters.push(Adapter {
                luid,
                gpu: HostGpu {
                    name: String::from_utf16_lossy(&desc.Description[..end])
                        .trim()
                        .to_owned(),
                    memory_total_bytes: (desc.DedicatedVideoMemory > 0)
                        .then_some(desc.DedicatedVideoMemory as u64),
                    ..HostGpu::default()
                },
            });
        }
        Ok(adapters)
    }

    struct Query(PDH_HQUERY);

    impl Drop for Query {
        fn drop(&mut self) {
            // SAFETY: the handle came from PdhOpenQueryW and is closed once.
            unsafe { PdhCloseQuery(self.0) };
        }
    }

    type Counters = (HashMap<(u32, u32), f64>, HashMap<(u32, u32), u64>);

    fn counters() -> Result<Counters, String> {
        let mut handle = PDH_HQUERY::default();
        // SAFETY: a null data source selects live counters; `handle` is a valid out pointer.
        let status = unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut handle) };
        if status != 0 {
            return Err(format!("GPU counters unavailable (PDH {status:#x})"));
        }
        let query = Query(handle);
        let mut engines = PDH_HCOUNTER::default();
        let mut memory = PDH_HCOUNTER::default();
        // SAFETY: the query is open and the paths are static wide strings.
        unsafe {
            let status = PdhAddEnglishCounterW(
                query.0,
                w!("\\GPU Engine(*)\\Utilization Percentage"),
                0,
                &mut engines,
            );
            if status != 0 {
                return Err(format!("GPU counters unavailable (PDH {status:#x})"));
            }
            let status = PdhAddEnglishCounterW(
                query.0,
                w!("\\GPU Adapter Memory(*)\\Dedicated Usage"),
                0,
                &mut memory,
            );
            if status != 0 {
                return Err(format!("GPU memory counters unavailable (PDH {status:#x})"));
            }
            PdhCollectQueryData(query.0);
        }
        thread::sleep(RATE_WINDOW);
        // SAFETY: the query is open.
        let status = unsafe { PdhCollectQueryData(query.0) };
        if status != 0 {
            return Err(format!("GPU counters unavailable (PDH {status:#x})"));
        }
        let engine_values = counter_array(engines, PDH_FMT_DOUBLE, |item| unsafe {
            item.FmtValue.Anonymous.doubleValue
        })?;
        let utilization = adapter_utilization(
            engine_values
                .iter()
                .map(|(name, value)| (name.as_str(), *value)),
        );
        let mut dedicated = HashMap::new();
        for (name, value) in counter_array(memory, PDH_FMT_LARGE, |item| unsafe {
            item.FmtValue.Anonymous.largeValue
        })? {
            if let (Some(luid), Ok(bytes)) = (instance_luid(&name), u64::try_from(value)) {
                *dedicated.entry(luid).or_default() += bytes;
            }
        }
        drop(query);
        Ok((utilization, dedicated))
    }

    fn counter_array<T>(
        counter: PDH_HCOUNTER,
        format: PDH_FMT,
        value: impl Fn(&PDH_FMT_COUNTERVALUE_ITEM_W) -> T,
    ) -> Result<Vec<(String, T)>, String> {
        let mut size = 0u32;
        let mut count = 0u32;
        // SAFETY: a size query with no buffer; PDH writes the needed byte size.
        let status =
            unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, None) };
        if status == PDH_CSTATUS_VALID_DATA && count == 0 {
            return Ok(Vec::new());
        }
        if status != PDH_MORE_DATA {
            return Err(format!("GPU counters unreadable (PDH {status:#x})"));
        }
        // The buffer holds the items followed by their names, so allocate by bytes.
        let item_size = size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let mut buffer =
            vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); (size as usize).div_ceil(item_size)];
        // SAFETY: `buffer` holds at least `size` bytes, aligned for the item type.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                format,
                &mut size,
                &mut count,
                Some(buffer.as_mut_ptr()),
            )
        };
        if status != PDH_CSTATUS_VALID_DATA {
            return Err(format!("GPU counters unreadable (PDH {status:#x})"));
        }
        Ok(buffer[..count as usize]
            .iter()
            .filter(|item| {
                matches!(
                    item.FmtValue.CStatus,
                    PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA
                )
            })
            // SAFETY: szName points into `buffer` and is NUL-terminated.
            .filter_map(|item| Some((unsafe { item.szName.to_string() }.ok()?, value(item))))
            .collect())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use super::GpuReading;

    pub fn read() -> GpuReading {
        GpuReading::new(
            Vec::new(),
            vec!["GPU reading is not supported on this platform".into()],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::linux_parse::{parse_hex_id, parse_nvidia_smi, pci_device_name, vendor_name};
    use super::windows_parse::{adapter_utilization, instance_luid};
    use super::*;

    #[test]
    fn parses_nvidia_smi_rows_and_unsupported_fields() {
        let gpus = parse_nvidia_smi(
            "NVIDIA GeForce RTX 4090, 37, 24564, 1024\nTesla K80, [N/A], 11441, [N/A]\n\n",
        );
        assert_eq!(
            gpus,
            vec![
                HostGpu {
                    name: "NVIDIA GeForce RTX 4090".into(),
                    utilization_percent: Some(37.0),
                    memory_total_bytes: Some(24_564 * 1024 * 1024),
                    memory_used_bytes: Some(1_024 * 1024 * 1024),
                },
                HostGpu {
                    name: "Tesla K80".into(),
                    utilization_percent: None,
                    memory_total_bytes: Some(11_441 * 1024 * 1024),
                    memory_used_bytes: None,
                },
            ]
        );
        // Commas in a product name stay in the name.
        assert_eq!(parse_nvidia_smi("A, B, 1, 2, 3")[0].name, "A, B");
    }

    #[test]
    fn looks_up_pci_device_names_within_their_vendor() {
        let database = "# comment\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t73bf  Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]\n\t\t1002 0e3a  Radeon RX 6900 XT\n8086  Intel Corporation\n\t73bf  Not this one\n";
        assert_eq!(
            pci_device_name(database, 0x1002, 0x73bf).as_deref(),
            Some("Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]")
        );
        assert_eq!(pci_device_name(database, 0x1002, 0x1234), None);
        assert_eq!(parse_hex_id("0x10de\n").map(vendor_name), Some("NVIDIA"));
    }

    #[test]
    fn sums_processes_per_engine_and_takes_the_busiest_engine() {
        let utilization = adapter_utilization([
            (
                "pid_1_luid_0x00000000_0x0000D1A5_phys_0_eng_0_engtype_3D",
                30.0,
            ),
            (
                "pid_2_luid_0x00000000_0x0000D1A5_phys_0_eng_0_engtype_3D",
                25.0,
            ),
            (
                "pid_2_luid_0x00000000_0x0000D1A5_phys_0_eng_3_engtype_VideoDecode",
                40.0,
            ),
            (
                "pid_3_luid_0x00000001_0x00000002_phys_0_eng_0_engtype_3D",
                250.0,
            ),
            ("not an instance", 99.0),
        ]);
        assert_eq!(utilization.get(&(0, 0xD1A5)), Some(&55.0));
        assert_eq!(utilization.get(&(1, 2)), Some(&100.0));
        assert_eq!(utilization.len(), 2);
        assert_eq!(
            instance_luid("luid_0x00000000_0x0000D1A5_phys_0"),
            Some((0, 0xD1A5))
        );
    }

    #[test]
    fn explains_an_empty_gpu_list() {
        let none = GpuReading::new(Vec::new(), Vec::new());
        assert_eq!(none.unavailable_reason.as_deref(), Some("No GPU found"));
        let found = GpuReading::new(vec![HostGpu::default()], Vec::new());
        assert_eq!(found.unavailable_reason, None);
        let failed = GpuReading::new(Vec::new(), vec!["denied".into()]);
        assert_eq!(failed.unavailable_reason.as_deref(), Some("denied"));
    }
}
