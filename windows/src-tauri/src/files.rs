// Dropped files are copied into %LOCALAPPDATA%\Coucou\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    ingest_into(&inbox_dir(), source)
}

/// `ingest` with the inbox spelled out, so the test can use a temporary folder
/// instead of the real inbox of whoever runs it.
fn ingest_into(dir: &Path, source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders can't be dropped yet.".into());
    }

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let dest = free_path(dir, &name, &stem, &ext);

    std::fs::copy(src, &dest).map_err(|e| format!("cannot copy: {e}"))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// `dir\name`, or `dir\stem (2).ext`, `(3)`… when that is taken: a new file
/// never clobbers one already there.
fn free_path(dir: &Path, name: &str, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    (2..1000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// The largest image a paste may bring. A full-screen screenshot of a 4K
/// display is a few MB as PNG; past this it is not a screenshot.
const MAX_PASTED: usize = 25 * 1024 * 1024;

/// An image pasted into the chat (`Ctrl+V`): written into the inbox as
/// `pegada-<date>-<time>.<ext>`, so the chat reads it like a dropped file.
/// `mime` is the clipboard's type for it; only images Claude can read are kept.
pub fn save_pasted(bytes: &[u8], mime: &str) -> Result<DroppedFile, String> {
    save_pasted_into(&inbox_dir(), bytes, mime, &local_stamp())
}

/// `save_pasted` with the inbox and the time spelled out, for the tests.
fn save_pasted_into(dir: &Path, bytes: &[u8], mime: &str, stamp: &str) -> Result<DroppedFile, String> {
    let ext = match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err("Only PNG, JPEG, GIF and WebP images can be pasted.".into()),
    };
    if bytes.is_empty() {
        return Err("The pasted image is empty.".into());
    }
    if bytes.len() > MAX_PASTED {
        return Err(format!("The pasted image is too big ({} MB).", bytes.len() / (1024 * 1024)));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stem = format!("pegada-{stamp}");
    let name = format!("{stem}.{ext}");
    let dest = free_path(dir, &name, &stem, &format!(".{ext}"));
    std::fs::write(&dest, bytes).map_err(|e| format!("cannot save the image: {e}"))?;
    sweep(dir);
    Ok(DroppedFile {
        name: dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name),
        path: dest.to_string_lossy().to_string(),
        size: bytes.len() as u64,
    })
}

/// Local date and time as `20261005-134512`, for a pasted image's name.
fn local_stamp() -> String {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("coucou-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Never the real inbox: this test copies, and the sweep deletes.
        let inbox = tmp.join("inbox");
        let ingest = |p: &Path| ingest_into(&inbox, p.to_str().unwrap());
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(&source).unwrap();
        assert!(Path::new(&first.path).starts_with(&inbox));
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(&source).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(&tmp).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(&old_source).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_pasted_image_lands_in_the_inbox_under_its_own_name() {
        let tmp = std::env::temp_dir().join(format!("coucou-paste-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        // Never the real inbox: this test writes, and the sweep deletes.
        let inbox = tmp.join("inbox");
        let png = b"\x89PNG\r\n\x1a\nfake";

        let first = save_pasted_into(&inbox, png, "image/png", "20261005-134512").unwrap();
        assert_eq!(first.name, "pegada-20261005-134512.png");
        assert_eq!(Path::new(&first.path), inbox.join("pegada-20261005-134512.png"));
        assert_eq!(first.size, png.len() as u64);
        assert_eq!(std::fs::read(&first.path).unwrap(), png);

        // Two pastes in the same second keep both.
        let second = save_pasted_into(&inbox, b"other", "image/png", "20261005-134512").unwrap();
        assert_eq!(second.name, "pegada-20261005-134512 (2).png");
        assert_eq!(std::fs::read(&first.path).unwrap(), png);

        // The type names the extension; anything but an image Claude reads is refused.
        assert_eq!(save_pasted_into(&inbox, b"j", "image/jpeg", "1").unwrap().name, "pegada-1.jpg");
        assert_eq!(save_pasted_into(&inbox, b"w", "IMAGE/WEBP", "1").unwrap().name, "pegada-1.webp");
        for mime in ["image/svg+xml", "text/plain", "application/octet-stream", ""] {
            assert!(save_pasted_into(&inbox, b"x", mime, "2").is_err(), "{mime:?} accepted");
        }
        assert!(save_pasted_into(&inbox, b"", "image/png", "3").is_err());
        assert!(save_pasted_into(&inbox, &vec![0u8; MAX_PASTED + 1], "image/png", "4").is_err());
        assert!(!inbox.join("pegada-2.png").exists() && !inbox.join("pegada-3.png").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_paste_stamp_is_a_date_and_a_time() {
        let s = local_stamp();
        assert_eq!(s.len(), 15, "{s}");
        assert!(s.chars().enumerate().all(|(i, c)| if i == 8 { c == '-' } else { c.is_ascii_digit() }), "{s}");
    }
}
