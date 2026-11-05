// SPDX-License-Identifier: GPL-2.0-or-later
//
// MRU application list, activation, and live window-slide overlay.
//
// App order mirrors js/ui/altTab.js:
//   getWindows(workspace) uses display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
//   then unique-by-app via Shell.WindowTracker.get_window_app().
// We switch *applications* (one entry per app, focusing that app's MRU window),
// not individual windows of the same app.
//
// Live overlay mirrors js/ui/workspaceAnimation.js WorkspaceGroup:
//   Clutter.Clone of Meta.WindowActor, container inserted above global.window_group
//   with Layout.MonitorConstraint. We do **not** hide the real actors: Clutter.Clone
//   paints its source live, so hiding the source blanks the clone. Instead an opaque
//   cover hides the stationary real windows while clones slide.
//
// If this breaks: check Meta.TabList, WindowTracker.get_window_app, Main.activateWindow,
// global.get_window_actors(), and Layout.MonitorConstraint in ui/layout.js.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SwitchOverlay = GObject.registerClass(
class MacGestureSwitchOverlay extends St.Widget {
    _init(monitorIndex) {
        super._init({
            style_class: 'macgesture-switch-overlay',
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._monitorIndex = monitorIndex;
        this._records = [];

        this.add_constraint(new Layout.MonitorConstraint({index: monitorIndex}));

        this._cover = new St.Widget({
            style_class: 'macgesture-cover',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(this._cover);

        this._slider = new Clutter.Actor({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(this._slider);
    }

    /**
     * @param {{actor: Clutter.Actor, x: number, y: number}|null} visual
     * @param {number} offsetX
     */
    addPane(visual, offsetX) {
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        const pane = new Clutter.Actor({
            x: offsetX,
            y: 0,
            width: monitor.width,
            height: monitor.height,
        });

        if (visual) {
            visual.actor.x = visual.x;
            visual.actor.y = visual.y;
            pane.add_child(visual.actor);
        }

        this._slider.add_child(pane);
        this._records.push(pane);
        return pane;
    }

    setProgress(progress, width) {
        this._slider.translation_x = -Math.round(progress * width);
    }

    easeTo(progress, width, duration, onComplete) {
        this._slider.remove_all_transitions();
        this._slider.ease({
            translation_x: -Math.round(progress * width),
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                try {
                    onComplete();
                } catch (e) {
                    console.error('[MacGesture] overlay complete failed:', e);
                }
            },
        });
    }

    stopEase() {
        this._slider.remove_all_transitions();
    }
});

export class AppSwitcher {
    constructor(settings) {
        this._settings = settings;
        this._tracker = Shell.WindowTracker.get_default();
        this._overlay = null;
        this._busy = false;
        this._fromWindow = null;
        this._toWindow = null;
        this._prevWindow = null;
        this._nextWindow = null;
        this._monitorIndex = 0;
        this._monitorWidth = 0;
        this._live = true;
        this._progress = 0;
    }

    get busy() {
        return this._busy;
    }

    /**
     * Whether a new gesture may start. Keep this cheap — it runs on the
     * touchpad capture path.
     */
    canBegin() {
        if (this._busy)
            return false;

        if (Main.overview.visible)
            return false;

        if (Main.sessionMode.isLocked)
            return false;

        // Main.modalCount is set by Main.pushModal (js/ui/main.js).
        if (Main.modalCount > 0)
            return false;

        if (Main.actionMode !== Shell.ActionMode.NORMAL)
            return false;

        const focus = global.display.focus_window;
        if (this._settings.get_boolean('ignore-fullscreen') &&
            focus && focus.is_fullscreen())
            return false;

        const apps = this._listApps();
        return apps.length >= 2;
    }

    begin() {
        const apps = this._listApps();
        if (apps.length < 2)
            return false;

        this._nextWindow = apps[1].window;
        this._prevWindow = apps[apps.length - 1].window;
        this._fromWindow = apps[0].window;
        this._toWindow = null;
        this._progress = 0;
        this._busy = true;
        this._live = this._settings.get_string('animation-style') === 'live';
        this._monitorIndex = this._pickMonitorIndex();
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        this._monitorWidth = monitor?.width ?? Main.layoutManager.primaryMonitor.width;

        if (this._live) {
            try {
                this._createOverlay();
            } catch (e) {
                console.error('[MacGesture] live overlay failed, using simple mode:', e);
                this._destroyOverlay();
                this._live = false;
            }
        }

        return true;
    }

    update(progress) {
        this._progress = progress;
        if (!this._live || !this._overlay)
            return;

        try {
            this._overlay.setProgress(progress, this._monitorWidth);
        } catch (e) {
            console.error('[MacGesture] overlay update failed:', e);
        }
    }

    end(duration, endProgress) {
        if (!this._busy)
            return;

        const commit = endProgress !== 0;
        this._toWindow = endProgress > 0
            ? this._nextWindow
            : endProgress < 0
                ? this._prevWindow
                : null;

        if (!this._live || !this._overlay) {
            if (commit)
                this._activate(this._toWindow);
            this._cleanupSwitch();
            return;
        }

        const finish = () => {
            if (commit)
                this._activate(this._toWindow);
            this._cleanupSwitch();
        };

        try {
            this._overlay.easeTo(endProgress, this._monitorWidth, duration, finish);
        } catch (e) {
            console.error('[MacGesture] overlay ease failed:', e);
            finish();
        }
    }

    cancel() {
        if (!this._busy)
            return;

        try {
            this._overlay?.stopEase();
        } catch (e) {
            console.error('[MacGesture] overlay cancel failed:', e);
        }

        this._cleanupSwitch();
    }

    destroy() {
        this.cancel();
        this._settings = null;
        this._tracker = null;
    }

    _cleanupSwitch() {
        this._destroyOverlay();
        this._busy = false;
        this._fromWindow = null;
        this._toWindow = null;
        this._prevWindow = null;
        this._nextWindow = null;
        this._progress = 0;
    }

    _pickMonitorIndex() {
        const [x, y] = global.get_pointer();
        // mutter 12+/GNOME 45+: geometry types live in Mtk, not Meta.Rectangle.
        // SwipeTracker._beginGesture (js/ui/swipeTracker.js) uses Mtk.Rectangle.
        const rect = new Mtk.Rectangle({x, y, width: 1, height: 1});
        let index = global.display.get_monitor_index_for_rect(rect);
        if (index < 0) {
            const focus = global.display.focus_window;
            index = focus ? focus.get_monitor() : Main.layoutManager.primaryIndex;
        }
        return index;
    }

    /**
     * @returns {{app: Shell.App, window: Meta.Window}[]}
     */
    _listApps() {
        const workspace = this._settings.get_boolean('all-workspaces')
            ? null
            : global.workspace_manager.get_active_workspace();

        // js/ui/altTab.js getWindows() — NORMAL_ALL then skip_taskbar / transients.
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
            .map(w => w.is_attached_dialog() ? w.get_transient_for() : w)
            .filter((w, i, a) => w && !w.skip_taskbar && a.indexOf(w) === i);

        const monitorIndex = this._pickMonitorIndex();
        const seen = new Set();
        const apps = [];

        for (const window of windows) {
            const app = this._tracker.get_window_app(window);
            if (!app)
                continue;

            const id = app.get_id();
            if (seen.has(id))
                continue;

            // Default scope is current workspace (already applied via tab list).
            // Multi-monitor: prefer the window on the pointer's monitor when the
            // app has one; otherwise keep the MRU window.
            let chosen = window;
            if (window.get_monitor() !== monitorIndex) {
                const onMonitor = windows.find(w =>
                    this._tracker.get_window_app(w) === app &&
                    w.get_monitor() === monitorIndex);
                if (onMonitor)
                    chosen = onMonitor;
            }

            seen.add(id);
            apps.push({app, window: chosen});
        }

        return apps;
    }

    _createOverlay() {
        this._destroyOverlay();

        const overlay = new SwitchOverlay(this._monitorIndex);
        this._overlay = overlay;

        const width = this._monitorWidth;
        overlay.addPane(this._makeVisual(this._prevWindow), -width);
        overlay.addPane(this._makeVisual(this._fromWindow), 0);
        overlay.addPane(this._makeVisual(this._nextWindow), width);

        // js/ui/workspaceAnimation.js MonitorGroup: insert above window_group
        // so clones cover real windows without restacking the compositor list.
        Main.uiGroup.insert_child_above(overlay, global.window_group);
        overlay.setProgress(0, width);
    }

    _destroyOverlay() {
        if (!this._overlay)
            return;

        try {
            this._overlay.stopEase();
            this._overlay.destroy();
        } catch (e) {
            console.error('[MacGesture] overlay destroy failed:', e);
        }
        this._overlay = null;
    }

    /**
     * @param {Meta.Window} window
     * @returns {{actor: Clutter.Actor, x: number, y: number}|null}
     */
    _makeVisual(window) {
        if (!window)
            return null;

        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        const actor = window.get_compositor_private();

        if (actor && window.showing_on_its_workspace()) {
            try {
                const clone = new Clutter.Clone({
                    source: actor,
                    width: actor.width,
                    height: actor.height,
                });
                clone.connect('destroy', () => {
                    // Source actor may already be gone; ignore.
                });
                actor.connectObject('destroy', () => {
                    try {
                        clone.destroy();
                    } catch {
                    }
                }, clone);

                return {
                    actor: clone,
                    x: actor.x - monitor.x,
                    y: actor.y - monitor.y,
                };
            } catch (e) {
                console.error('[MacGesture] clone failed:', e);
            }
        }

        // Minimized / missing actor: app icon placeholder so the swipe still
        // shows a destination. Unminimize happens on activate().
        try {
            const app = this._tracker.get_window_app(window);
            const size = 192;
            const box = new St.Widget({
                style_class: 'macgesture-placeholder',
                width: size + 64,
                height: size + 64,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                layout_manager: new Clutter.BinLayout(),
            });
            if (app) {
                const icon = app.create_icon_texture(size);
                box.add_child(icon);
            }
            const frame = window.get_frame_rect();
            return {
                actor: box,
                x: Math.max(0, frame.x - monitor.x),
                y: Math.max(0, frame.y - monitor.y),
            };
        } catch (e) {
            console.error('[MacGesture] placeholder failed:', e);
            return null;
        }
    }

    _activate(window) {
        if (!window)
            return;

        try {
            if (window.minimized)
                window.unminimize();

            const time = global.get_current_time();
            // js/ui/main.js activateWindow: focuses, unminimizes, and
            // activates the workspace as needed.
            Main.activateWindow(window, time);
        } catch (e) {
            console.error('[MacGesture] activate failed:', e);
            try {
                window.activate(global.get_current_time());
            } catch (e2) {
                console.error('[MacGesture] window.activate failed:', e2);
            }
        }
    }
}
