//! Filesystem watcher — keeps the library live without manual rescans.
//!
//! After each completed scan every root is watched recursively (re-armed only
//! when the root set changes). Raw `notify` events are filtered down to things
//! that can actually change the file list — asset extensions plus directory
//! create/remove/rename — and a burst of them debounces (~1.5 s of quiet,
//! trailing edge) into ONE full rescan through the same internal path
//! `start_scan` uses. A full rescan instead of incremental patching on
//! purpose: file ids restart at 0 every generation, so surgical updates would
//! need a whole second id-stability contract; the index fast path already
//! makes a rescan cheap.

use std::path::Path;
use std::time::Duration;

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use crate::scanner;
use crate::types::{AUDIO_EXTENSIONS, MODEL_EXTENSIONS, SKIP_DIRS, TEXTURE_EXTENSIONS};

/// Quiet period a burst must hold before we rescan. A pack unzip or a DCC
/// export touches thousands of files in seconds — one trailing rescan, not one
/// per file.
const DEBOUNCE: Duration = Duration::from_millis(1500);

/// Managed state: the live watcher (dropping it unwatches everything) plus the
/// channel into the debounce thread.
#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    watcher: Option<RecommendedWatcher>,
    /// Sorted copy of the currently-watched roots, so re-arming is a no-op
    /// when only the order changed.
    roots: Vec<String>,
    /// Lazily created together with the debounce thread on first arm.
    tx: Option<crossbeam_channel::Sender<()>>,
}

/// (Re-)arm the watcher over `roots`. Called by the scanner after every
/// completed scan; cheap no-op when the root set is unchanged.
pub fn arm(app: &AppHandle, roots: &[String]) {
    let state = app.state::<WatcherState>();
    let mut inner = state.inner.lock();

    if inner.tx.is_none() {
        let (tx, rx) = crossbeam_channel::unbounded::<()>();
        let app2 = app.clone();
        match std::thread::Builder::new()
            .name("fs-watch-debounce".into())
            .spawn(move || debounce_loop(app2, rx))
        {
            Ok(_) => inner.tx = Some(tx),
            Err(e) => {
                eprintln!("[watch] failed to spawn debounce thread: {e}");
                return;
            }
        }
    }

    let mut sorted = roots.to_vec();
    sorted.sort_unstable();
    if inner.watcher.is_some() && inner.roots == sorted {
        return; // already watching exactly this set
    }

    // Tearing down the old watcher before building the new one keeps at most
    // one set of OS watch handles alive.
    inner.watcher = None;
    inner.roots.clear();
    if roots.is_empty() {
        return;
    }

    let tx = inner.tx.clone().expect("debounce channel exists");
    let filter_roots = roots.to_vec();
    // The handler runs on notify's internal thread — do nothing but filter and
    // poke the debouncer. Send failure means the app is tearing down.
    let handler = move |res: Result<Event, notify::Error>| {
        if let Ok(ev) = res {
            if relevant(&ev, &filter_roots) {
                let _ = tx.send(());
            }
        }
    };
    let mut watcher = match notify::recommended_watcher(handler) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[watch] failed to create watcher: {e}");
            return;
        }
    };
    // Record ONLY the roots whose watch actually took. A per-root failure
    // (unplugged drive, revoked share) must not kill the other roots' watches —
    // but it also must not be remembered as watched, or the "already watching
    // exactly this set" early return above would suppress every retry and the
    // failed root would stay unwatched for the whole session. Dropping it from
    // `roots` makes the next `finish_scan` re-arm re-attempt it.
    let mut watched: Vec<String> = Vec::with_capacity(roots.len());
    for root in roots {
        if let Err(e) = watcher.watch(Path::new(root), RecursiveMode::Recursive) {
            eprintln!("[watch] cannot watch {root}: {e}");
            continue;
        }
        watched.push(root.clone());
    }
    watched.sort_unstable();
    inner.watcher = Some(watcher);
    inner.roots = watched;
}

/// Trailing-edge debounce: block for the first poke of a burst, absorb pokes
/// until [`DEBOUNCE`] of silence, then trigger one rescan. Runs for the app's
/// lifetime.
fn debounce_loop(app: AppHandle, rx: crossbeam_channel::Receiver<()>) {
    loop {
        if rx.recv().is_err() {
            return; // every sender dropped — app shutdown
        }
        while rx.recv_timeout(DEBOUNCE).is_ok() {}
        scanner::rescan_from_watcher(&app);
    }
}

/// Could this event change the scanned file list?
fn relevant(ev: &Event, roots: &[String]) -> bool {
    // Access (reads) fire constantly while thumbnailing/auditioning the very
    // library we're watching — never a reason to rescan.
    if matches!(ev.kind, EventKind::Access(_)) {
        return false;
    }
    ev.paths.iter().any(|p| relevant_path(ev, p, roots))
}

fn relevant_path(ev: &Event, p: &Path, roots: &[String]) -> bool {
    if in_skipped_subtree(p, roots) {
        return false;
    }
    // Directory structure changes always warrant a rescan — a renamed pack
    // folder moves hundreds of assets at once. For removes/rename-sources the
    // inode is gone so `is_dir()` can't answer; "no extension" is the best
    // remaining signal (a removed dir with a dotted name slips through — the
    // cost is a missed auto-refresh, not corruption).
    if matches!(
        ev.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    ) && (p.is_dir() || p.extension().is_none())
    {
        return true;
    }
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let e = ext.to_ascii_lowercase();
            let e = e.as_str();
            AUDIO_EXTENSIONS.contains(&e)
                || TEXTURE_EXTENSIONS.contains(&e)
                || MODEL_EXTENSIONS.contains(&e)
        }
        None => false,
    }
}

/// Mirror of the scanner's `is_skipped_dir` pruning: churn inside `.git`,
/// `.vs`, `node_modules` (a root can be a working repo) must not trigger
/// rescans of content the scanner would never list anyway. Components are
/// checked BELOW the matching root (a root itself may be dot-named), and a
/// plain file's own name is exempt like the scanner exempts files.
///
/// With OVERLAPPING roots one path is covered by several roots, and the scanner
/// lists it as long as ONE covering root reaches it un-pruned (a nested root
/// the user picked inside an outer root's dotted/`node_modules` subtree still
/// scans). So a path counts as skipped only when EVERY covering root prunes it —
/// a single covering root that reaches it means a real rescan is due.
fn in_skipped_subtree(p: &Path, roots: &[String]) -> bool {
    let mut covered = false;
    for root in roots {
        let Ok(rel) = p.strip_prefix(root) else {
            continue;
        };
        covered = true;
        let comps: Vec<&std::ffi::OsStr> = rel
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect();
        let last = comps.len().saturating_sub(1);
        let skipped = comps.iter().enumerate().any(|(i, name)| {
            if i == last && !p.is_dir() {
                return false; // files are never skipped by name — only dirs
            }
            name.to_str().map_or(false, |n| {
                n.starts_with('.') || SKIP_DIRS.iter().any(|s| n.eq_ignore_ascii_case(s))
            })
        });
        if !skipped {
            return false; // reachable un-pruned from this root — not skipped
        }
    }
    covered // pruned by every covering root (false when none cover)
}
