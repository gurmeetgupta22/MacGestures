# MacGesture

GNOME Shell extension that switches **running applications** with a **3-finger (or 4-finger) horizontal touchpad swipe**. The switch is interactive: windows slide with your fingers, then commit or snap back — the same idea as GNOME’s native workspace swipe.

Target: **Ubuntu 26.04 / GNOME Shell 50** (Wayland). `metadata.json` also lists **GNOME 49**.

UUID: `macgesture@gurmeetgupta22`

## Architecture

```
touchpad  →  GestureHandler (captured-event::touchpad, axis lock)
                 │
                 ├─ vertical  → EVENT_PROPAGATE (Overview / App Grid keep working)
                 └─ horizontal of N fingers → EVENT_STOP + progress/velocity
                                                 │
                                                 ▼
                                            AppSwitcher
                                      MRU apps (one window per app)
                                      Live: Clutter.Clone overlay
                                      Simple: activate on gesture end
```

| Module | Role |
| --- | --- |
| `extension.js` | `enable()` / `disable()`, GSettings, native workspace-swipe override |
| `gestureHandler.js` | Capture path, finger count, axis lock, natural-scroll + invert, velocity |
| `appSwitcher.js` | MRU list, clones, `Main.activateWindow()` |
| `prefs.js` | libadwaita preferences |
| `schemas/` | GSettings |

### Why a custom handler instead of `SwipeTracker`

GNOME 50 `js/ui/swipeTracker.js` is the reference for constants, unaccelerated deltas, axis lock, and velocity. We **do not** construct `SwipeTracker` because:

1. GNOME 49+ also installs a `Clutter.PanGesture` and treats 3 as a *minimum* finger count, so it would steal 3- and 4-finger swipes.
2. `SwipeTracker.enabled = false` while `State.SCROLLING` emits a synthetic `end` (`_interrupt()`). That has frozen Overview in other extensions (PaperWM). We only toggle the **workspace** tracker’s `enabled` from `enable()` / `disable()` / the finger-count setting.
3. We need an exact finger count and an extra invert-direction flag.

Native 3-finger **horizontal** workspace switching is disabled while finger count is 3 (`Main.wm._workspaceAnimation._swipeTracker.enabled = false`). It is restored in `disable()`. Vertical 3-finger Overview is a different tracker and is not touched.

### APIs that may change

| Assumption | Where it lives | What to check |
| --- | --- | --- |
| `captured-event::touchpad` on `global.stage` | `swipeTracker.js` (GNOME 50 uses `event::touchpad` on the bubble path) | Signal name / `Clutter.EventPhase` |
| `event.get_gesture_motion_delta_unaccelerated()` | mutter Clutter.Event | Fall back to `get_gesture_motion_delta()` is already in code |
| `Main.wm._workspaceAnimation._swipeTracker` | `windowManager.js` + `workspaceAnimation.js` | Private fields; capture `EVENT_STOP` still blocks native even if this path vanishes |
| `display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)` | `altTab.js` `getWindows()` | Tab list enum |
| `Clutter.Clone` of `Meta.WindowActor` | `workspaceAnimation.js` `WorkspaceGroup._createClone()` | Clone + `window_group` stacking |
| `Layout.MonitorConstraint` | `ui/layout.js` | Monitor geometry helper |
| `Mtk.Rectangle` | mutter 12+ | Replaced `Meta.Rectangle` |

GNOME 49 and 50 both use ESM, `SwipeTracker` + `PanGesture`, and the workspace animation controller above. 49 is listed in `metadata.json` because the public Clutter/Meta surface used here matches; if 49’s `_swipeTracker` path differs, capture-phase `EVENT_STOP` is still sufficient.

## Install

```bash
cd /path/to/MacGesture
EXT="$HOME/.local/share/gnome-shell/extensions/macgesture@gurmeetgupta22"
mkdir -p "$HOME/.local/share/gnome-shell/extensions"
cp -a "$PWD/macgesture@gurmeetgupta22/." "$EXT/"
glib-compile-schemas "$EXT/schemas"
```

Run the commands above from the repository root (`MacGesture/`). On **Wayland**, restart GNOME Shell to load a newly copied extension (log out/in, or restart from the login screen), then enable it in the new session:

```bash
gnome-extensions enable macgesture@gurmeetgupta22
```

Nested testing (below) does not require logging out of your session.

Then open **Settings → MacGesture** (or Extensions → MacGesture → settings).

## Nested Wayland test (safe for the host session)

From a TTY or an existing graphical session:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

In the nested window, enable the extension (`gnome-extensions enable macgesture@gurmeetgupta22` in that same dbus session) and swipe on the touchpad. Host journal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Filter for this extension:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep MacGesture
```

## Looking Glass

Press **Alt+F2**, type `lg`, Enter.

Useful checks:

```js
Main.wm._workspaceAnimation._swipeTracker.enabled
Main.actionMode
global.get_window_actors().length
```

Errors from the extension are tagged `[MacGesture]`.

## Pack for extensions.gnome.org

```bash
cd macgesture@gurmeetgupta22
gnome-extensions pack --force \
    --extra-source=gestureHandler.js \
    --extra-source=appSwitcher.js \
    --extra-source=README.md
```

`stylesheet.css`, `prefs.js`, `metadata.json`, and `schemas/` are included automatically. Extra JS modules next to `extension.js` must be listed with `--extra-source`.

This produces `macgesture@gurmeetgupta22.shell-extension.zip`.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| Finger count | 3 | 3 intercepts native horizontal workspace swipe; 4 does not |
| Invert swipe direction | off | Applied after `org.gnome.desktop.peripherals.touchpad natural-scroll` |
| Swipe distance threshold | 0.40 | Fraction of ~400px (GNOME’s touchpad page width) to commit without a flick |
| Animation style | Live | Live = clones follow fingers; Simple = switch on end only |
| Animation duration | 250 ms | Commit / snap-back |
| All workspaces | off | Off = current workspace only |
| Ignore fullscreen | off | Skip the gesture while a fullscreen window is focused |

Direction (natural scrolling on, invert off, LTR): **swipe left → next MRU app**, **swipe right → previous MRU app**.

## Known limitations

- **Nested mutter** often has no real multitouch touchpad stream; test on hardware Wayland.
- **Clones** show the live actor. Minimized targets use an app-icon placeholder until activate unminimizes them.
- **One running app**: gesture is ignored.
- **Overview, lock screen, modal dialogs**: ignored (`Main.overview`, `sessionMode.isLocked`, `Main.modalCount`, `Shell.ActionMode`).
- **3-finger + native 4-finger workspace**: with finger count 3, the workspace `SwipeTracker` is disabled, so 4-finger workspace swipe is also off. Set finger count to 4 to keep native 3-finger workspace switching.
- **Private Shell fields** (`_workspaceAnimation._swipeTracker`) can move; capture-phase `EVENT_STOP` remains the primary conflict avoidance.
- **X11**: not a goal. Ubuntu 26.04 is Wayland-first.
- If live clones fail (rare driver/actor issues), the overlay constructor falls back to **Simple** for that gesture.

## Debug

1. `journalctl -f -o cat /usr/bin/gnome-shell` and watch `[MacGesture]`.
2. Looking Glass: confirm `_swipeTracker.enabled` is `false` when finger count is 3 and the extension is on.
3. If vertical Overview breaks, we are returning `EVENT_STOP` too early — axis lock should stay `IGNORED` + `PROPAGATE` for vertical motion.
4. If workspace and app switch both fire, capture is not stopping horizontal events (check finger count vs libinput).
5. Switch **Animation style → Simple** to isolate overlay/clone problems.

## License

GPL-2.0-or-later (required for GNOME Shell extensions).
