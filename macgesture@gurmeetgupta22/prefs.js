// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MacGesturePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: _('MacGesture'),
            icon_name: 'input-touchpad-symbolic',
        });

        const settingIds = [];
        page.add(this._gestureGroup(settings, settingIds));
        page.add(this._animationGroup(settings, settingIds));
        page.add(this._scopeGroup(settings));

        window.add(page);
        window.set_default_size(560, 520);

        window.connect('close-request', () => {
            for (const id of settingIds)
                settings.disconnect(id);
            settingIds.length = 0;
        });
    }

    _gestureGroup(settings, settingIds) {
        const group = new Adw.PreferencesGroup({
            title: _('Gesture'),
            description: _('3-finger horizontal swipe replaces GNOME workspace switching. 4-finger leaves the native 3-finger workspace gesture unchanged. Vertical 3-finger swipe still opens Overview.'),
        });

        const fingerModel = new Gtk.StringList();
        fingerModel.append(_('3 fingers'));
        fingerModel.append(_('4 fingers'));

        const fingerRow = new Adw.ComboRow({
            title: _('Gesture finger count'),
            subtitle: _('Use 4 fingers if you want to keep native workspace swipes'),
            model: fingerModel,
            selected: settings.get_int('finger-count') === 4 ? 1 : 0,
        });
        fingerRow.connect('notify::selected', () => {
            settings.set_int('finger-count', fingerRow.selected === 1 ? 4 : 3);
        });
        settingIds.push(settings.connect('changed::finger-count', () => {
            const selected = settings.get_int('finger-count') === 4 ? 1 : 0;
            if (fingerRow.selected !== selected)
                fingerRow.selected = selected;
        }));
        group.add(fingerRow);

        const invert = new Adw.SwitchRow({
            title: _('Invert swipe direction'),
            subtitle: _('Applied on top of the system natural-scroll setting'),
        });
        settings.bind('invert-direction', invert, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(invert);

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
            subtitle: _('Fraction of a full swipe needed to commit (lower is more sensitive)'),
        });
        thresholdRow.add_suffix(thresholdScale);
        thresholdRow.set_activatable_widget(thresholdScale);
        settings.bind('swipe-threshold', thresholdAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(thresholdRow);

        return group;
    }

    _animationGroup(settings, settingIds) {
        const group = new Adw.PreferencesGroup({
            title: _('Animation'),
        });

        const styleModel = new Gtk.StringList();
        styleModel.append(_('Live (follow fingers)'));
        styleModel.append(_('Simple (switch on gesture end)'));

        const styleRow = new Adw.ComboRow({
            title: _('Animation style'),
            subtitle: _('Simple mode skips clones and only activates the target app at the end'),
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
        group.add(styleRow);

        const duration = new Adw.SpinRow({
            title: _('Animation duration'),
            subtitle: _('Milliseconds for the commit or snap-back animation'),
            adjustment: new Gtk.Adjustment({
                lower: 100,
                upper: 500,
                step_increment: 10,
                page_increment: 50,
                value: 250,
            }),
        });
        settings.bind('animation-duration', duration, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(duration);

        return group;
    }

    _scopeGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Scope'),
        });

        const allWorkspaces = new Adw.SwitchRow({
            title: _('Include apps from all workspaces'),
            subtitle: _('Off: only applications with windows on the current workspace'),
        });
        settings.bind('all-workspaces', allWorkspaces, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(allWorkspaces);

        const ignoreFs = new Adw.SwitchRow({
            title: _('Ignore gestures in fullscreen apps'),
            subtitle: _('Leave a fullscreen window in control of the touchpad'),
        });
        settings.bind('ignore-fullscreen', ignoreFs, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(ignoreFs);

        return group;
    }
}
