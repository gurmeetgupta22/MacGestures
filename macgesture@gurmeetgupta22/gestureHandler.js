// SPDX-License-Identifier: GPL-2.0-or-later
//
// gestureHandler.js — Touchpad gesture routing for MacGesture.
//
// Architecture (single captured-event::touchpad subscriber):
//
//   GestureHandler  ←  enable() registers ONE stage handler
//       │
//       ├─ 3-finger  BEGIN/UPDATE/END  (axis lock pending)
//       │      ├─ horizontal → app-switch state machine (AppSwitcher callbacks)
//       │      └─ vertical / 3-tap → OtherGestureHandler
//       │
//       └─ 4-finger  all events → OtherGestureHandler
//
// OtherGestureHandler is NOT connected to the stage itself; it is called
// directly by GestureHandler so there is never more than one stage listener.
//
// References: js/ui/swipeTracker.js (GNOME 50) for axis lock, unaccelerated
// deltas, EventHistory, velocity, and snap logic.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';

// ── App-switch swipe tracker constants (mirrors swipeTracker.js GNOME 50) ──────
const TOUCHPAD_BASE_WIDTH = 400;
const DRAG_THRESHOLD_DISTANCE = 16;
const EVENT_HISTORY_THRESHOLD_MS = 150;
const VELOCITY_THRESHOLD_TOUCHPAD = 0.6;
const MIN_ANIMATION_DURATION = 100;
const MAX_ANIMATION_DURATION = 400;
const DURATION_MULTIPLIER = 3;
const ANIMATION_BASE_VELOCITY = 0.002;

// ── Other gesture constants ────────────────────────────────────────────────────
const SWIPE_THRESHOLD = 15;         // px accumulated before direction is locked
const TAP_MAX_DURATION_MS = 500;    // max hold time for a gesture to count as tap
const VOL_STEP_PER_PX = 0.0012;
const BRIGHT_STEP_PER_PX = 0.0012;
const OSD_THROTTLE_MS = 120;

// ── Action index constants — MUST match prefs.js ───────────────────────────────
// Vertical (up / down)
const V = {
    ACTIVITIES: 0,
    VOLUME: 1,
    BRIGHTNESS: 2,
    MAX_MIN: 3,
    CLOSE: 4,
    SHOW_DESKTOP: 5,
    CUSTOM: 6,
    DISABLED: 7,
};
// 4-finger left
const HL = { WS_LEFT: 0, BRIGHT_DOWN: 1, ALTTAB_PREV: 2, MEDIA_PREV: 3, CUSTOM: 4, DISABLED: 5 };
// 4-finger right
const HR = { WS_RIGHT: 0, BRIGHT_UP: 1, ALTTAB_NEXT: 2, MEDIA_NEXT: 3, CUSTOM: 4, DISABLED: 5 };
// Tap
const T = { PLAY_PAUSE: 0, SHOW_DESKTOP: 1, CYCLE_WS: 2, NOTIFS: 3, CUSTOM: 4, DISABLED: 5 };

const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// ── App-switch state machine states ────────────────────────────────────────────
const AppSwitchState = {
    NONE: 0,
    PENDING: 1,
    HANDLING: 2,
    IGNORED: 3,
};

// ── OtherGesture tracking ──────────────────────────────────────────────────────
const OtherState = {
    NONE: 0,
    ACTIVE: 1,
};

// ══════════════════════════════════════════════════════════════════════════════
// EventHistory — velocity calculation for the app-switch snap logic.
// ══════════════════════════════════════════════════════════════════════════════
class EventHistory {
    constructor() {
        this.reset();
    }

    reset() {
        this._data = [];
    }

    trim(time) {
        const thresholdTime = time - EVENT_HISTORY_THRESHOLD_MS;
        const index = this._data.findIndex(r => r.time >= thresholdTime);
        this._data.splice(0, index === -1 ? this._data.length : index);
    }

    append(time, delta) {
        this.trim(time);
        this._data.push({time, delta});
    }

    calculateVelocity() {
        if (this._data.length < 2)
            return 0;
        const firstTime = this._data[0].time;
        const lastTime = this._data[this._data.length - 1].time;
        if (firstTime === lastTime)
            return 0;
        const totalDelta = this._data.slice(1).map(a => a.delta).reduce((a, b) => a + b, 0);
        return totalDelta / (lastTime - firstTime);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// OtherGestureHandler — 3-finger vertical/tap + all 4-finger gestures.
// Called directly by GestureHandler; not connected to global.stage itself.
// ══════════════════════════════════════════════════════════════════════════════
export class OtherGestureHandler {
    /**
     * @param {Gio.Settings} settings  MacGesture GSettings
     * @param {Clutter.VirtualInputDevice} kb  Virtual keyboard for key simulation
     */
    constructor(settings, kb) {
        this._settings = settings;
        this._kb = kb;
        this._volumeControl = null;
        this._lastOsdTime = 0;

        // Per-gesture state
        this._state = OtherState.NONE;
        this._dx = 0;
        this._dy = 0;
        this._swipeStartTime = 0;
        this._swipePrefix = '';           // 'three' | 'four'
        this._swipeDirectionLocked = false;
        this._swipeKey = '';              // e.g. 'three-swipe-up'
        this._swipeContinuousAction = null; // 'volume' | 'brightness' | null

        this._pendingSources = new Set();
    }

    reset() {
        this._dx = 0;
        this._dy = 0;
        this._swipeContinuousAction = null;
        this._swipeDirectionLocked = false;
        this._swipePrefix = '';
        this._swipeKey = '';
        this._state = OtherState.NONE;
    }

    destroy() {
        if (this._pendingSources) {
            for (const id of this._pendingSources)
                GLib.source_remove(id);
            this._pendingSources.clear();
            this._pendingSources = null;
        }
        this._settings = null;
        this._kb = null;
        this._volumeControl = null;
    }

    // ── Entry point called by GestureHandler ─────────────────────────────────

    /**
     * Handle a touchpad swipe event that is NOT claimed by the app-switch path.
     * Returns Clutter.EVENT_STOP or Clutter.EVENT_PROPAGATE.
     */
    handleSwipe(event, fingerCount) {
        const phase = event.get_gesture_phase();

        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._dx = 0;
            this._dy = 0;
            this._swipeStartTime = GLib.get_monotonic_time();
            this._swipeContinuousAction = null;
            this._swipeDirectionLocked = false;
            this._swipePrefix = fingerCount === 4 ? 'four' : 'three';
            this._swipeKey = '';
            this._state = OtherState.ACTIVE;
            return Clutter.EVENT_STOP;
        }

        // Auto-activate on UPDATE if BEGIN arrived before state activation
        if (this._state !== OtherState.ACTIVE) {
            if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
                this._dx = 0;
                this._dy = 0;
                this._swipeStartTime = GLib.get_monotonic_time();
                this._swipeContinuousAction = null;
                this._swipeDirectionLocked = false;
                this._swipePrefix = fingerCount === 4 ? 'four' : 'three';
                this._swipeKey = '';
                this._state = OtherState.ACTIVE;
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
        }

        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            const [dx, dy] = event.get_gesture_motion_delta();

            this._dx += dx;
            this._dy += dy;

            if (!this._swipeDirectionLocked) {
                const adx = Math.abs(this._dx);
                const ady = Math.abs(this._dy);
                if (Math.max(adx, ady) >= SWIPE_THRESHOLD) {
                    this._swipeDirectionLocked = true;
                    let direction;
                    if (adx >= ady)
                        direction = this._dx > 0 ? 'swipe-right' : 'swipe-left';
                    else
                        direction = this._dy > 0 ? 'swipe-down' : 'swipe-up';

                    this._swipeKey = `${this._swipePrefix}-${direction}`;
                    const actionType = this._settings.get_int(`${this._swipeKey}-action`);
                    const isVert = direction === 'swipe-up' || direction === 'swipe-down';

                    if (isVert && actionType === V.VOLUME)
                        this._swipeContinuousAction = 'volume';
                    else if (isVert && actionType === V.BRIGHTNESS)
                        this._swipeContinuousAction = 'brightness';
                    else if (!isVert) {
                        const isLeft = direction === 'swipe-left';
                        if ((isLeft && actionType === HL.BRIGHT_DOWN) ||
                            (!isLeft && actionType === HR.BRIGHT_UP))
                            this._swipeContinuousAction = 'brightness';
                    }
                }
            }

            // Continuous volume / brightness during UPDATE
            if (this._swipeContinuousAction === 'volume') {
                this._volumeContinuous(-dy); // dy < 0 is swipe up = volume up
                return Clutter.EVENT_STOP;
            }
            if (this._swipeContinuousAction === 'brightness') {
                const isHorizontal = this._swipeKey?.includes('swipe-left') ||
                                     this._swipeKey?.includes('swipe-right');
                const brightDelta = isHorizontal ? dx : -dy;
                this._brightnessContinuous(brightDelta);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_STOP;
        }

        if (phase === Clutter.TouchpadGesturePhase.END ||
            phase === Clutter.TouchpadGesturePhase.CANCEL) {

            this._state = OtherState.NONE;

            if (this._swipeContinuousAction) {
                this._swipeContinuousAction = null;
                this._dx = 0;
                this._dy = 0;
                return Clutter.EVENT_STOP;
            }

            const adx = Math.abs(this._dx);
            const ady = Math.abs(this._dy);
            const prefix = this._swipePrefix || (fingerCount === 4 ? 'four' : 'three');

            if (phase === Clutter.TouchpadGesturePhase.END) {
                if (Math.max(adx, ady) >= SWIPE_THRESHOLD) {
                    let key = this._swipeKey;
                    if (!this._swipeDirectionLocked || !key) {
                        let direction;
                        if (adx >= ady)
                            direction = this._dx > 0 ? 'swipe-right' : 'swipe-left';
                        else
                            direction = this._dy > 0 ? 'swipe-down' : 'swipe-up';
                        key = `${prefix}-${direction}`;
                    }
                    this._idleExec(() => this._executeAction(key));
                } else {
                    // Short movement = tap
                    const elapsed = (GLib.get_monotonic_time() - this._swipeStartTime) / 1000;
                    if (elapsed <= TAP_MAX_DURATION_MS)
                        this._idleExec(() => this._executeAction(`${prefix}-tap`));
                }
            }

            this._dx = 0;
            this._dy = 0;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
    }

    /**
     * Handle touchpad HOLD events (alternative tap detection path).
     */
    handleHold(event, fingerCount) {
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._holdStartTime = GLib.get_monotonic_time();
            this._holdFingers = fingerCount;
            return Clutter.EVENT_STOP;
        }
        if (phase === Clutter.TouchpadGesturePhase.END) {
            const elapsed = (GLib.get_monotonic_time() - (this._holdStartTime ?? 0)) / 1000;
            if (elapsed <= TAP_MAX_DURATION_MS) {
                const prefix = this._holdFingers === 4 ? 'four' : 'three';
                this._idleExec(() => this._executeAction(`${prefix}-tap`));
            }
            this._holdStartTime = 0;
            this._holdFingers = 0;
            return Clutter.EVENT_STOP;
        }
        if (phase === Clutter.TouchpadGesturePhase.CANCEL) {
            this._holdStartTime = 0;
            this._holdFingers = 0;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    // ── Action execution ──────────────────────────────────────────────────────

    _idleExec(fn) {
        if (!this._pendingSources) return;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingSources?.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingSources?.add(id);
    }

    _executeAction(key) {
        const actionType = this._settings?.get_int(`${key}-action`);
        if (actionType === undefined || actionType === null) return;

        const isUp    = key.endsWith('swipe-up');
        const isDown  = key.endsWith('swipe-down');
        const isLeft  = key.endsWith('swipe-left');
        const isRight = key.endsWith('swipe-right');
        const isTap   = key.endsWith('tap');
        const isVert  = isUp || isDown;

        // Overview hierarchical navigation: up→app grid, down←close
        if (isVert && Main.overview.visible) {
            if (isUp) {
                if (!this._isAppGridVisible())
                    this._showAppGrid();
                return;
            }
            if (isDown) {
                if (this._isAppGridVisible())
                    this._hideAppGrid();
                else
                    Main.overview.hide();
                return;
            }
        }

        if (isVert) {
            if (actionType < 0 || actionType > 7) return;
            switch (actionType) {
            case V.ACTIVITIES:   Main.overview.show(); break;
            case V.VOLUME:       this._volume(isUp); break;
            case V.BRIGHTNESS:   this._brightness(isUp); break;
            case V.MAX_MIN: {
                const w = global.display.get_focus_window();
                if (!w) break;
                if (isUp) {
                    w.maximize();
                } else {
                    if (w.is_maximized())
                        w.unmaximize();
                    else
                        w.minimize();
                }
                break;
            }
            case V.CLOSE: {
                const w = global.display.get_focus_window();
                if (w) w.delete(global.get_current_time());
                break;
            }
            case V.SHOW_DESKTOP: this._showDesktop(); break;
            case V.CUSTOM:       this._fireKeybind(key); break;
            // V.DISABLED: nothing
            }
            return;
        }

        if (isLeft) {
            if (actionType < 0 || actionType > 5) return;
            switch (actionType) {
            case HL.WS_LEFT:    this._switchWorkspace(true); break; // Swipe left -> next workspace (right)
            case HL.BRIGHT_DOWN: this._brightness(false); break;
            case HL.ALTTAB_PREV: this._altTab(false); break;
            case HL.MEDIA_PREV: this._media('previous'); break;
            case HL.CUSTOM:     this._fireKeybind(key); break;
            }
            return;
        }

        if (isRight) {
            if (actionType < 0 || actionType > 5) return;
            switch (actionType) {
            case HR.WS_RIGHT:   this._switchWorkspace(false); break; // Swipe right -> previous workspace (left)
            case HR.BRIGHT_UP:  this._brightness(true); break;
            case HR.ALTTAB_NEXT: this._altTab(true); break;
            case HR.MEDIA_NEXT: this._media('next'); break;
            case HR.CUSTOM:     this._fireKeybind(key); break;
            }
            return;
        }

        if (isTap) {
            if (actionType < 0 || actionType > 5) return;
            switch (actionType) {
            case T.PLAY_PAUSE:  this._media('play-pause'); break;
            case T.SHOW_DESKTOP: this._showDesktop(); break;
            case T.CYCLE_WS:    this._switchWorkspace(true); break;
            case T.NOTIFS:      Main.panel.statusArea.dateMenu?.menu?.toggle(); break;
            case T.CUSTOM:      this._fireKeybind(key); break;
            }
        }
    }

    // ── App grid navigation ───────────────────────────────────────────────────

    _isAppGridVisible() {
        return Main.overview.dash?.showAppsButton?.checked === true;
    }

    _showAppGrid() {
        const btn = Main.overview.dash?.showAppsButton;
        if (btn) btn.checked = true;
    }

    _hideAppGrid() {
        const btn = Main.overview.dash?.showAppsButton;
        if (btn) btn.checked = false;
    }

    // ── Workspace switching ───────────────────────────────────────────────────

    _switchWorkspace(forward) {
        const wm = global.workspace_manager;
        const cur = wm.get_active_workspace_index();
        const idx = cur + (forward ? 1 : -1);
        if (idx >= 0 && idx < wm.n_workspaces)
            wm.get_workspace_by_index(idx).activate(global.get_current_time());
    }

    // ── Show desktop ──────────────────────────────────────────────────────────

    _showDesktop() {
        const ws = global.workspace_manager.get_active_workspace();
        ws.list_windows()
            .filter(w => !w.is_skip_taskbar() && !w.minimized)
            .forEach(w => w.minimize());
    }

    // ── Volume ────────────────────────────────────────────────────────────────

    _getVolumeControl() {
        if (!this._volumeControl) {
            this._volumeControl =
                Main.panel?.statusArea?.quickSettings?._volumeOutput?._control ?? null;
        }
        return this._volumeControl;
    }

    _volume(isUp) {
        this._volumeContinuous(isUp ? 3 : -3);
    }

    _volumeContinuous(delta) {
        const ctrl = this._getVolumeControl();
        if (!ctrl) return;
        const stream = ctrl.get_default_sink();
        if (!stream) return;

        const maxVol = ctrl.get_vol_max_norm();
        const step = maxVol * VOL_STEP_PER_PX * Math.abs(delta);
        let newVol = delta > 0 ? stream.volume + step : stream.volume - step;
        newVol = Math.max(0, Math.min(maxVol, newVol));
        stream.volume = newVol;
        stream.push_volume();

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastOsdTime > OSD_THROTTLE_MS) {
            this._lastOsdTime = now;
            const level = newVol / maxVol;
            const icon = level <= 0 ? 'audio-volume-muted-symbolic'
                : level < 0.33 ? 'audio-volume-low-symbolic'
                : level < 0.66 ? 'audio-volume-medium-symbolic'
                : 'audio-volume-high-symbolic';
            Main.osdWindowManager.showOne(
                Main.layoutManager.primaryIndex,
                Gio.Icon.new_for_string(icon), null, level);
        }
    }

    // ── Brightness ────────────────────────────────────────────────────────────

    _brightness(isUp) {
        const scale = Main.brightnessManager?.globalScale;
        if (!scale) return;
        if (isUp) scale.stepUp(); else scale.stepDown();
    }

    _brightnessContinuous(delta) {
        const scale = Main.brightnessManager?.globalScale;
        if (!scale) return;
        const step = BRIGHT_STEP_PER_PX * Math.abs(delta);
        let newVal = delta > 0 ? scale.value + step : scale.value - step;
        newVal = Math.max(0, Math.min(1.0, newVal));
        scale.value = newVal;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastOsdTime > OSD_THROTTLE_MS) {
            this._lastOsdTime = now;
            Main.osdWindowManager.showOne(
                Main.layoutManager.primaryIndex,
                Gio.Icon.new_for_string('display-brightness-symbolic'),
                null, newVal);
        }
    }

    // ── Media ─────────────────────────────────────────────────────────────────

    _media(cmd) {
        if (cmd !== 'play-pause') {
            this._simulateMediaKey(cmd);
            return;
        }
        // play-pause: prefer MPRIS D-Bus
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const result = conn.call_finish(res);
                    const names = result.get_child_value(0).deepUnpack();
                    const players = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
                    if (players.length === 0) {
                        this._simulateMediaKey(cmd);
                        return;
                    }
                    Gio.DBus.session.call(
                        players[0], '/org/mpris/MediaPlayer2',
                        MPRIS_PLAYER_IFACE, 'PlayPause',
                        null, null, Gio.DBusCallFlags.NONE, -1, null,
                        (c, r) => { try { c.call_finish(r); } catch {} });
                } catch {
                    this._simulateMediaKey(cmd);
                }
            });
    }

    _simulateMediaKey(cmd) {
        let keyval;
        if (cmd === 'play-pause') keyval = Clutter.KEY_AudioPlay;
        else if (cmd === 'next')  keyval = Clutter.KEY_AudioNext;
        else if (cmd === 'previous') keyval = Clutter.KEY_AudioPrev;
        if (keyval) this._simulateKey(keyval);
    }

    // ── Alt+Tab ───────────────────────────────────────────────────────────────

    _altTab(forward) {
        const t = Clutter.get_current_event_time();
        this._kb.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        if (!forward)
            this._kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._kb.notify_keyval(t, Clutter.KEY_Tab, Clutter.KeyState.PRESSED);
        this._kb.notify_keyval(t, Clutter.KEY_Tab, Clutter.KeyState.RELEASED);
        if (!forward)
            this._kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        this._kb.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
    }

    // ── Custom keybind ────────────────────────────────────────────────────────

    _fireKeybind(gestureKey) {
        const stored = this._settings?.get_string(`${gestureKey}-keybind`);
        if (!stored || !stored.includes(':')) return;
        const parts = stored.split(':');
        const keyval = parseInt(parts[0], 10);
        const mods = parseInt(parts[1], 10);
        if (!keyval) return;

        const GDK_SHIFT_MASK   = 1;
        const GDK_CONTROL_MASK = 4;
        const GDK_ALT_MASK     = 8;
        const GDK_SUPER_MASK   = 67108864;
        const GDK_HYPER_MASK   = 134217728;
        const GDK_META_MASK    = 268435456;

        let t = global.get_current_time() || GLib.get_monotonic_time() / 1000;
        const kb = this._kb;

        if (mods & GDK_SHIFT_MASK)   kb.notify_keyval(t, Clutter.KEY_Shift_L,   Clutter.KeyState.PRESSED);
        if (mods & GDK_CONTROL_MASK) kb.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        if (mods & GDK_ALT_MASK)     kb.notify_keyval(t, Clutter.KEY_Alt_L,     Clutter.KeyState.PRESSED);
        if (mods & GDK_SUPER_MASK)   kb.notify_keyval(t, Clutter.KEY_Super_L,   Clutter.KeyState.PRESSED);
        if (mods & GDK_HYPER_MASK)   kb.notify_keyval(t, Clutter.KEY_Hyper_L,   Clutter.KeyState.PRESSED);
        if (mods & GDK_META_MASK)    kb.notify_keyval(t, Clutter.KEY_Meta_L,    Clutter.KeyState.PRESSED);

        t += 1;
        kb.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
        t += 1;
        kb.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);
        t += 1;

        if (mods & GDK_META_MASK)    kb.notify_keyval(t, Clutter.KEY_Meta_L,    Clutter.KeyState.RELEASED);
        if (mods & GDK_HYPER_MASK)   kb.notify_keyval(t, Clutter.KEY_Hyper_L,   Clutter.KeyState.RELEASED);
        if (mods & GDK_SUPER_MASK)   kb.notify_keyval(t, Clutter.KEY_Super_L,   Clutter.KeyState.RELEASED);
        if (mods & GDK_ALT_MASK)     kb.notify_keyval(t, Clutter.KEY_Alt_L,     Clutter.KeyState.RELEASED);
        if (mods & GDK_CONTROL_MASK) kb.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        if (mods & GDK_SHIFT_MASK)   kb.notify_keyval(t, Clutter.KEY_Shift_L,   Clutter.KeyState.RELEASED);
    }

    // ── Generic key simulation ────────────────────────────────────────────────

    _simulateKey(keyval) {
        if (!this._kb) return;
        const t = Clutter.get_current_event_time();
        this._kb.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
        this._kb.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// GestureHandler — single captured-event::touchpad subscriber.
// Routes 3-finger horizontal → app-switch path; everything else → OtherGestureHandler.
// ══════════════════════════════════════════════════════════════════════════════
export class GestureHandler {
    /**
     * @param {Gio.Settings} settings
     * @param {{
     *   canBegin: () => boolean,
     *   onBegin:  () => boolean,
     *   onUpdate: (progress: number) => void,
     *   onEnd:    (duration: number, endProgress: number) => void,
     *   onCancel: () => void,
     * }} callbacks
     * @param {OtherGestureHandler} otherHandler
     */
    constructor(settings, callbacks, otherHandler) {
        this._settings = settings;
        this._callbacks = callbacks;
        this._other = otherHandler;
        this._touchpadSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
        this._history = new EventHistory();
        this._appSwitchState = AppSwitchState.NONE;
        this._progress = 0;
        this._stageHandlerId = 0;
        this._enabled = false;
    }

    enable() {
        if (this._enabled) return;
        this._stageHandlerId = global.stage.connect(
            'captured-event::touchpad',
            this._handleEvent.bind(this));
        this._enabled = true;
    }

    disable() {
        if (!this._enabled) return;

        if (this._appSwitchState === AppSwitchState.HANDLING) {
            try { this._callbacks.onCancel(); } catch (e) {
                console.error('[MacGesture] cancel during disable failed:', e);
            }
        }

        if (this._stageHandlerId) {
            global.stage.disconnect(this._stageHandlerId);
            this._stageHandlerId = 0;
        }

        this._resetAppSwitch();
        this._touchpadSettings = null;
        this._settings = null;
        this._callbacks = null;
        this._other = null;
        this._enabled = false;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    _resetAppSwitch() {
        this._appSwitchState = AppSwitchState.NONE;
        this._progress = 0;
        this._cumulativeX = 0;
        this._cumulativeY = 0;
        this._history.reset();
    }

    _logicalDelta(dx) {
        let delta = dx;
        if (this._touchpadSettings.get_boolean('natural-scroll'))
            delta = -delta;
        if (this._settings.get_boolean('invert-direction'))
            delta = -delta;
        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            delta = -delta;
        return delta;
    }

    // ── Main event handler ────────────────────────────────────────────────────

    _handleEvent(_actor, event) {
        try {
            return this._handleEventInner(event);
        } catch (e) {
            console.error('[MacGesture] gesture handler error:', e);
            this._resetAppSwitch();
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _handleEventInner(event) {
        const type = event.type();

        // ── TOUCHPAD_HOLD: delegate entirely to OtherGestureHandler ───────────
        if (type === Clutter.EventType.TOUCHPAD_HOLD) {
            const n = event.get_touchpad_gesture_finger_count();
            if (n < 3 || n > 4) return Clutter.EVENT_PROPAGATE;
            return this._other
                ? this._other.handleHold(event, n)
                : Clutter.EVENT_PROPAGATE;
        }

        // ── TOUCHPAD_SWIPE only beyond this point ─────────────────────────────
        if (type !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const n = event.get_touchpad_gesture_finger_count();
        if (n < 3 || n > 4) return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();
        const appSwitchFingers = this._settings.get_int('finger-count');

        // ── Non-app-switcher finger count (e.g. 4-finger when appSwitch is 3) ───
        if (n !== appSwitchFingers) {
            return this._other
                ? this._other.handleSwipe(event, n)
                : Clutter.EVENT_PROPAGATE;
        }

        // ── Non-NORMAL mode (Overview, modal, lock screen):
        // Skip app switcher and pass directly to OtherGestureHandler (allows vertical swipes in overview)
        if ((Shell.ActionMode.NORMAL & Main.actionMode) === 0) {
            return this._other
                ? this._other.handleSwipe(event, n)
                : Clutter.EVENT_PROPAGATE;
        }

        // ── Phase BEGIN: initialize both state machines ────────────────────────
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._resetAppSwitch();
            this._appSwitchState = AppSwitchState.PENDING;
            if (this._other)
                this._other.handleSwipe(event, n);
            return Clutter.EVENT_STOP;
        }

        // ── Gesture already classified as vertical / other ────────────────────
        if (this._appSwitchState === AppSwitchState.IGNORED) {
            if (phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL) {
                this._resetAppSwitch();
            }
            return this._other
                ? this._other.handleSwipe(event, n)
                : Clutter.EVENT_STOP;
        }

        const time = event.get_time();
        let dx, dy;
        if (typeof event.get_gesture_motion_delta_unaccelerated === 'function')
            [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
        else
            [dx, dy] = event.get_gesture_motion_delta();

        // ── PENDING: accumulate until axis lock resolves ───────────────────────
        if (this._appSwitchState === AppSwitchState.PENDING) {
            if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
                this._cumulativeX += dx;
                this._cumulativeY += dy;

                const dist = Math.hypot(this._cumulativeX, this._cumulativeY);
                if (dist >= DRAG_THRESHOLD_DISTANCE) {
                    const isHoriz = Math.abs(this._cumulativeX) > Math.abs(this._cumulativeY);
                    this._cumulativeX = 0;
                    this._cumulativeY = 0;

                    if (isHoriz && this._callbacks.canBegin()) {
                        // → confirmed horizontal: app-switch path
                        // OtherGestureHandler's buffered state is no longer needed
                        if (this._other)
                            this._other.reset();
                        this._appSwitchState = AppSwitchState.HANDLING;
                        this._progress = 0;
                        this._history.reset();
                        this._history.append(time, 0);
                        if (!this._callbacks.onBegin())
                            this._appSwitchState = AppSwitchState.IGNORED;
                    } else {
                        // → confirmed vertical / other: hand off to OtherGestureHandler
                        this._appSwitchState = AppSwitchState.IGNORED;
                        // OtherGestureHandler already has BEGIN; now send this UPDATE
                        if (this._other)
                            this._other.handleSwipe(event, n);
                    }
                }
                // While still PENDING, don't forward to OtherGestureHandler —
                // it would try to look up three-swipe-left/right schema keys
                // that don't exist (horizontal is owned by the app-switcher).
                return Clutter.EVENT_STOP;
            }

            if (phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL) {
                // Direction never resolved — reset both state machines cleanly
                if (this._other)
                    this._other.reset();
                this._resetAppSwitch();
                return Clutter.EVENT_STOP;
            }
        }

        // ── HANDLING: app-switch overlay ──────────────────────────────────────
        if (this._appSwitchState === AppSwitchState.HANDLING) {
            const distance = TOUCHPAD_BASE_WIDTH;
            const delta = this._logicalDelta(dx);

            switch (phase) {
            case Clutter.TouchpadGesturePhase.BEGIN:
            case Clutter.TouchpadGesturePhase.UPDATE:
                this._history.append(time, delta);
                this._progress += delta / distance;
                this._progress = Math.clamp(this._progress, -1, 1);
                this._callbacks.onUpdate(this._progress);
                break;

            case Clutter.TouchpadGesturePhase.END:
            case Clutter.TouchpadGesturePhase.CANCEL: {
                this._history.trim(time);
                const velocity = this._history.calculateVelocity();
                const cancelled = phase === Clutter.TouchpadGesturePhase.CANCEL;
                const endProgress = cancelled ? 0 : this._pickEndProgress(velocity, distance);
                const duration = this._pickDuration(velocity, distance, endProgress);
                const cb = this._callbacks;
                this._resetAppSwitch();
                cb.onEnd(duration, endProgress);
                return Clutter.EVENT_STOP;
            }
            }

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _pickEndProgress(velocity, distance) {
        const threshold = this._settings.get_double('swipe-threshold');
        const progress = this._progress;
        const normVelocity = velocity / distance;

        if (Math.abs(normVelocity) >= VELOCITY_THRESHOLD_TOUCHPAD) {
            if (normVelocity > 0 && progress > 0) return 1;
            if (normVelocity < 0 && progress < 0) return -1;
        }
        if (progress >= threshold)  return 1;
        if (progress <= -threshold) return -1;
        return 0;
    }

    _pickDuration(velocity, distance, endProgress) {
        const configured = this._settings.get_int('animation-duration');
        let v = velocity / distance;
        if ((endProgress - this._progress) * v <= 0)
            v = ANIMATION_BASE_VELOCITY;

        let duration = Math.abs((this._progress - endProgress) / v * DURATION_MULTIPLIER);
        if (duration > 0)
            duration = Math.clamp(duration, MIN_ANIMATION_DURATION, MAX_ANIMATION_DURATION);
        else
            duration = configured;

        return Math.round(Math.clamp((duration + configured) / 2, 100, 500));
    }
}
