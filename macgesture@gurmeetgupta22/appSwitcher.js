// SPDX-License-Identifier: GPL-2.0-or-later
//
// Application cycle, activation, and live window-slide overlay.
//
// App order mirrors js/ui/altTab.js AppSwitcherPopup:
//   Shell.AppSystem.get_running() (sorted by shell_app_compare / last user time)
//   then getWindows(workspace) via display.get_tab_list(Meta.TabList.NORMAL_ALL).
//
// Cycling: freeze the window list until the user focuses a window we did not
// activate. Opposite swipe then returns along the same path (Chrome → Cursor
// → Chrome) instead of wrapping to the oldest MRU entry (Spotify).
//
// Animation: static wallpaper, window cards float from the side with
// EASE_OUT_QUINT and a slight scale.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Frozen until the user focuses a window we did not activate (click / Alt+Tab).
// A short timeout was rebuilding MRU so the opposite swipe wrapped to the
// oldest app (Chrome → Cursor, then left → Spotify instead of back to Chrome).

const SwitchOverlay = GObject.registerClass(
class MacGestureSwitchOverlay extends St.Widget {
    _init(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        super._init({
            style_class: 'macgesture-switch-overlay',
            clip_to_allocation: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        this._monitorIndex = monitorIndex;
        this._monitor = monitor;
        this._records = [];
        this._width = monitor.width;

        this.add_constraint(new Layout.MonitorConstraint({index: monitorIndex}));

        // Wallpaper stays put. Only the window cards slide, so windowed apps
        // float in from the side instead of dragging the whole desktop.
        this._wallpaper = null;

        this._slider = new Clutter.Actor({
            x: 0,
            y: 0,
            width: monitor.width,
            height: monitor.height,
        });
        this.add_child(this._slider);
    }

    setWallpaper(actor) {
        if (this._wallpaper) {
            this._wallpaper.destroy();
            this._wallpaper = null;
        }
        if (!actor)
            return;
        this._wallpaper = actor;
        this.insert_child_below(actor, this._slider);
    }

    /**
     * @param {Clutter.Actor} pane
     * @param {number} offsetX
     */
    addPane(pane, offsetX) {
        pane.x = offsetX;
        pane.y = 0;
        pane.width = this._monitor.width;
        pane.height = this._monitor.height;
        pane.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        this._slider.add_child(pane);
        this._records.push(pane);
        return pane;
    }

    setProgress(progress, width) {
        this._width = width;
        // Subpixel translation: rounding every touchpad event stutters.
        this._slider.translation_x = -progress * width;
        this._applyCardMotion(progress);
    }

    easeTo(progress, width, duration, onComplete) {
        this._width = width;
        this._slider.remove_all_transitions();
        this._records.forEach(pane => pane.remove_all_transitions());

        this._slider.ease({
            translation_x: -progress * width,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT ?? Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                try {
                    onComplete();
                } catch (e) {
                    console.error('[MacGesture] overlay complete failed:', e);
                }
            },
        });

        const t = Math.min(1, Math.abs(progress));
        for (const pane of this._records) {
            const isCurrent = pane === this._records[1];
            const scale = isCurrent ? 1 - 0.045 * t : 0.955 + 0.045 * t;
            const opacity = isCurrent ? 255 * (1 - 0.12 * t) : 255;
            pane.ease({
                scale_x: scale,
                scale_y: scale,
                opacity,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT ?? Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    /**
     * Elastic bounce-back: slide the current pane to `peakProgress` then spring
     * back to 0, giving the user a tactile "can't go further" feedback.
     * onComplete is called when the animation is fully back at rest.
     * @param {number} peakProgress  Fraction of width to slide (e.g. 0.12 for ~12%)
     * @param {number} width         Monitor width in px
     * @param {Function} onComplete
     */
    easeBounceTo(peakProgress, width, onComplete) {
        this._slider.remove_all_transitions();
        this._records.forEach(pane => pane.remove_all_transitions());

        // Phase 1 – slide out quickly
        this._slider.ease({
            translation_x: -peakProgress * width,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // Phase 2 – spring back to 0 with overshoot feel
                this._slider.ease({
                    translation_x: 0,
                    duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_ELASTIC ??
                          Clutter.AnimationMode.EASE_OUT_BACK ??
                          Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        try {
                            onComplete();
                        } catch (e) {
                            console.error('[MacGesture] bounce complete failed:', e);
                        }
                    },
                });
            },
        });

        // Phase 1 – subtle scale pulse on the single pane
        const pane = this._records[1] ?? this._records[0];
        if (pane) {
            pane.ease({
                scale_x: 0.97,
                scale_y: 0.97,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    pane.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 220,
                        mode: Clutter.AnimationMode.EASE_OUT_ELASTIC ??
                              Clutter.AnimationMode.EASE_OUT_BACK ??
                              Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                },
            });
        }
    }

    _applyCardMotion(progress) {
        if (this._records.length === 1) {
            const t = Math.min(1, Math.abs(progress));
            const pane = this._records[0];
            pane.scale_x = pane.scale_y = 1 - 0.03 * t;
            pane.opacity = 255;
            return;
        }

        const t = Math.min(1, Math.abs(progress));
        const current = this._records[1];
        const incoming = progress < 0 ? this._records[0] : this._records[2];
        const outgoingSide = progress < 0 ? this._records[2] : this._records[0];

        if (current) {
            current.scale_x = current.scale_y = 1 - 0.045 * t;
            current.opacity = Math.round(255 * (1 - 0.12 * t));
        }
        if (incoming) {
            incoming.scale_x = incoming.scale_y = 0.955 + 0.045 * t;
            incoming.opacity = 255;
        }
        if (outgoingSide && outgoingSide !== incoming) {
            outgoingSide.scale_x = outgoingSide.scale_y = 0.955;
            outgoingSide.opacity = 255;
        }
    }

    stopEase() {
        this._slider.remove_all_transitions();
        this._records.forEach(pane => pane.remove_all_transitions());
        this.remove_all_transitions();
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
        this._forwardWindow = null;
        this._backWindow = null;
        this._cycle = null;
        this._cycleIndex = 0;
        this._activatedByUs = null;
        this._activateTime = 0;
        this._focusHandlerId = global.display.connect(
            'notify::focus-window',
            () => this._onFocusWindowChanged());
        this._finishLaterId = 0;
        this._finishIdleId = 0;
        this._finishWatchdogId = 0;
        this._finishGeneration = 0;
        this._pendingStep = 0;
        this._monitorIndex = 0;
        this._monitorWidth = 0;
        this._live = true;
        this._progress = 0;
        this._unredirectDisabled = false;
        this._singleBounce = false;
    }

    get busy() {
        return this._busy;
    }

    /**
     * Whether a new gesture may start. Keep this cheap — it runs on the
     * touchpad capture path.
     */
    canBegin() {
        // Do not reject while _busy: a fast follow-up swipe must interrupt
        // the settle animation (same as js/ui/workspaceAnimation.js, which
        // stops the in-progress ease and continues the gesture).

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

        return this._cycleLength() >= 2 || this._listApps().length >= 2;
    }

    /**
     * Whether there is exactly one open window and it is minimized.
     * Used by gestureHandler to decide whether to trigger a single-window reveal.
     */
    canRevealSingle() {
        if (Main.overview.visible) return false;
        if (Main.sessionMode.isLocked) return false;
        if (Main.modalCount > 0) return false;
        if (Main.actionMode !== Shell.ActionMode.NORMAL) return false;

        const apps = this._listApps();
        return apps.length === 1 && apps[0].window.minimized;
    }

    /**
     * Whether there is exactly one open window and it is NOT minimized (user
     * is actively using it). Swiping should bounce back and do nothing.
     */
    shouldBounce() {
        if (Main.overview.visible) return false;
        if (Main.sessionMode.isLocked) return false;
        if (Main.modalCount > 0) return false;
        if (Main.actionMode !== Shell.ActionMode.NORMAL) return false;

        const apps = this._listApps();
        return apps.length === 1 && !apps[0].window.minimized;
    }

    /**
     * Start a "bounce back" gesture for the case where only one non-minimized
     * window is open. The overlay shows the current window and snaps back.
     * Returns true if the bounce was started.
     */
    beginBounce() {
        this._interrupt();

        const apps = this._listApps();
        if (apps.length !== 1 || apps[0].window.minimized)
            return false;

        this._busy = true;
        this._live = this._settings.get_string('animation-style') === 'live';
        this._monitorIndex = this._pickMonitorIndex();
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        this._monitorWidth = monitor?.width ?? Main.layoutManager.primaryMonitor.width;
        this._singleBounce = true;

        if (this._live) {
            try {
                this._createBounceOverlay(apps[0].window);
            } catch (e) {
                console.error('[MacGesture] bounce overlay failed:', e);
                this._destroyOverlay();
                this._live = false;
            }
        }

        return true;
    }

    /**
     * Reveal and activate the single minimized window (no overlay needed).
     */
    revealSingle() {
        const apps = this._listApps();
        if (apps.length !== 1 || !apps[0].window.minimized)
            return;
        this._activate(apps[0].window);
    }

    /**
     * Called by gestureHandler during a bounce swipe to update the visual.
     * We pass through to the normal update but clamp to a small range so it
     * feels "springy" and doesn't go too far.
     */
    updateBounce(progress) {
        if (!this._singleBounce || !this._live || !this._overlay)
            return;
        // Clamp to ±15% — the window can't slide off screen in bounce mode
        const clamped = Math.sign(progress) * Math.min(Math.abs(progress), 0.15);
        try {
            this._overlay.setProgress(clamped, this._monitorWidth);
        } catch (e) {
            console.error('[MacGesture] bounce update failed:', e);
        }
    }

    /**
     * End a bounce gesture — spring back to 0 and clean up.
     */
    endBounce(currentProgress) {
        if (!this._busy || !this._singleBounce)
            return;

        if (!this._live || !this._overlay) {
            this._singleBounce = false;
            this._cleanupSwitch();
            return;
        }

        const generation = this._finishGeneration;
        const peak = Math.sign(currentProgress) * Math.min(Math.abs(currentProgress), 0.15);

        try {
            this._overlay.easeBounceTo(peak, this._monitorWidth, () => {
                if (generation !== this._finishGeneration) return;
                this._singleBounce = false;
                this._cleanupSwitch();
            });
            this._armFinishWatchdog(generation, 340);
        } catch (e) {
            console.error('[MacGesture] bounce end failed:', e);
            this._singleBounce = false;
            this._cleanupSwitch();
        }
    }

    begin() {
        this._interrupt();
        if (!this._ensureCycle())
            return false;

        this._bindCycleWindows();
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

        const step = endProgress < 0 ? 1 : endProgress > 0 ? -1 : 0;
        const commit = step !== 0;
        this._pendingStep = step;
        if (commit)
            this._toWindow = step > 0 ? this._forwardWindow : this._backWindow;

        if (!this._live || !this._overlay) {
            if (commit)
                this._commitCycle(step);
            this._pendingStep = 0;
            this._cleanupSwitch();
            return;
        }

        const generation = this._finishGeneration;
        const finish = () => {
            if (generation !== this._finishGeneration)
                return;

            if (commit) {
                this._commitCycle(step);
                this._pendingStep = 0;
                this._scheduleOverlayRemoval(generation);
                return;
            }
            this._pendingStep = 0;
            this._cleanupSwitch();
        };

        // Zero-duration / already-there: Clutter.ease may never emit onComplete.
        if (!duration || duration < 16) {
            finish();
            return;
        }

        try {
            this._overlay.easeTo(endProgress, this._monitorWidth, duration, finish);
            this._armFinishWatchdog(generation, duration);
        } catch (e) {
            console.error('[MacGesture] overlay ease failed:', e);
            finish();
        }
    }

    cancel() {
        if (!this._busy)
            return;

        this._finishGeneration++;
        this._pendingStep = 0;
        this._singleBounce = false;
        try {
            this._overlay?.stopEase();
        } catch (e) {
            console.error('[MacGesture] overlay cancel failed:', e);
        }

        this._cleanupSwitch();
    }

    destroy() {
        this._finishGeneration++;
        this._pendingStep = 0;
        this.cancel();
        this._clearFinishSources();
        if (this._focusHandlerId) {
            global.display.disconnect(this._focusHandlerId);
            this._focusHandlerId = 0;
        }
        this._cycle = null;
        this._activatedByUs = null;
        this._settings = null;
        this._tracker = null;
    }

    /**
     * Abort an in-flight settle so a new swipe can start immediately.
     * Any committed-but-not-yet-shown target is activated first so the
     * frozen cycle index stays in sync.
     */
    _interrupt() {
        this._finishGeneration++;
        this._clearFinishSources();

        try {
            this._overlay?.stopEase();
        } catch (e) {
            console.error('[MacGesture] overlay interrupt failed:', e);
        }

        if (this._pendingStep) {
            this._commitCycle(this._pendingStep);
            this._pendingStep = 0;
        }

        this._destroyOverlay();
        this._busy = false;
        this._fromWindow = null;
        this._toWindow = null;
        this._forwardWindow = null;
        this._backWindow = null;
        this._progress = 0;
    }

    _scheduleOverlayRemoval(generation) {
        const remove = () => {
            if (generation !== this._finishGeneration)
                return;
            this._cleanupSwitch();
        };

        try {
            const laters = global.compositor?.get_laters?.();
            if (laters) {
                this._finishLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._finishLaterId = 0;
                    remove();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (e) {
            console.error('[MacGesture] laters.add failed:', e);
        }

        if (!this._finishLaterId) {
            this._finishIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._finishIdleId = 0;
                remove();
                return GLib.SOURCE_REMOVE;
            });
        }

        // BEFORE_REDRAW can be skipped under load (fast successive swipes).
        this._armFinishWatchdog(generation, 80);
    }

    _armFinishWatchdog(generation, duration) {
        this._clearFinishWatchdog();
        const wait = Math.max(120, (duration || 0) + 80);
        this._finishWatchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this._finishWatchdogId = 0;
            if (generation !== this._finishGeneration)
                return GLib.SOURCE_REMOVE;
            if (this._busy)
                this._cleanupSwitch();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._finishWatchdogId, '[MacGesture] finish watchdog');
    }

    _clearFinishWatchdog() {
        if (this._finishWatchdogId) {
            GLib.source_remove(this._finishWatchdogId);
            this._finishWatchdogId = 0;
        }
    }

    _clearFinishSources() {
        if (this._finishLaterId) {
            try {
                const laters = global.compositor?.get_laters?.();
                laters?.remove(this._finishLaterId);
            } catch {
            }
            this._finishLaterId = 0;
        }
        if (this._finishIdleId) {
            GLib.source_remove(this._finishIdleId);
            this._finishIdleId = 0;
        }
        this._clearFinishWatchdog();
    }

    _cleanupSwitch() {
        this._clearFinishSources();
        this._pendingStep = 0;
        this._singleBounce = false;

        this._destroyOverlay();
        this._busy = false;
        this._fromWindow = null;
        this._toWindow = null;
        this._forwardWindow = null;
        this._backWindow = null;
        this._progress = 0;
    }

    _onFocusWindowChanged() {
        if (this._busy)
            return;
        if (this._activateTime &&
            GLib.get_monotonic_time() - this._activateTime < 500000)
            return;
        const focus = global.display.focus_window;
        if (!focus || focus === this._activatedByUs)
            return;
        // User clicked / Alt+Tabbed to a different window: start a fresh MRU
        // list on the next swipe so the frozen path does not fight them.
        this._cycle = null;
        this._cycleIndex = 0;
        this._activatedByUs = null;
    }

    _cycleLength() {
        return this._cycle?.length ?? 0;
    }

    _ensureCycle() {
        if (this._refreshCycle()) {
            const anchor = this._activatedByUs ?? global.display.focus_window;
            if (anchor) {
                const idx = this._cycle.findIndex(entry => entry.window === anchor);
                if (idx >= 0)
                    this._cycleIndex = idx;
            }
            return true;
        }

        const apps = this._listApps();
        if (apps.length < 2)
            return false;

        this._cycle = apps;
        this._cycleIndex = 0;

        const focus = global.display.focus_window;
        if (focus) {
            const idx = apps.findIndex(entry => entry.window === focus);
            if (idx >= 0)
                this._cycleIndex = idx;
        }

        return true;
    }

    _refreshCycle() {
        if (!this._cycle || this._cycle.length < 2)
            return false;

        const live = this._listApps();
        // Key refresh by window identity so each window stays a separate slot
        const byWindow = new Map(live.map(entry => [entry.window, entry]));
        const kept = [];
        for (const entry of this._cycle) {
            const fresh = byWindow.get(entry.window);
            if (fresh)
                kept.push(fresh);
        }

        if (kept.length < 2) {
            this._cycle = null;
            this._cycleIndex = 0;
            return false;
        }

        // Keep the frozen Super+Tab index. Do not snap back to focus_window:
        // after a fast swipe, activate() has not always been applied yet, so
        // realigning to focus would rewind the cycle and look "stuck".
        const currentWindow = this._cycle[this._cycleIndex]?.window;
        this._cycle = kept;
        const idx = kept.findIndex(entry => entry.window === currentWindow);
        this._cycleIndex = idx >= 0 ? idx : 0;
        return true;
    }

    _bindCycleWindows() {
        const n = this._cycle.length;
        const i = this._cycleIndex;
        this._fromWindow = this._cycle[i].window;
        this._forwardWindow = this._cycle[(i + 1) % n].window;
        this._backWindow = this._cycle[(i - 1 + n) % n].window;
    }

    _commitCycle(step) {
        const n = this._cycleLength();
        if (n < 2 || step === 0)
            return;

        this._cycleIndex = (this._cycleIndex + step + n) % n;
        this._activate(this._cycle[this._cycleIndex].window);
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
     * One entry per WINDOW (not per app), in MRU order.
     * Multiple windows of the same app appear as separate cycle entries.
     */
    _listApps() {
        const workspace = this._settings.get_boolean('all-workspaces')
            ? null
            : global.workspace_manager.get_active_workspace();

        // js/ui/altTab.js getWindows() — NORMAL_ALL then skip_taskbar / transients.
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
            .map(w => w.is_attached_dialog() ? w.get_transient_for() : w)
            .filter((w, i, a) => w && !w.skip_taskbar && a.indexOf(w) === i);

        // Build one entry per window, keeping MRU order from get_tab_list.
        // This allows multiple windows of the same app to be cycled individually.
        // Include every valid window even if an app tracker returns null.
        return windows.map(w => ({
            app: this._tracker.get_window_app(w) ?? null,
            window: w,
        }));
    }

    _createOverlay() {
        this._destroyOverlay();
        this._disableUnredirect();

        const overlay = new SwitchOverlay(this._monitorIndex);
        this._overlay = overlay;

        const monitor = Main.layoutManager.monitors[this._monitorIndex] ?? Main.layoutManager.primaryMonitor;
        const wallpaper = this._cloneWallpaper(monitor) ?? this._solidCover(monitor);
        overlay.setWallpaper(wallpaper);

        const width = this._monitorWidth;
        // Cards are window clones only (wallpaper is static behind them).
        // Right swipe (natural, negative progress) brings _forwardWindow from
        // the left; left swipe brings _backWindow from the right.
        overlay.addPane(this._makePane(this._forwardWindow, false), -width);
        overlay.addPane(this._makePane(this._fromWindow, true), 0);
        overlay.addPane(this._makePane(this._backWindow, false), width);

        // js/ui/workspaceAnimation.js MonitorGroup: insert above window_group
        // so clones cover real windows without restacking the compositor list.
        Main.uiGroup.insert_child_above(overlay, global.window_group);
        overlay.setProgress(0, width);
    }

    /**
     * Create a one-pane overlay for the bounce animation (single visible window).
     * Only the current-window pane is added; nothing to slide in from sides.
     */
    _createBounceOverlay(window) {
        this._destroyOverlay();
        this._disableUnredirect();

        const overlay = new SwitchOverlay(this._monitorIndex);
        this._overlay = overlay;

        const monitor = Main.layoutManager.monitors[this._monitorIndex] ?? Main.layoutManager.primaryMonitor;
        const wallpaper = this._cloneWallpaper(monitor) ?? this._solidCover(monitor);
        overlay.setWallpaper(wallpaper);

        // Single centre pane only — no left/right neighbours
        overlay.addPane(this._makePane(window, true), 0);

        Main.uiGroup.insert_child_above(overlay, global.window_group);
        overlay.setProgress(0, this._monitorWidth);
    }

    _destroyOverlay() {
        this._enableUnredirect();
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

    // Mutter scans out unredirected (fullscreen/focused) windows directly, so
    // their actor has no composited texture and Clutter.Clone paints blank —
    // the slide then appears frozen until release. Mirror workspaceAnimation.js:
    // keep unredirect disabled while the live overlay exists so clones capture
    // window content and follow the fingers.
    _disableUnredirect() {
        if (this._unredirectDisabled)
            return;
        try {
            global.compositor.disable_unredirect();
            this._unredirectDisabled = true;
        } catch (e) {
            console.error('[MacGesture] disable_unredirect failed:', e);
        }
    }

    _enableUnredirect() {
        if (!this._unredirectDisabled)
            return;
        this._unredirectDisabled = false;
        this._singleBounce = false;
        try {
            global.compositor.enable_unredirect();
        } catch (e) {
            console.error('[MacGesture] enable_unredirect failed:', e);
        }
    }

    /**
     * Full-monitor slide card. Wallpaper is a child of the pane so windowed
     * apps animate like GNOME workspace switches (the whole desktop moves),
     * not as a tiny clone over a hole in a transparent layer.
     *
     * @param {Meta.Window} window
     * @param {boolean} snapshotMonitor  If true, clone every visible window on
     *     this monitor (outgoing frame). If false, clone only this window and
     *     its attached dialogs (incoming app).
     * @returns {Clutter.Actor}
     */
    _makePane(window, snapshotMonitor) {
        const monitor = Main.layoutManager.monitors[this._monitorIndex] ?? Main.layoutManager.primaryMonitor;
        const pane = new Clutter.Actor({
            width: monitor.width,
            height: monitor.height,
            clip_to_allocation: true,
        });

        if (window)
            this._addWindowClones(pane, monitor, window);

        return pane;
    }

    /**
     * Clone the desktop background. Prefer the whole _backgroundGroup: live-
     * wallpaper extensions (LiveEngine, Hanabi) reparent their renderer actor
     * into that group on top of the static backgroundActor, so cloning only the
     * per-monitor backgroundActor shows a frozen wallpaper. Never construct a
     * BackgroundManager — that retriggers fade-in.
     *
     * @param {object} monitor
     * @returns {Clutter.Actor|null}
     */
    _cloneWallpaper(monitor) {
        try {
            const group = Main.layoutManager._backgroundGroup;
            if (group) {
                return new Clutter.Clone({
                    source: group,
                    x: -monitor.x,
                    y: -monitor.y,
                });
            }
        } catch (e) {
            console.error('[MacGesture] backgroundGroup clone failed:', e);
        }

        try {
            const bgActor = Main.layoutManager._bgManagers?.[this._monitorIndex]?.backgroundActor;
            if (bgActor) {
                const clone = new Clutter.Clone({source: bgActor});
                const [x, y] = this._stagePos(bgActor);
                clone.x = x - monitor.x;
                clone.y = y - monitor.y;
                return clone;
            }
        } catch (e) {
            console.error('[MacGesture] monitor wallpaper clone failed:', e);
        }

        return null;
    }

    _solidCover(monitor) {
        return new St.Widget({
            style_class: 'macgesture-cover',
            width: monitor.width,
            height: monitor.height,
        });
    }

    /**
     * Destination / current pane: that window plus attached dialogs, so a
     * windowed app floats at its real frame over the static wallpaper.
     *
     * @param {Clutter.Actor} pane
     * @param {object} monitor
     * @param {Meta.Window} window
     */
    _addWindowClones(pane, monitor, window) {
        const wanted = new Set([window]);
        for (const actor of global.get_window_actors()) {
            const other = actor.meta_window;
            if (!other)
                continue;
            let parent = other.get_transient_for();
            let hops = 0;
            while (parent && hops++ < 8) {
                if (parent === window) {
                    wanted.add(other);
                    break;
                }
                parent = parent.get_transient_for();
            }
        }

        const actors = global.get_window_actors();
        let cloned = false;
        for (const actor of actors) {
            const metaWindow = actor.meta_window;
            if (!wanted.has(metaWindow))
                continue;
            if (!this._windowIntersectsMonitor(metaWindow, monitor))
                continue;
            if (this._attachClone(pane, monitor, actor, metaWindow))
                cloned = true;
        }

        if (!cloned)
            this._attachPlaceholder(pane, monitor, window);
    }

    /**
     * @param {Meta.Window} window
     * @param {object} monitor
     */
    _shouldCloneWindow(window, monitor) {
        if (!window || window.is_override_redirect())
            return false;
        if (window.get_window_type() === Meta.WindowType.DESKTOP)
            return false;
        return this._windowIntersectsMonitor(window, monitor);
    }

    _windowIntersectsMonitor(window, monitor) {
        try {
            const frame = window.get_frame_rect();
            const geometry = global.display.get_monitor_geometry(this._monitorIndex);
            const [intersects] = frame.intersect(geometry);
            return intersects;
        } catch {
            return window.get_monitor() === this._monitorIndex;
        }
    }

    /**
     * Position a Clutter.Clone the way WorkspaceGroup._createClone does, but
     * prefer transformed / buffer coords. Windowed actors often do not fill
     * the pane; pinning them with actor.x/y (or 0,0) is why those slides
     * looked like a no-op compared with fullscreen.
     *
     * @param {Clutter.Actor} pane
     * @param {object} monitor
     * @param {Clutter.Actor} windowActor
     * @param {Meta.Window} window
     * @returns {boolean}
     */
    _attachClone(pane, monitor, windowActor, window) {
        if (!windowActor || window.minimized)
            return false;
        if (!(windowActor.width > 0 && windowActor.height > 0))
            return false;

        try {
            const [x, y] = this._cloneOffset(windowActor, window, monitor);
            const card = new St.Widget({
                style_class: 'macgesture-float-card',
                layout_manager: new Clutter.BinLayout(),
                x,
                y,
                width: windowActor.width,
                height: windowActor.height,
                clip_to_allocation: true,
            });
            const clone = new Clutter.Clone({
                source: windowActor,
                x: 0,
                y: 0,
                width: windowActor.width,
                height: windowActor.height,
            });
            card.add_child(clone);

            windowActor.connectObject('destroy', () => {
                try {
                    card.destroy();
                } catch {
                }
            }, card);

            pane.add_child(card);
            return true;
        } catch (e) {
            console.error('[MacGesture] clone failed:', e);
            return false;
        }
    }

    /**
     * @param {Clutter.Actor} actor
     * @param {Meta.Window} window
     * @param {object} monitor
     * @returns {[number, number]}
     */
    _cloneOffset(actor, window, monitor) {
        // Clutter.Clone paints from the source actor's origin, so the clone
        // must sit at the actor's *stage* position relative to this monitor.
        // actor.x is not enough: windowed Meta.WindowActor often has shadows
        // and parent offsets (window_group) that fullscreen windows hide.
        try {
            const [tx, ty] = actor.get_transformed_position();
            if (Number.isFinite(tx) && Number.isFinite(ty))
                return [Math.round(tx - monitor.x), Math.round(ty - monitor.y)];
        } catch {
        }

        try {
            const rect = window.get_buffer_rect();
            return [Math.round(rect.x - monitor.x), Math.round(rect.y - monitor.y)];
        } catch {
        }

        return [Math.round(actor.x - monitor.x), Math.round(actor.y - monitor.y)];
    }

    /**
     * @param {Clutter.Actor} actor
     * @returns {[number, number]}
     */
    _stagePos(actor) {
        try {
            const [x, y] = actor.get_transformed_position();
            if (Number.isFinite(x) && Number.isFinite(y))
                return [x, y];
        } catch {
        }
        return [actor.x, actor.y];
    }

    /**
     * @param {Clutter.Actor} pane
     * @param {object} monitor
     * @param {Meta.Window} window
     */
    _attachPlaceholder(pane, monitor, window) {
        try {
            const app = this._tracker.get_window_app(window);
            const cardWidth = Math.min(monitor.width - 200, 960);
            const cardHeight = Math.min(monitor.height - 200, 600);
            const box = new St.Widget({
                style_class: 'macgesture-placeholder',
                width: cardWidth,
                height: cardHeight,
                layout_manager: new Clutter.BinLayout(),
                x: Math.round((monitor.width - cardWidth) / 2),
                y: Math.round((monitor.height - cardHeight) / 2),
            });

            const content = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });

            const size = 128;
            let iconActor = null;
            if (app)
                iconActor = app.create_icon_texture(size);
            if (!iconActor) {
                iconActor = new St.Icon({
                    icon_name: 'application-x-executable-symbolic',
                    icon_size: size,
                });
            }
            content.add_child(iconActor);

            const titleText = window.get_title() || app?.get_name() || '';
            if (titleText) {
                content.add_child(new St.Label({
                    text: titleText,
                    style: 'font-size: 16pt; font-weight: bold; color: white; margin-top: 16px;',
                }));
            }

            box.add_child(content);
            pane.add_child(box);
        } catch (e) {
            console.error('[MacGesture] placeholder failed:', e);
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
            this._activatedByUs = window;
            this._activateTime = GLib.get_monotonic_time();
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
