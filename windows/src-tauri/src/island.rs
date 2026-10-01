// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through, the cursor poll and the
// drag that moves the island along the top edge.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// of the main display inside a borderless, transparent, always-on-top window
// that never takes focus. It starts centred; the user can drag it sideways
// (this fork), and where it was left is kept in the settings as `island_x`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use windows::Win32::Foundation::{HWND, POINT};
use windows::core::BOOL;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::System::Ole::RevokeDragDrop;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

/// Logical width of the compact island (COMPACT_W in src/core/layout.ts): the
/// narrowest the island is ever seen, so the width that has to stay on screen.
const COMPACT_W: f64 = 288.0;
/// A dragged island this close to the display's centre, in logical px, snaps
/// to it: the way back to the middle, without a reset button.
const MAGNET: f64 = 24.0;
/// How far the pointer travels, in logical px, before a press on the island is
/// a drag rather than a click.
const DRAG_THRESHOLD: f64 = 4.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into Win32 when it changes.
    ignoring: AtomicBool,
    /// The island's centre inside the panel window, logical px. 360 — the middle
    /// of the 720 px panel — unless the island was dragged against an edge.
    cx: Mutex<f64>,
    /// A press on the island that may become a drag (see `Press`).
    press: Mutex<Option<Press>>,
    /// The last placement written to the log, so only changes are.
    placed: Mutex<String>,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
            cx: Mutex::new(PANEL_W / 2.0),
            press: Mutex::new(None),
            placed: Mutex::new(String::new()),
        }
    }

    /// The island's centre inside the panel window, logical px.
    pub fn island_cx(&self) -> f64 {
        *self.cx.lock().unwrap()
    }

    /// Drops a press in flight: the panel it was dragging is going away.
    pub fn cancel_press(&self) {
        *self.press.lock().unwrap() = None;
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// Lets dropped files reach the app again.
///
/// wry installs its drop target by walking the webview's child windows **once**,
/// when the webview is created. WebView2 creates `Chrome_RenderWidgetHostHWND`
/// later and registers its own target on it; being the innermost window, that one
/// wins, and since the page has no HTML5 drop handler it refuses everything — the
/// "no drop" cursor, with nothing reaching Tauri. Revoking it makes OLE fall
/// through to the target wry registered on the parent widget, which is the one
/// that feeds Tauri's drag events.
///
/// Cheap and idempotent, so it is simply re-run whenever a drag might be starting.
pub fn unblock_webview_drops(app: &AppHandle) {
    for label in [WINDOW_LABEL, "settings"] {
        let Some(win) = app.get_webview_window(label) else { continue };
        let Some(hwnd) = hwnd_of(&win) else { continue };
        unsafe {
            let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
        }
    }
}

unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
    let mut name = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    if len > 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
    }
    true.into()
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

// ── Where along the top edge ────────────────────────────────────────────────
//
// The island's position is one number, its *anchor*: the x of its centre on
// the display, in logical px from the display's left edge. The window is put
// around it, but never past the display's edges: near an edge the window stops
// and the island slides inside it instead (`window_left`). That is what lets
// the island sit flush against an edge and open inwards, rather than half of
// the expanded island hanging off the screen.

/// The anchor for a stored `island_x` (a fraction of the display's width).
/// None, or anything not finite, is the centre. Clamped so the compact island
/// never leaves the screen.
pub fn anchor_for(frac: Option<f64>, display_w: f64) -> f64 {
    let frac = frac.filter(|f| f.is_finite()).unwrap_or(0.5);
    clamp_anchor(frac * display_w, display_w)
}

fn clamp_anchor(anchor: f64, display_w: f64) -> f64 {
    let half = COMPACT_W / 2.0;
    if display_w <= COMPACT_W {
        return display_w / 2.0;
    }
    anchor.clamp(half, display_w - half)
}

/// The anchor a drag that started at `start` has reached after `dx` logical
/// px: clamped to the display, and pulled to its centre when close to it.
pub fn dragged_anchor(start: f64, dx: f64, display_w: f64) -> f64 {
    let anchor = clamp_anchor(start + dx, display_w);
    let centre = display_w / 2.0;
    if (anchor - centre).abs() <= MAGNET {
        centre
    } else {
        anchor
    }
}

/// Left edge of a window `window_w` wide around `anchor`, logical px from the
/// display's left edge: centred on the anchor, but kept on the display. A
/// display narrower than the window gets the window at its left edge.
pub fn window_left(anchor: f64, window_w: f64, display_w: f64) -> f64 {
    let max = (display_w - window_w).max(0.0);
    (anchor - window_w / 2.0).clamp(0.0, max)
}

/// A display as the placement math needs it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    /// Top-left corner, physical px.
    pub x: i32,
    pub y: i32,
    /// Width, logical px.
    pub width: f64,
    pub scale: f64,
}

impl Display {
    fn of(m: &Monitor) -> Self {
        let scale = m.scale_factor();
        Self {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width as f64 / scale,
            scale,
        }
    }

    /// Physical x of the left edge of a window `window_w` logical px wide
    /// around `anchor`.
    pub fn window_x(&self, anchor: f64, window_w: f64) -> i32 {
        self.x + (window_left(anchor, window_w, self.width) * self.scale).round() as i32
    }

    /// The island's centre inside the panel window placed for `anchor`,
    /// logical px. Taken from the rounded physical position, so the island is
    /// drawn exactly where the anchor is.
    pub fn panel_cx(&self, anchor: f64) -> f64 {
        anchor - (self.window_x(anchor, PANEL_W) - self.x) as f64 / self.scale
    }
}

/// Stores the island's centre inside the panel and tells the island when it
/// changed (`island-anchor`, logical px).
fn publish_cx(app: &AppHandle, gate: &PollGate, cx: f64) {
    {
        let mut current = gate.cx.lock().unwrap();
        if (*current - cx).abs() < 0.01 {
            return;
        }
        *current = cx;
    }
    let _ = app.emit_to(WINDOW_LABEL, "island-anchor", cx);
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the
/// panel. The display comes from the `screen` setting, the spot along its top
/// edge from `island_x`.
pub fn apply_geometry(app: &AppHandle, collapsed: bool) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let (pref, frac) = {
        let s = shared.settings.lock().unwrap();
        (s.screen.clone(), s.island_x)
    };
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, &pref) else { return };
    let display = Display::of(&m);
    let anchor = anchor_for(frac, display.width);

    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * display.scale).round().max(1.0) as u32;
    let ph = (lh * display.scale).round().max(1.0) as u32;
    let x = display.window_x(anchor, lw);
    let y = display.y;

    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical
    // size — and the position, which the rect Windows suggests for the new DPI
    // can shift too. A centred island hid that; one flush with an edge shows it.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_always_on_top(true);
    // The panel's value even while the strip is up, so the island is already in
    // the right place the moment the panel comes back.
    let cx = display.panel_cx(anchor);
    // Logged when it changes — a new display, scale or position — not on every
    // show and hide: what to look at when the island turns up somewhere odd.
    let placed = format!(
        "island placed: display x={} w={:.0} scale={} · anchor {anchor:.0} · panel x={} · island cx {cx:.0}",
        display.x,
        display.width,
        display.scale,
        display.window_x(anchor, PANEL_W),
    );
    let mut last = shared.gate.placed.lock().unwrap();
    if *last != placed {
        crate::log::line(placed.clone());
        *last = placed;
    }
    drop(last);
    publish_cx(app, &shared.gate, cx);
}

// ── Dragging ────────────────────────────────────────────────────────────────
//
// The island asks for a drag on mousedown (`press`); from there the cursor poll
// owns it, reading the real pointer and button with Win32 at every tick. Only
// the poll can: once the island stops at a display edge the pointer leaves it,
// the window turns click-through again, and the page no longer sees the mouse.

/// One press on the island, from mousedown to release.
#[derive(Clone, Copy, Debug)]
pub struct Press {
    /// Pointer x when the press landed, physical px.
    cursor_x: f64,
    /// The anchor when the press landed, and the last one the drag reached.
    start: f64,
    anchor: f64,
    display: Display,
    dragging: bool,
}

/// What one poll tick makes of a press.
#[derive(Debug, PartialEq)]
pub enum PressStep {
    /// Still under the drag threshold: so far, a click.
    Pending,
    /// The threshold was crossed on this tick; the island goes to this anchor.
    Start(f64),
    Move(f64),
    /// Released after a drag, at this anchor.
    End(f64),
    /// Released without a drag: a click, which the page handles itself.
    Click,
}

impl Press {
    pub fn new(cursor_x: f64, anchor: f64, display: Display) -> Self {
        Self { cursor_x, start: anchor, anchor, display, dragging: false }
    }

    pub fn step(&mut self, cursor_x: f64, down: bool) -> PressStep {
        if !down {
            return if self.dragging { PressStep::End(self.anchor) } else { PressStep::Click };
        }
        let dx = (cursor_x - self.cursor_x) / self.display.scale;
        if !self.dragging && dx.abs() < DRAG_THRESHOLD {
            return PressStep::Pending;
        }
        let started = !self.dragging;
        self.dragging = true;
        self.anchor = dragged_anchor(self.start, dx, self.display.width);
        if started {
            PressStep::Start(self.anchor)
        } else {
            PressStep::Move(self.anchor)
        }
    }
}

/// mousedown on the compact island, or on the open island's header strip.
/// Nothing moves until the pointer has travelled DRAG_THRESHOLD.
pub fn press(app: &AppHandle, gate: &PollGate) {
    // Already released by the time the IPC call lands: it was a click. Arming
    // it anyway would let the next press — anywhere, in any window — drag us.
    if gate.collapsed.load(Ordering::Relaxed) || !left_button_down() {
        return;
    }
    let Some(win) = window(app) else { return };
    let Some((cursor_x, _)) = cursor_physical() else { return };
    // The display the island is on and where it is drawn right now — what the
    // user grabbed — rather than what the settings say.
    let Ok(Some(m)) = win.current_monitor() else { return };
    let Ok(origin) = win.outer_position() else { return };
    let display = Display::of(&m);
    let anchor = (origin.x - display.x) as f64 / display.scale + gate.island_cx();
    *gate.press.lock().unwrap() = Some(Press::new(cursor_x, anchor, display));
}

/// One poll tick of the press in flight, if there is one.
fn drag_tick(app: &AppHandle, gate: &PollGate, win: &WebviewWindow, cursor_x: f64, down: bool) {
    let (step, display) = {
        let mut guard = gate.press.lock().unwrap();
        let Some(press) = guard.as_mut() else { return };
        let step = press.step(cursor_x, down);
        let display = press.display;
        if matches!(step, PressStep::Click | PressStep::End(_)) {
            *guard = None;
        }
        (step, display)
    };
    match step {
        PressStep::Pending | PressStep::Click => {}
        PressStep::Start(anchor) | PressStep::Move(anchor) => {
            if matches!(step, PressStep::Start(_)) {
                let _ = app.emit_to(WINDOW_LABEL, "island-drag", "start");
            }
            let x = display.window_x(anchor, PANEL_W);
            if win.outer_position().map(|p| p.x != x).unwrap_or(true) {
                let _ = win.set_position(PhysicalPosition::new(x, display.y));
            }
            publish_cx(app, gate, display.panel_cx(anchor));
        }
        PressStep::End(anchor) => {
            let frac = anchor / display.width;
            if let Some(shared) = app.try_state::<crate::Shared>() {
                let snapshot = {
                    let mut s = shared.settings.lock().unwrap();
                    s.island_x = Some(frac);
                    s.clone()
                };
                if let Err(err) = crate::settings::save(&snapshot) {
                    crate::log::line(format!("could not save the island position: {err}"));
                }
            }
            crate::log::line(format!("island moved to x={frac:.3} of the display"));
            let _ = app.emit_to(WINDOW_LABEL, "island-drag", "end");
        }
    }
}

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Some((cx, cy)) = cursor_physical() else { continue };
                let down = left_button_down();
                // Ahead of the still-pointer shortcut below, so a release is
                // seen even when the pointer has not moved; and ahead of reading
                // the window's origin, which a drag tick may just have moved.
                drag_tick(&app, &gate, &win, cx, down);

                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || unblock_webview_drops(&handle));
                }
                was_down = down;

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: f64 = 1920.0;

    fn display(x: i32, width: f64, scale: f64) -> Display {
        Display { x, y: 0, width, scale }
    }

    #[test]
    fn no_stored_position_is_the_centre() {
        assert_eq!(anchor_for(None, FHD), 960.0);
        assert_eq!(anchor_for(Some(f64::NAN), FHD), 960.0);
        assert_eq!(anchor_for(Some(f64::INFINITY), FHD), 960.0);
    }

    #[test]
    fn a_stored_position_is_a_fraction_of_the_display() {
        assert_eq!(anchor_for(Some(0.75), FHD), 1440.0);
        // The same fraction on a wider display lands on the same relative spot.
        assert_eq!(anchor_for(Some(0.75), 2560.0), 1920.0);
    }

    #[test]
    fn the_compact_island_never_leaves_the_display() {
        assert_eq!(anchor_for(Some(0.0), FHD), COMPACT_W / 2.0);
        assert_eq!(anchor_for(Some(1.0), FHD), FHD - COMPACT_W / 2.0);
        assert_eq!(anchor_for(Some(-3.0), FHD), COMPACT_W / 2.0);
        // A display narrower than the island itself: centred, nothing to clamp to.
        assert_eq!(anchor_for(Some(0.0), 200.0), 100.0);
    }

    #[test]
    fn a_drag_close_to_the_centre_snaps_to_it() {
        assert_eq!(dragged_anchor(1300.0, -330.0, FHD), 960.0); // 970: 10 px off
        assert_eq!(dragged_anchor(600.0, 336.0, FHD), 960.0); // 936: 24 px off
        assert_eq!(dragged_anchor(600.0, 335.0, FHD), 935.0); // 25 px off: left alone
    }

    #[test]
    fn a_drag_stops_at_the_display_edges() {
        assert_eq!(dragged_anchor(960.0, 5000.0, FHD), FHD - COMPACT_W / 2.0);
        assert_eq!(dragged_anchor(960.0, -5000.0, FHD), COMPACT_W / 2.0);
    }

    #[test]
    fn the_window_is_centred_on_the_anchor_until_it_meets_an_edge() {
        assert_eq!(window_left(960.0, PANEL_W, FHD), 600.0);
        assert_eq!(window_left(1500.0, PANEL_W, FHD), 1140.0);
        // Flush right: the window stops at the edge, the island slides inside it.
        assert_eq!(window_left(FHD - 144.0, PANEL_W, FHD), FHD - PANEL_W);
        assert_eq!(window_left(144.0, PANEL_W, FHD), 0.0);
        // The wake strip is narrower than the compact island: it always centres.
        assert_eq!(window_left(144.0, STRIP_W, FHD), 24.0);
        // A display narrower than the panel: at its left edge.
        assert_eq!(window_left(300.0, PANEL_W, 600.0), 0.0);
    }

    #[test]
    fn the_island_centre_inside_the_panel() {
        let d = display(0, FHD, 1.0);
        assert_eq!(d.panel_cx(960.0), PANEL_W / 2.0);
        assert_eq!(d.panel_cx(1500.0), PANEL_W / 2.0);
        // Flush right: 144 px from the panel's right edge, i.e. the compact
        // island's right edge on the panel's — and so on the display's.
        assert_eq!(d.panel_cx(FHD - 144.0), PANEL_W - 144.0);
        assert_eq!(d.panel_cx(144.0), 144.0);
    }

    #[test]
    fn placement_on_a_scaled_display_left_of_the_primary() {
        // 2560×1440 physical at 150 % to the left of the primary: 1706.67
        // logical px wide, starting at x = -2560 physical.
        let d = display(-2560, 2560.0 / 1.5, 1.5);
        let anchor = anchor_for(None, d.width);
        let x = d.window_x(anchor, PANEL_W);
        // Centred: (1706.67 - 720) / 2 = 493.33 logical = 740 physical.
        assert_eq!(x, -2560 + 740);
        assert!((d.panel_cx(anchor) - PANEL_W / 2.0).abs() < 1.0 / 1.5);
        let right = anchor_for(Some(1.0), d.width);
        assert_eq!(d.window_x(right, PANEL_W), -2560 + 2560 - 1080); // flush with its right edge
    }

    #[test]
    fn a_press_is_a_click_until_the_pointer_travels() {
        let mut p = Press::new(1000.0, 960.0, display(0, FHD, 1.0));
        assert_eq!(p.step(1003.0, true), PressStep::Pending);
        assert_eq!(p.step(997.0, true), PressStep::Pending);
        assert_eq!(p.step(1003.0, false), PressStep::Click);
    }

    #[test]
    fn a_press_that_travels_becomes_a_drag_and_ends_where_released() {
        let mut p = Press::new(1000.0, 960.0, display(0, FHD, 1.0));
        assert_eq!(p.step(1100.0, true), PressStep::Start(1060.0));
        assert_eq!(p.step(1300.0, true), PressStep::Move(1260.0));
        // Coming back under the threshold does not turn it into a click again.
        assert_eq!(p.step(1001.0, true), PressStep::Move(960.0));
        assert_eq!(p.step(1400.0, true), PressStep::Move(1360.0));
        assert_eq!(p.step(1400.0, false), PressStep::End(1360.0));
    }

    #[test]
    fn the_threshold_and_the_drag_are_in_logical_px() {
        // At 200 % six physical px are three logical: still a click.
        let mut p = Press::new(1000.0, 960.0, display(0, FHD, 2.0));
        assert_eq!(p.step(1006.0, true), PressStep::Pending);
        assert_eq!(p.step(1400.0, true), PressStep::Start(1160.0));
    }

    #[test]
    fn a_drag_from_an_edge_back_to_the_middle_snaps() {
        let mut p = Press::new(1800.0, FHD - 144.0, display(0, FHD, 1.0));
        assert_eq!(p.step(1000.0, true), PressStep::Start(960.0)); // 976: 16 px off
        assert_eq!(p.step(1000.0, false), PressStep::End(960.0));
    }
}
