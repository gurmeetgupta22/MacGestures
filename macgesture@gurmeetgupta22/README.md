# MacGesture

GNOME Shell extension providing Mac-style touchpad gestures on **Ubuntu 26.04 / GNOME Shell 50 (Wayland)**.

UUID: `macgesture@gurmeetgupta22`

---

## Features

| Gesture | Default action | Configurable? |
|---|---|---|
| **3-finger horizontal swipe** | Live app switcher (windows slide with fingers) | Finger count only |
| **3-finger swipe up** | Show Activities overview | ✅ Yes |
| **3-finger swipe down** | Disabled | ✅ Yes |
| **3-finger tap** | Disabled | ✅ Yes |
| **4-finger swipe left** | Workspace left | ✅ Yes |
| **4-finger swipe right** | Workspace right | ✅ Yes |
| **4-finger swipe up/down** | Volume up/down | ✅ Yes |
| **4-finger tap** | Disabled | ✅ Yes |

**Available actions for vertical / horizontal swipes:**

- Show Activities, Volume Up/Down, Brightness Up/Down, Maximize/Minimize, Close Window, Show Desktop, Custom Keybind, Disabled

**Available horizontal swipe actions:**

- Workspace Left/Right, Brightness Down/Up, Alt+Tab Prev/Next, Media Prev/Next, Custom Keybind, Disabled

Open **Settings → Extensions → MacGesture** to configure.

---

## Architecture

```
touchpad → GestureHandler (single captured-event::touchpad subscriber)
               │
               ├─ 3-finger (app-switch fingers)
               │      ├─ horizontal → app-switch state machine → AppSwitcher
               │      └─ vertical / tap → OtherGestureHandler
               │
               └─ 4-finger (or 3-finger when app-switch set to 4)
                      └─ OtherGestureHandler (workspace, volume, brightness, media…)
```

| Module | Role |
|---|---|
| `extension.js` | `enable()` / `disable()`, GSettings, builtin GNOME tracker disabling |
| `gestureHandler.js` | Captured-event routing, axis lock (PENDING state machine), `OtherGestureHandler` |
| `appSwitcher.js` | MRU app list, live Clutter.Clone overlay, `Main.activateWindow()` |
| `prefs.js` | Libadwaita preferences UI (3 tabs: App Switcher, 3-Finger, 4-Finger) |
| `schemas/` | GSettings schema |

### Why a custom handler instead of `SwipeTracker`

GNOME 50 `js/ui/swipeTracker.js` is the reference for constants, unaccelerated deltas, axis lock, and velocity. We **do not** use `SwipeTracker` directly because:

1. GNOME 49+ also installs a `Clutter.PanGesture` and treats 3 as a *minimum* finger count — it would steal 3- and 4-finger swipes.
2. `SwipeTracker.enabled = false` while `State.SCROLLING` emits a synthetic `end` (`_interrupt()`). This has caused Overview freezes in other extensions (PaperWM).
3. We need exact finger counts, axis-lock priority, and hand-off between the app-switch and other-gesture paths.

### Axis lock state machine (PENDING)

When a 3-finger gesture begins, the `GestureHandler` enters `PENDING` state and mirrors all events to `OtherGestureHandler`. Once accumulated displacement exceeds `DRAG_THRESHOLD_DISTANCE (16px)`:

- **Horizontal** → `OtherGestureHandler.reset()` (cancels vertical path), app-switch takes over.
- **Vertical / other** → `IGNORED` state; all subsequent events (including END) route to `OtherGestureHandler`.

### APIs that may change

| Assumption | Where it lives | What to check |
|---|---|---|
| `captured-event::touchpad` on `global.stage` | `swipeTracker.js` | Signal name / `Clutter.EventPhase` |
| `event.get_gesture_motion_delta_unaccelerated()` | mutter `Clutter.Event` | Fall back to `get_gesture_motion_delta()` already in code |
| `Main.wm._workspaceAnimation._swipeTracker` | `windowManager.js` + `workspaceAnimation.js` | Private fields |
| `display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)` | `altTab.js` | Tab list enum |
| `Clutter.Clone` of `Meta.WindowActor` | `workspaceAnimation.js` | Clone + `window_group` stacking |
| `Layout.MonitorConstraint` | `ui/layout.js` | Monitor geometry helper |
| `Mtk.Rectangle` | mutter 12+ | Replaced `Meta.Rectangle` |

---

## Install

```bash
cd /path/to/MacGesture
bash install.sh
```

On **Wayland**, log out and back in after installing so GNOME Shell reloads extensions from disk, then:

```bash
gnome-extensions enable macgesture@gurmeetgupta22
```

### Manual install

```bash
EXT="$HOME/.local/share/gnome-shell/extensions/macgesture@gurmeetgupta22"
mkdir -p "$EXT"
cp -a macgesture@gurmeetgupta22/. "$EXT/"
glib-compile-schemas "$EXT/schemas/"
```

---

## Nested Wayland test (safe for the host session)

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Enable the extension in that session and test on hardware touchpad. Watch the host journal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep MacGesture
```

---

## Looking Glass

Press **Alt+F2**, type `lg`, Enter. Useful checks:

```js
Main.wm._workspaceAnimation._swipeTracker.enabled
Main.actionMode
global.get_window_actors().length
```

Errors from this extension are tagged `[MacGesture]`.

---

## Pack for extensions.gnome.org

```bash
cd macgesture@gurmeetgupta22
gnome-extensions pack --force \
    --extra-source=gestureHandler.js \
    --extra-source=appSwitcher.js \
    --extra-source=README.md
```

---

## Settings reference

| Key | Default | Description |
|---|---|---|
| Finger count | 3 | Fingers for app-switch (3 disables native 3-finger workspace swipe) |
| Invert swipe direction | off | Invert the app-switch horizontal direction |
| Swipe distance threshold | 0.40 | Fraction of ~400px to commit without a flick |
| Animation style | Live | Live = clones follow fingers; Simple = switch on end only |
| Animation duration | 250 ms | Commit / snap-back animation |
| All workspaces | off | Off = current workspace apps only |
| Ignore fullscreen | off | Skip gesture while a fullscreen window is focused |

---

## Known limitations

- **Nested mutter** often has no real multitouch touchpad stream; test on hardware Wayland.
- **Clones** show the live actor. Minimized targets use an app-icon placeholder.
- **One running app**: gesture is ignored.
- **Overview, lock screen, modal dialogs**: app-switch is ignored. 3-finger vertical still works in Overview (hierarchical nav: desktop → overview → app grid).
- **Private Shell fields** (`_workspaceAnimation._swipeTracker`) can move across GNOME versions.
- **X11**: not a goal. Ubuntu 26.04 is Wayland-first.

---

## License

GPL-2.0-or-later (required for GNOME Shell extensions).
