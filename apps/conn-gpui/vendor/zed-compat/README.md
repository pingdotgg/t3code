The Zed editor and GPUI Kit share a window and must use the same GPUI types. The four re-export crates forward Zed's dependency names to GPUI Kit's published 0.3.11 crates.

The `path` crate comes from [Zed at f816e1f9](https://github.com/zed-industries/zed/tree/f816e1f9263e3a8ef63c4baaa02e1441ce1c6038/crates/path). Its manifest is standalone. The empty-path check uses `as_os_str().is_empty()` for stable Rust. Its Apache license is included.
