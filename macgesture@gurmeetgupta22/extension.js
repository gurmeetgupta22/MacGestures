// SPDX-License-Identifier: GPL-2.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppSwitcher} from './appSwitcher.js';
import {GestureHandler} from './gestureHandler.js';

export default class MacGestureExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._switcher = new AppSwitcher(this._settings);
        this._gestures = new GestureHandler(this._settings, {
            canBegin: () => this._switcher.canBegin(),
            onBegin: () => this._switcher.begin(),
            onUpdate: progress => this._switcher.update(progress),
            onEnd: (duration, endProgress) => this._switcher.end(duration, endProgress),
            onCancel: () => this._switcher.cancel(),
        });

        this._gestures.enable();
        this._applyNativeOverride();

        this._fingerChangedId = this._settings.connect(
            'changed::finger-count',
            () => this._applyNativeOverride());
    }

    disable() {
        if (this._fingerChangedId) {
            this._settings.disconnect(this._fingerChangedId);
            this._fingerChangedId = 0;
        }

        this._gestures?.disable();
        this._gestures = null;

        this._switcher?.destroy();
        this._switcher = null;

        this._restoreNativeOverride();
        this._settings = null;
    }

    /**
     * Intercept native 3-finger horizontal workspace switching.
     *
     * Source: js/ui/windowManager.js constructs
     *   this._workspaceAnimation = new WorkspaceAnimationController()
     * and js/ui/workspaceAnimation.js WorkspaceAnimationController creates
     *   this._swipeTracker = new SwipeTracker(..., HORIZONTAL, ...).
     *
     * When finger-count is 3 we disable that tracker so GNOME does not also
     * switch workspaces. Vertical Overview swipe uses a *different* SwipeTracker
     * (overviewControls / workspacesView) and is left enabled.
     *
     * When finger-count is 4 we leave the native tracker alone; our capture
     * handler still EVENT_STOPs 4-finger *horizontal* swipes so the native
     * tracker (which accepts >= 3 fingers on GNOME 50) does not fire too.
     *
     * If this private path disappears, check WindowManager._workspaceAnimation
     * and WorkspaceAnimationController._swipeTracker. The captured-event STOP
     * is the fallback even without this patch.
     */
    _applyNativeOverride() {
        const tracker = this._getWorkspaceSwipeTracker();
        if (!tracker)
            return;

        if (this._nativeTrackerOriginalEnabled === undefined)
            this._nativeTrackerOriginalEnabled = tracker.enabled;

        const fingerCount = this._settings.get_int('finger-count');
        try {
            tracker.enabled = fingerCount !== 3
                ? this._nativeTrackerOriginalEnabled
                : false;
        } catch (e) {
            console.error('[MacGesture] failed to toggle workspace SwipeTracker:', e);
        }
    }

    _restoreNativeOverride() {
        const tracker = this._getWorkspaceSwipeTracker();
        if (!tracker) {
            this._nativeTrackerOriginalEnabled = undefined;
            return;
        }

        try {
            if (this._nativeTrackerOriginalEnabled !== undefined)
                tracker.enabled = this._nativeTrackerOriginalEnabled;
        } catch (e) {
            console.error('[MacGesture] failed to restore workspace SwipeTracker:', e);
        }

        this._nativeTrackerOriginalEnabled = undefined;
    }

    _getWorkspaceSwipeTracker() {
        try {
            return Main.wm?._workspaceAnimation?._swipeTracker ?? null;
        } catch {
            return null;
        }
    }
}
