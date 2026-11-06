// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppSwitcher} from './appSwitcher.js';
import {GestureHandler, OtherGestureHandler} from './gestureHandler.js';

export default class MacGestureExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Virtual keyboard for simulating keystrokes (Alt+Tab, custom keybinds, media)
        const seat = Clutter.get_default_backend().get_default_seat();
        this._kb = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        // App switcher instance
        this._switcher = new AppSwitcher(this._settings);

        // Other gestures handler (3-finger vert/tap + 4-finger all)
        this._otherGestures = new OtherGestureHandler(this._settings, this._kb);

        // Single master gesture router
        this._gestures = new GestureHandler(
            this._settings,
            {
                canBegin: () => this._switcher.canBegin(),
                onBegin: () => this._switcher.begin(),
                onUpdate: progress => this._switcher.update(progress),
                onEnd: (duration, endProgress) => this._switcher.end(duration, endProgress),
                onCancel: () => this._switcher.cancel(),
            },
            this._otherGestures
        );

        this._gestures.enable();

        // Disable native trackers comprehensively so GNOME doesn't clash with 3/4-finger swipes
        this._savedTrackerState = [];
        this._disableBuiltinTrackers();

        // Re-disable on shell startup complete if needed
        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject('startup-complete', () => {
                this._disableBuiltinTrackers();
            }, this);
        }

        // Re-disable on overview state changes
        Main.overview.connectObject(
            'showing', () => this._disableBuiltinTrackers(),
            'hidden', () => this._disableBuiltinTrackers(),
            this
        );

        // Watchdog: re-disable trackers periodically
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._disableBuiltinTrackers();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = null;
        }

        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);

        this._restoreBuiltinTrackers();

        this._gestures?.disable();
        this._gestures = null;

        this._otherGestures?.destroy();
        this._otherGestures = null;

        this._switcher?.destroy();
        this._switcher = null;

        this._kb = null;
        this._settings = null;
    }

    // ── Builtin GNOME Tracker Disabling ───────────────────────────────────────

    _disableBuiltinTrackers() {
        const trackerGetters = [
            () => Main.overview?._swipeTracker,
            () => Main.wm?._workspaceAnimation?._swipeTracker,
            () => Main.overview?._overview?.controls?._workspacesDisplay?._swipeTracker,
            () => Main.overview?._overview?.controls?._swipeTracker,
            () => Main.wm?._swipeTracker,
            () => Main.overview?._overview?.controls?._appDisplay?._swipeTracker,
        ];

        for (const getter of trackerGetters) {
            let tracker;
            try {
                tracker = getter();
            } catch {
                continue;
            }
            if (!tracker) continue;

            if (!this._savedTrackerState.some(s => s.tracker === tracker)) {
                this._savedTrackerState.push({
                    tracker,
                    wasEnabled: tracker.enabled ?? true,
                    touchpadGestureEnabled: tracker._touchpadGesture?.enabled ?? true,
                });
            }

            // Level 1: SwipeTracker
            if (tracker.enabled !== undefined)
                tracker.enabled = false;

            // Level 2: TouchpadSwipeGesture
            if (tracker._touchpadGesture)
                tracker._touchpadGesture.enabled = false;

            // Level 3: PanGesture
            if (tracker._panGesture)
                tracker._panGesture.enabled = false;
        }
    }

    _restoreBuiltinTrackers() {
        if (!this._savedTrackerState) return;

        for (const saved of this._savedTrackerState) {
            if (saved.tracker.enabled !== undefined)
                saved.tracker.enabled = saved.wasEnabled;
            if (saved.tracker._touchpadGesture)
                saved.tracker._touchpadGesture.enabled = saved.touchpadGestureEnabled;
            if (saved.tracker._panGesture)
                saved.tracker._panGesture.enabled = true;
        }
        this._savedTrackerState = [];
    }
}
