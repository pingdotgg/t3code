//! Compiles the macOS AppKit shim for CEF when the `cef` feature is enabled.

fn main() {
    println!("cargo:rerun-if-changed=native/appkit_hooks.m");
    let cef_enabled = std::env::var_os("CARGO_FEATURE_CEF").is_some();
    let is_macos = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if cef_enabled && is_macos {
        cc::Build::new()
            .file("native/appkit_hooks.m")
            .flag("-fobjc-arc")
            .compile("conn_web_appkit");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
