//! Compiles the macOS AppKit shim the embedded CEF browser needs.

fn main() {
    println!("cargo:rerun-if-changed=native/appkit_hooks.m");
    let is_macos = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if is_macos {
        cc::Build::new()
            .file("native/appkit_hooks.m")
            .flag("-fobjc-arc")
            .compile("conn_web_appkit");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
