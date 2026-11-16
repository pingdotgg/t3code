//! T3 HtmlRender publication: preparation, files, limits and signed HTML delivery.
use conn_files::{Files, html};
use std::{fs, path::PathBuf};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("conn-html-{}", conn_support::uuid_v4()));
        fs::create_dir_all(&dir).expect("create temporary HTML fixture");
        Self(dir)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn publish_inlines_images_injects_theme_and_clamps_reference() {
    let tmp = Scratch::new();
    let files = Files::open(&tmp.0).unwrap();
    let png = tmp.0.join("image.png");
    fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
    let source = format!(
        "<!doctype html><html><head><title>A</title></head><body><img src=\"{}\"><script>const x='{}';</script></body></html>",
        png.display(),
        png.display()
    );
    let page = html::publish(&files, "thread:one", &source, "  ", 10).unwrap();
    assert_eq!(page.title, "HTML");
    assert_eq!(page.height, 80);
    assert!(page.attachment_id.starts_with("thread-one-"));
    assert!(page.attachment_id.ends_with("-html"));
    let attachment = files.attachments.resolve(&page.attachment_id).unwrap();
    let body = fs::read_to_string(&attachment.path).unwrap();
    assert!(body.contains("data:image/png;base64,iVBORw0KGgo="));
    assert!(!body.contains(png.to_str().unwrap()));
    assert!(body.find("t3-theme").unwrap() < body.find("<title>").unwrap());
    let headers = conn_files::assets::response_headers(
        &attachment.path,
        conn_files::assets::Disposition::Inline,
        None,
        None,
    );
    assert!(
        headers
            .iter()
            .any(|(name, value)| *name == "content-security-policy"
                && value == "sandbox allow-scripts allow-forms allow-popups allow-downloads")
    );
}

#[test]
fn rejects_css_viewport_height_but_ignores_text_comments_and_image_data() {
    for source in [
        "<style>main{min-height:100vh}</style>",
        "<style media=screen>main{height:calc(100dvh - 2rem)}",
        "<div style='top:.5svh'>",
        "<div style=height:100vh>",
    ] {
        assert!(
            html::prepare(source)
                .unwrap_err()
                .to_string()
                .contains("viewport height unit"),
            "{source}"
        );
    }
    for source in [
        "<p>Avoid 100vh</p><!-- <div style=\"height:100vh\"> -->",
        "<script>const x='100vh';</script>",
        "<style>p{background:url(data:image/png;base64,AB1vh+2vh/3vhC);width:100vw}</style>",
    ] {
        assert!(html::prepare(source).is_ok(), "{source}");
    }
}

#[test]
fn validates_local_image_bytes_and_reports_missing_once_in_order() {
    let tmp = Scratch::new();
    let fake = tmp.0.join("secret.svg");
    fs::write(&fake, "<!doctype html><body><svg/>secret").unwrap();
    let missing = tmp.0.join("missing.png");
    let source = format!(
        "<img src='{}'><script>const x=`{}`;</script><img src=\"{}\">",
        fake.display(),
        missing.display(),
        fake.display()
    );
    assert_eq!(
        html::prepare(&source).unwrap_err().to_string(),
        format!(
            "These local images could not be read: {}, {}. Use absolute paths to existing image files, or remove them.",
            fake.display(),
            missing.display()
        )
    );
    let svg = tmp.0.join("valid.svg");
    fs::write(
        &svg,
        "<?xml version=\"1.0\"?><!DOCTYPE svg [<!-- ]> --><!ENTITY x \"red\">]><svg/>",
    )
    .unwrap();
    assert!(
        html::prepare(&format!("<img src='{}'>", svg.display()))
            .unwrap()
            .contains("data:image/svg+xml;base64,")
    );
    let big = tmp.0.join("big.png");
    fs::File::create(&big)
        .unwrap()
        .set_len(10 * 1024 * 1024 + 1)
        .unwrap();
    assert!(
        html::prepare(&format!("<img src='{}'>", big.display()))
            .unwrap_err()
            .to_string()
            .contains("each local image must be at most 10.0 MiB")
    );
    fs::File::create(&big)
        .unwrap()
        .set_len(8 * 1024 * 1024)
        .unwrap();
    assert!(
        html::prepare(&format!("<img src='{}'>", big.display()).repeat(4))
            .unwrap_err()
            .to_string()
            .contains("With its images inlined")
    );
}

#[test]
fn reads_html_documents_only_and_refuses_internal_links_and_hard_links() {
    let tmp = Scratch::new();
    let files = Files::open(&tmp.0).unwrap();
    let page = tmp.0.join("page.HTML");
    fs::write(&page, "  <!DOCTYPE HTML><p>works</p>").unwrap();
    assert!(html::read_source(&files, &page.to_string_lossy()).is_ok());
    fs::write(&page, "KEY=secret").unwrap();
    assert!(html::read_source(&files, &page.to_string_lossy()).is_err());
    fs::write(&page, "<html>valid</html>").unwrap();
    let link = tmp.0.join("linked.html");
    fs::hard_link(&page, &link).unwrap();
    assert!(html::read_source(&files, &link.to_string_lossy()).is_err());
    let internal = tmp.0.join("secrets/private.html");
    fs::write(&internal, "<html>private</html>").unwrap();
    assert!(html::read_source(&files, &internal.to_string_lossy()).is_err());
    assert!(html::read_source(&files, "relative.html").is_err());
    let huge = tmp.0.join("huge.html");
    fs::File::create(&huge)
        .unwrap()
        .set_len(25 * 1024 * 1024 + 1)
        .unwrap();
    assert!(
        html::read_source(&files, &huge.to_string_lossy())
            .unwrap_err()
            .to_string()
            .contains("a page must be at most 25.0 MiB")
    );
    #[cfg(unix)]
    {
        let secret = tmp.0.join("secret.txt");
        fs::write(&secret, "<html>renamed</html>").unwrap();
        let sym = tmp.0.join("symlink.html");
        std::os::unix::fs::symlink(secret, &sym).unwrap();
        assert!(html::read_source(&files, &sym.to_string_lossy()).is_err());
    }
}
