// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const _MODIFIER_KEYVALS = new Set([
    0, 65505, 65506, 65507, 65508, 65509, 65510,
    65511, 65512, 65513, 65514, 65515, 65516,
    65517, 65518, 65027, 65407, 65300,
]);
const _isModifierKey = keyval => _MODIFIER_KEYVALS.has(keyval);

export default class MacGesturePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        // Action arrays initialized inside method so gettext / _ has valid extension context
        this._verticalActions = [
            _('Show Activities'),          // 0
            _('Volume Up / Down'),         // 1
            _('Brightness Up / Down'),     // 2
            _('Maximize / Minimize'),      // 3
            _('Close Window'),             // 4
            _('Show Desktop'),             // 5
            _('Custom Keybind'),           // 6
            _('Disabled'),                 // 7
        ];

        this._leftActions = [
            _('Workspace Left'),           // 0
            _('Brightness Down'),          // 1
            _('Alt+Tab — Previous App'),   // 2
            _('Previous Media Track'),     // 3
            _('Custom Keybind'),           // 4
            _('Disabled'),                 // 5
        ];

        this._rightActions = [
            _('Workspace Right'),          // 0
            _('Brightness Up'),            // 1
            _('Alt+Tab — Next App'),       // 2
            _('Next Media Track'),         // 3
            _('Custom Keybind'),           // 4
            _('Disabled'),                 // 5
        ];

        this._tapActions = [
            _('Play / Pause Media'),       // 0
            _('Show Desktop'),             // 1
            _('Cycle Workspaces'),         // 2
            _('Show Notifications'),       // 3
            _('Custom Keybind'),           // 4
            _('Disabled'),                 // 5
        ];

        window.set_default_size(680, 720);

        // Page 1: App Switcher (Horizontal Swipe)
        const appSwitcherPage = new Adw.PreferencesPage({
            title: _('App Switcher'),
            icon_name: 'focus-windows-symbolic',
        });
        this._buildAppSwitcherPage(appSwitcherPage, settings, window);
        window.add(appSwitcherPage);

        // Page 2: 3-Finger Gestures
        const threeFingerPage = new Adw.PreferencesPage({
            title: _('3-Finger Gestures'),
            icon_name: 'input-touchpad-symbolic',
        });
        this._buildThreeFingerPage(threeFingerPage, settings, window);
        window.add(threeFingerPage);

        // Page 3: 4-Finger Gestures
        const fourFingerPage = new Adw.PreferencesPage({
            title: _('4-Finger Gestures'),
            icon_name: 'input-touchpad-symbolic',
        });
        this._buildFourFingerPage(fourFingerPage, settings, window);
        window.add(fourFingerPage);
    }

    // ── App Switcher Page ─────────────────────────────────────────────────────

    _buildAppSwitcherPage(page, settings, window) {
        const settingIds = [];

        // Group 1: Behavior & Direction
        const gestureGroup = new Adw.PreferencesGroup({
            title: _('App Switcher Gesture'),
            description: _('Horizontal 3-finger swipe dynamically switches between running applications with live window animation.'),
        });

        const invert = new Adw.SwitchRow({
            title: _('Invert swipe direction'),
            subtitle: _('Applied on top of system natural scrolling'),
        });
        settings.bind('invert-direction', invert, 'active', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(invert);

        const thresholdAdj = new Gtk.Adjustment({
            lower: 0.15,
            upper: 0.85,
            step_increment: 0.05,
            page_increment: 0.10,
            value: 0.40,
        });
        const thresholdScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: thresholdAdj,
            digits: 2,
            hexpand: true,
            draw_value: true,
            width_request: 180,
        });
        const thresholdRow = new Adw.ActionRow({
            title: _('Swipe distance threshold'),
            subtitle: _('Fraction of swipe required to commit switch'),
        });
        thresholdRow.add_suffix(thresholdScale);
        thresholdRow.set_activatable_widget(thresholdScale);
        settings.bind('swipe-threshold', thresholdAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
        gestureGroup.add(thresholdRow);

        page.add(gestureGroup);

        // Group 2: Animation
        const animGroup = new Adw.PreferencesGroup({
            title: _('Animation'),
        });

        const styleModel = new Gtk.StringList();
        styleModel.append(_('Live (window clones follow fingers)'));
        styleModel.append(_('Simple (switch upon release)'));

        const styleRow = new Adw.ComboRow({
            title: _('Animation style'),
            model: styleModel,
            selected: settings.get_string('animation-style') === 'simple' ? 1 : 0,
        });
        styleRow.connect('notify::selected', () => {
            settings.set_string('animation-style', styleRow.selected === 1 ? 'simple' : 'live');
        });
        settingIds.push(settings.connect('changed::animation-style', () => {
            const selected = settings.get_string('animation-style') === 'simple' ? 1 : 0;
            if (styleRow.selected !== selected)
                styleRow.selected = selected;
        }));
        animGroup.add(styleRow);

        const duration = new Adw.SpinRow({
            title: _('Animation duration'),
            subtitle: _('Milliseconds for commit or snap-back animation'),
            adjustment: new Gtk.Adjustment({
                lower: 100,
                upper: 500,
                step_increment: 10,
                page_increment: 50,
                value: 250,
            }),
        });
        settings.bind('animation-duration', duration, 'value', Gio.SettingsBindFlags.DEFAULT);
        animGroup.add(duration);

        page.add(animGroup);

        // Group 3: Scope
        const scopeGroup = new Adw.PreferencesGroup({
            title: _('Scope & Rules'),
        });

        const allWorkspaces = new Adw.SwitchRow({
            title: _('Include apps from all workspaces'),
            subtitle: _('When disabled, only apps on the current workspace are cycled'),
        });
        settings.bind('all-workspaces', allWorkspaces, 'active', Gio.SettingsBindFlags.DEFAULT);
        scopeGroup.add(allWorkspaces);

        const ignoreFs = new Adw.SwitchRow({
            title: _('Ignore in fullscreen apps'),
            subtitle: _('Do not trigger app switcher while a fullscreen window is active'),
        });
        settings.bind('ignore-fullscreen', ignoreFs, 'active', Gio.SettingsBindFlags.DEFAULT);
        scopeGroup.add(ignoreFs);

        page.add(scopeGroup);

        window.connect('close-request', () => {
            for (const id of settingIds)
                settings.disconnect(id);
            settingIds.length = 0;
        });
    }

    // ── 3-Finger Page ─────────────────────────────────────────────────────────

    _buildThreeFingerPage(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('3-Finger Gestures'),
            description: _('Note: Horizontal swipes (Left / Right) are reserved for App Switching.'),
        });
        page.add(group);

        const rows = [
            [_('Swipe Up'), 'three-swipe-up', this._verticalActions],
            [_('Swipe Down'), 'three-swipe-down', this._verticalActions],
            [_('Three-Finger Tap'), 'three-tap', this._tapActions],
        ];

        for (const [title, prefix, actions] of rows)
            this._buildGestureRow(window, group, title, prefix, actions, settings);
    }

    // ── 4-Finger Page ─────────────────────────────────────────────────────────

    _buildFourFingerPage(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: _('4-Finger Gestures'),
            description: _('Customize 4-finger swipes and tap actions.'),
        });
        page.add(group);

        const rows = [
            [_('Swipe Up'), 'four-swipe-up', this._verticalActions],
            [_('Swipe Down'), 'four-swipe-down', this._verticalActions],
            [_('Swipe Left'), 'four-swipe-left', this._leftActions],
            [_('Swipe Right'), 'four-swipe-right', this._rightActions],
            [_('Four-Finger Tap'), 'four-tap', this._tapActions],
        ];

        for (const [title, prefix, actions] of rows)
            this._buildGestureRow(window, group, title, prefix, actions, settings);
    }

    // ── Row Builder with Keybind Recorder ─────────────────────────────────────

    _buildGestureRow(window, group, title, prefix, actions, settings) {
        const customIndex = actions.indexOf(_('Custom Keybind'));

        const combo = new Adw.ComboRow({
            title,
            model: new Gtk.StringList({strings: actions}),
        });
        settings.bind(`${prefix}-action`, combo, 'selected', Gio.SettingsBindFlags.DEFAULT);
        group.add(combo);

        if (customIndex === -1) return;

        const keybindRow = new Adw.ActionRow({
            title: _('Keybind'),
            subtitle: this._keybindLabel(settings.get_string(`${prefix}-keybind`)),
        });

        const recordBtn = new Gtk.Button({
            label: _('Record'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        const clearBtn = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        keybindRow.add_suffix(recordBtn);
        keybindRow.add_suffix(clearBtn);
        group.add(keybindRow);

        const updateVisibility = () => {
            keybindRow.visible = combo.selected === customIndex;
        };
        combo.connect('notify::selected', updateVisibility);
        updateVisibility();

        settings.connect(`changed::${prefix}-keybind`, () => {
            keybindRow.subtitle = this._keybindLabel(settings.get_string(`${prefix}-keybind`));
        });

        recordBtn.connect('clicked', () => {
            const dialog = new Gtk.Window({
                title: _('Record Keybind'),
                modal: true,
                transient_for: window,
                default_width: 400,
                default_height: 200,
                resizable: false,
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 24, margin_bottom: 24,
                margin_start: 24, margin_end: 24,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });

            const titleLabel = new Gtk.Label({
                label: _('Press any key combination…'),
                css_classes: ['title-3'],
            });
            const feedbackLabel = new Gtk.Label({
                label: _('(Press Escape to cancel)'),
                css_classes: ['dim-label'],
            });

            box.append(titleLabel);
            box.append(feedbackLabel);
            dialog.set_child(box);

            let captured = false;
            const keyCtrl = new Gtk.EventControllerKey();
            keyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            dialog.add_controller(keyCtrl);

            const _updateModLabel = (mods) => {
                const parts = [];
                if (mods & Gdk.ModifierType.CONTROL_MASK) parts.push('Ctrl');
                if (mods & Gdk.ModifierType.ALT_MASK) parts.push('Alt');
                if (mods & Gdk.ModifierType.SHIFT_MASK) parts.push('Shift');
                if (mods & Gdk.ModifierType.SUPER_MASK) parts.push('Super');
                if (mods & Gdk.ModifierType.HYPER_MASK) parts.push('Hyper');
                if (mods & Gdk.ModifierType.META_MASK) parts.push('Meta');
                feedbackLabel.label = parts.length > 0 ? parts.join(' + ') + ' + …' : _('(Press Escape to cancel)');
            };

            keyCtrl.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
                if (captured) return true;

                if (keyval === Gdk.KEY_Escape && !(state & Gtk.accelerator_get_default_mod_mask())) {
                    dialog.close();
                    return true;
                }

                const mods = state & Gtk.accelerator_get_default_mod_mask();

                if (_isModifierKey(keyval)) {
                    _updateModLabel(mods);
                    return true;
                }

                captured = true;
                let finalKeyval = keyval;
                if (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z)
                    finalKeyval = keyval - Gdk.KEY_A + Gdk.KEY_a;

                const stored = `${finalKeyval}:${mods}`;
                settings.set_string(`${prefix}-keybind`, stored);

                const accelName = Gtk.accelerator_get_label(finalKeyval, mods);
                const displayLabel = accelName || Gtk.accelerator_name(finalKeyval, mods) || stored;
                keybindRow.subtitle = `${_('Recorded:')} ${displayLabel}`;

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    dialog.close();
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            });

            keyCtrl.connect('key-released', (_ctrl, _keyval, _keycode, state) => {
                if (captured) return;
                _updateModLabel(state & Gtk.accelerator_get_default_mod_mask());
            });

            keyCtrl.connect('modifiers', (_ctrl, state) => {
                if (captured) return true;
                _updateModLabel(state & Gtk.accelerator_get_default_mod_mask());
                return true;
            });

            dialog.present();
            const surface = dialog.get_surface?.() ?? null;
            if (surface) surface.inhibit_system_shortcuts(null);
        });

        clearBtn.connect('clicked', () => {
            settings.set_string(`${prefix}-keybind`, '');
            keybindRow.subtitle = _('Not set');
        });
    }

    _keybindLabel(stored) {
        if (!stored || !stored.includes(':')) return _('Not set — click Record');
        const [kv, mod] = stored.split(':').map(Number);
        if (!kv) return _('Not set — click Record');
        const pretty = Gtk.accelerator_get_label(kv, mod);
        if (pretty && pretty.length > 0) return `${_('Bound:')} ${pretty}`;
        const name = Gtk.accelerator_name(kv, mod);
        return name ? `${_('Bound:')} ${name}` : `${_('Bound: keyval')} ${kv} mod ${mod}`;
    }
}
