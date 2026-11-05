// SPDX-License-Identifier: GPL-2.0-or-later
//
// Touchpad swipe capture + axis lock.
//
// Mirrors GNOME Shell 50 js/ui/swipeTracker.js:
//   - TouchpadSwipeGesture._handleEvent() (axis lock, natural-scroll, unaccelerated deltas)
//   - EventHistory / velocity used by SwipeTracker._endTouchpadGesture()
//
// Why we do NOT instantiate ui/swipeTracker.js SwipeTracker:
//   1. GNOME 49+ SwipeTracker also installs a Clutter.PanGesture and treats
//      finger count as a *minimum* of 3 (GESTURE_FINGER_COUNT), so it would
//      steal both 3- and 4-finger swipes and touchscreen pans.
//   2. Setting SwipeTracker.enabled = false while State.SCROLLING calls
//      _interrupt() (see GNOME 49+ enabled setter). PaperWM hit shell freezes
//      from synthetic 'end' during Overview transitions. We only flip the
//      *workspace* tracker's enabled flag from enable()/disable()/settings,
//      never mid-overview-gesture.
//   3. We need an exact finger count from GSettings and an extra invert flag.
//
// Capture vs bubble: native workspace animation connects TouchpadSwipeGesture
// to stage 'event::touchpad' (bubble) and a PanGesture at EventPhase.CAPTURE.
// Connecting to 'captured-event::touchpad' lets us EVENT_STOP horizontal swipes
// of our finger count *before* the workspace tracker sees them. Vertical
// swipes stay EVENT_PROPAGATE so Overview/App Grid keep working.
//
// If this breaks on a future Shell: check swipeTracker.js for signal name
// (event::touchpad vs captured-event::touchpad), get_gesture_motion_delta_unaccelerated(),
// and TouchpadGesturePhase. BEGIN still resets axis-lock state.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';

// Same constants as js/ui/swipeTracker.js (GNOME 50).
const TOUCHPAD_BASE_WIDTH = 400;
const DRAG_THRESHOLD_DISTANCE = 16;
const EVENT_HISTORY_THRESHOLD_MS = 150;
const VELOCITY_THRESHOLD_TOUCHPAD = 0.6;
const MIN_ANIMATION_DURATION = 100;
const MAX_ANIMATION_DURATION = 400;
const DURATION_MULTIPLIER = 3;
const ANIMATION_BASE_VELOCITY = 0.002;

const TouchpadState = {
    NONE: 0,
    PENDING: 1,
    HANDLING: 2,
    IGNORED: 3,
};

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

export class GestureHandler {
    /**
     * @param {Gio.Settings} settings
     * @param {{
     *   canBegin: () => boolean,
     *   onBegin: () => boolean,
     *   onUpdate: (progress: number) => void,
     *   onEnd: (duration: number, endProgress: number) => void,
     *   onCancel: () => void,
     * }} callbacks
     */
    constructor(settings, callbacks) {
        this._settings = settings;
        this._callbacks = callbacks;
        this._touchpadSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
        this._history = new EventHistory();
        this._state = TouchpadState.NONE;
        this._progress = 0;
        this._stageHandlerId = 0;
        this._enabled = false;
    }

    enable() {
        if (this._enabled)
            return;

        // Detailed touchpad signal: idle pointer motion never enters JS
        // (same motivation as GNOME commit "Subscribe touchpad gesture
        // handlers to only touchpad events").
        this._stageHandlerId = global.stage.connect(
            'captured-event::touchpad',
            this._handleEvent.bind(this));
        this._enabled = true;
    }

    disable() {
        if (!this._enabled)
            return;

        if (this._state === TouchpadState.HANDLING) {
            try {
                this._callbacks.onCancel();
            } catch (e) {
                console.error('[MacGesture] cancel during disable failed:', e);
            }
        }

        if (this._stageHandlerId) {
            global.stage.disconnect(this._stageHandlerId);
            this._stageHandlerId = 0;
        }

        this._reset();
        this._touchpadSettings = null;
        this._settings = null;
        this._callbacks = null;
        this._enabled = false;
    }

    _reset() {
        this._state = TouchpadState.NONE;
        this._progress = 0;
        this._cumulativeX = 0;
        this._cumulativeY = 0;
        this._history.reset();
    }

    _pageDistance() {
        // One full "page" matches swipeTracker.js TOUCHPAD_BASE_WIDTH. The
        // swipe-threshold setting is the commit point (fraction of this page).
        return TOUCHPAD_BASE_WIDTH;
    }

    _logicalDelta(dx) {
        let delta = dx;

        // js/ui/swipeTracker.js TouchpadSwipeGesture UPDATE branch.
        if (this._touchpadSettings.get_boolean('natural-scroll'))
            delta = -delta;

        if (this._settings.get_boolean('invert-direction'))
            delta = -delta;

        // js/ui/swipeTracker.js _updateTouchpadGesture RTL flip.
        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            delta = -delta;

        return delta;
    }

    _handleEvent(_actor, event) {
        try {
            return this._handleEventInner(event);
        } catch (e) {
            console.error('[MacGesture] gesture handler error:', e);
            this._reset();
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _handleEventInner(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_gesture_phase() === Clutter.TouchpadGesturePhase.BEGIN)
            this._state = TouchpadState.NONE;

        const wantedFingers = this._settings.get_int('finger-count');
        if (event.get_touchpad_gesture_finger_count() !== wantedFingers)
            return Clutter.EVENT_PROPAGATE;

        // Overview / lock / modal / non-NORMAL: let native handlers run.
        // Shell.ActionMode is checked the same way as SwipeTracker.
        if ((Shell.ActionMode.NORMAL & Main.actionMode) === 0)
            return Clutter.EVENT_PROPAGATE;

        if (this._state === TouchpadState.IGNORED)
            return Clutter.EVENT_PROPAGATE;

        const time = event.get_time();
        let dx, dy;
        // Prefer unaccelerated deltas (GNOME 40+ / swipeTracker.js). Fall back
        // if a future Clutter drops the method.
        if (typeof event.get_gesture_motion_delta_unaccelerated === 'function')
            [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
        else
            [dx, dy] = event.get_gesture_motion_delta();

        if (this._state === TouchpadState.NONE) {
            if (dx === 0 && dy === 0)
                return Clutter.EVENT_PROPAGATE;

            this._cumulativeX = 0;
            this._cumulativeY = 0;
            this._state = TouchpadState.PENDING;
        }

        if (this._state === TouchpadState.PENDING) {
            this._cumulativeX += dx;
            this._cumulativeY += dy;

            const cdx = this._cumulativeX;
            const cdy = this._cumulativeY;
            const distance = Math.hypot(cdx, cdy);

            if (distance >= DRAG_THRESHOLD_DISTANCE) {
                const orientation = Math.abs(cdx) > Math.abs(cdy)
                    ? Clutter.Orientation.HORIZONTAL
                    : Clutter.Orientation.VERTICAL;

                this._cumulativeX = 0;
                this._cumulativeY = 0;

                if (orientation === Clutter.Orientation.HORIZONTAL &&
                    this._callbacks.canBegin()) {
                    this._state = TouchpadState.HANDLING;
                    this._progress = 0;
                    this._history.reset();
                    this._history.append(time, 0);

                    if (!this._callbacks.onBegin()) {
                        this._state = TouchpadState.IGNORED;
                        return Clutter.EVENT_PROPAGATE;
                    }
                } else {
                    // Vertical (or not allowed): do not steal Overview.
                    this._state = TouchpadState.IGNORED;
                    return Clutter.EVENT_PROPAGATE;
                }
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
        }

        const phase = event.get_gesture_phase();
        const distance = this._pageDistance();
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
            this._reset();
            cb.onEnd(duration, endProgress);
            // Must STOP this END: otherwise the native workspace SwipeTracker
            // (still PENDING from events we propagated before axis lock) can
            // complete a workspace switch. Next BEGIN resets its state.
            return Clutter.EVENT_STOP;
        }
        }

        return Clutter.EVENT_STOP;
    }

    _pickEndProgress(velocity, distance) {
        const threshold = this._settings.get_double('swipe-threshold');
        const progress = this._progress;
        const normVelocity = velocity / distance;

        // js/ui/swipeTracker.js _getEndProgress: velocity can snap even when
        // displacement is small; otherwise pick the closest snap (0, ±1).
        if (Math.abs(normVelocity) >= VELOCITY_THRESHOLD_TOUCHPAD) {
            if (normVelocity > 0 && progress > 0)
                return 1;
            if (normVelocity < 0 && progress < 0)
                return -1;
        }

        if (progress >= threshold)
            return 1;
        if (progress <= -threshold)
            return -1;
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

        // Blend with the user-facing duration so prefs still matter.
        return Math.round(Math.clamp((duration + configured) / 2, 100, 500));
    }
}
