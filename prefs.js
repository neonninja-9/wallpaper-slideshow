import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TRANSITIONS = [
    {id: 'fade', label: 'Fade'},
    {id: 'slide-left', label: 'Slide Left'},
    {id: 'slide-right', label: 'Slide Right'},
    {id: 'slide-up', label: 'Slide Up'},
    {id: 'slide-down', label: 'Slide Down'},
    {id: 'zoom-in', label: 'Zoom In'},
    {id: 'zoom-out', label: 'Zoom Out'},
    {id: 'none', label: 'None'},
    {id: 'random', label: 'Random Each Time'},
];

function getTransitions(gettext) {
    return TRANSITIONS.map(({id, label}) => ({id, label: gettext(label)}));
}

function formatInterval(gettext, seconds) {
    if (seconds < 60)
        return gettext('%d seconds').format(seconds);

    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return gettext('%d minutes').format(minutes);
    }

    const hours = Math.floor(seconds / 3600);
    return gettext('%d hours').format(hours);
}

class WallpaperPreview extends Gtk.Box {
    static {
        GObject.registerClass(this);
    }

    _init(gettext, params = {}) {
        this._gettext = gettext;

        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            halign: Gtk.Align.CENTER,
            ...params,
        });

        this._picture = new Gtk.Picture({
            width_request: 320,
            height_request: 180,
            content_fit: Gtk.ContentFit.COVER,
            can_shrink: true,
        });

        const frame = new Gtk.Frame({child: this._picture});
        this.append(frame);

        this._label = new Gtk.Label({
            label: this._gettext('Current wallpaper'),
            css_classes: ['caption', 'dim-label'],
        });
        this.append(this._label);

        this._bgSettings = new Gio.Settings({
            schema: 'org.gnome.desktop.background',
        });
        this._bgChangedId = this._bgSettings.connect(
            'changed::picture-uri',
            () => this._refresh()
        );

        this._refresh();
    }

    _refresh() {
        try {
            const uri = this._bgSettings.get_string('picture-uri');
            const [path] = GLib.filename_from_uri(uri);

            if (path) {
                this._picture.set_file(Gio.File.new_for_path(path));
                this._label.set_label(GLib.path_get_basename(path));
                return;
            }
        } catch (e) {
            logError(e, '[WallpaperSlideshow] Failed to refresh preview');
        }

        this._picture.set_file(null);
        this._label.set_label(this._gettext('No wallpaper set'));
    }

    vfunc_dispose() {
        if (this._bgChangedId) {
            this._bgSettings.disconnect(this._bgChangedId);
            this._bgChangedId = null;
        }

        this._bgSettings = null;
        super.vfunc_dispose();
    }
}

export default class WallpaperSlideshowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings();

        window.set_title(_('Wallpaper Slideshow'));
        if (window.set_search_enabled)
            window.set_search_enabled(true);
        else
            window.search_enabled = true;

        window.set_default_size(680, 760);

        window.add(this._buildGeneralPage(window, settings, _));
        window.add(this._buildTransitionPage(settings, _));
        window.add(this._buildAboutPage(_));
    }

    _buildGeneralPage(window, settings, _) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'folder-pictures-symbolic',
        });

        const previewGroup = new Adw.PreferencesGroup({
            title: _('Current Wallpaper'),
        });
        previewGroup.add(new WallpaperPreview(_));
        page.add(previewGroup);

        const sourceGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper Source'),
            description: _(
                'Choose a folder containing JPG, PNG, WEBP, BMP, or GIF images.'
            ),
        });

        const folderRow = new Adw.ActionRow({
            title: _('Wallpaper Folder'),
            subtitle: settings.get_string('wallpaper-folder') || _('Not set'),
        });

        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Clear folder'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        clearButton.connect('clicked', () => {
            settings.set_string('wallpaper-folder', '');
            folderRow.set_subtitle(_('Not set'));
        });
        folderRow.add_suffix(clearButton);

        const chooseButton = new Gtk.Button({
            label: _('Choose'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        chooseButton.connect('clicked', () => {
            const currentFolder = settings.get_string('wallpaper-folder');
            const dialogArgs = {
                title: _('Select Wallpaper Folder'),
                modal: true,
            };

            if (currentFolder)
                dialogArgs.initial_folder = Gio.File.new_for_path(currentFolder);

            const dialog = new Gtk.FileDialog(dialogArgs);
            dialog.select_folder(window, null, (self, result) => {
                try {
                    const folder = self.select_folder_finish(result);
                    const path = folder.get_path();

                    if (!path)
                        return;

                    settings.set_string('wallpaper-folder', path);
                    folderRow.set_subtitle(path);
                } catch (e) {
                    const dismissed =
                        e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
                        e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

                    if (!dismissed)
                        logError(e, '[WallpaperSlideshow] Folder selection failed');
                }
            });
        });
        folderRow.add_suffix(chooseButton);
        sourceGroup.add(folderRow);
        page.add(sourceGroup);

        const playbackGroup = new Adw.PreferencesGroup({
            title: _('Playback'),
        });

        const intervalValues = this._intervalValues();
        const intervalModel = Gtk.StringList.new(
            intervalValues.map(value => formatInterval(_, value))
        );
        const intervalRow = new Adw.ComboRow({
            title: _('Change Interval'),
            subtitle: _('How often to switch wallpapers automatically'),
            model: intervalModel,
        });
        const currentInterval = settings.get_int('interval');
        const selectedInterval = intervalValues.indexOf(currentInterval);
        intervalRow.set_selected(selectedInterval >= 0 ? selectedInterval : 3);
        intervalRow.connect('notify::selected', () => {
            const value = intervalValues[intervalRow.get_selected()] ?? 300;
            settings.set_int('interval', value);
        });
        playbackGroup.add(intervalRow);

        const randomRow = new Adw.SwitchRow({
            title: _('Random Order'),
            subtitle: _('Shuffle wallpapers instead of using a fixed sequence'),
        });
        settings.bind(
            'random-order',
            randomRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        playbackGroup.add(randomRow);

        const pauseRow = new Adw.SwitchRow({
            title: _('Pause Slideshow'),
            subtitle: _('Stop automatic wallpaper changes until resumed'),
        });
        settings.bind(
            'paused',
            pauseRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        playbackGroup.add(pauseRow);

        page.add(playbackGroup);
        return page;
    }

    _buildTransitionPage(settings, _) {
        const transitions = getTransitions(_);
        const page = new Adw.PreferencesPage({
            title: _('Transition'),
            icon_name: 'view-refresh-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Animation'),
            description: _(
                'Configure the effect used when switching to the next wallpaper.'
            ),
        });

        const transitionModel = Gtk.StringList.new(
            transitions.map(item => item.label)
        );
        const transitionRow = new Adw.ComboRow({
            title: _('Transition Type'),
            subtitle: _('Select the visual effect between wallpapers'),
            model: transitionModel,
        });
        const transitionId = settings.get_string('transition-type');
        const transitionIndex = transitions.findIndex(t => t.id === transitionId);
        transitionRow.set_selected(transitionIndex >= 0 ? transitionIndex : 0);
        transitionRow.connect('notify::selected', () => {
            const item = transitions[transitionRow.get_selected()];
            settings.set_string('transition-type', item?.id ?? 'fade');
        });
        group.add(transitionRow);

        const durationRow = new Adw.ActionRow({
            title: _('Animation Duration'),
            subtitle: _('Set how long the transition should last'),
        });

        const durationBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        const durationScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 100,
                upper: 5000,
                step_increment: 100,
                page_increment: 500,
                value: settings.get_int('animation-duration'),
            }),
            draw_value: false,
            width_request: 220,
            hexpand: true,
        });
        const durationLabel = new Gtk.Label({
            label: _('%d ms').format(settings.get_int('animation-duration')),
            width_chars: 8,
            xalign: 1,
            css_classes: ['monospace'],
        });

        for (const value of [500, 1000, 2000, 3000, 5000])
            durationScale.add_mark(value, Gtk.PositionType.BOTTOM, null);

        durationScale.connect('value-changed', () => {
            const value = Math.round(durationScale.get_value());
            settings.set_int('animation-duration', value);
            durationLabel.set_label(_('%d ms').format(value));
        });

        durationBox.append(durationScale);
        durationBox.append(durationLabel);
        durationRow.add_suffix(durationBox);
        group.add(durationRow);

        const resetRow = new Adw.ActionRow({
            title: _('Reset Transition Settings'),
            subtitle: _('Restore the default transition type and duration'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('transition-type');
            settings.reset('animation-duration');

            const defaultTransition = settings.get_string('transition-type');
            const defaultIndex = transitions.findIndex(
                item => item.id === defaultTransition
            );
            transitionRow.set_selected(defaultIndex >= 0 ? defaultIndex : 0);

            const defaultDuration = settings.get_int('animation-duration');
            durationScale.set_value(defaultDuration);
            durationLabel.set_label(_('%d ms').format(defaultDuration));
        });
        resetRow.add_suffix(resetButton);
        group.add(resetRow);

        page.add(group);
        return page;
    }

    _buildAboutPage(_) {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const detailsGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper Slideshow'),
        });
        detailsGroup.add(new Adw.ActionRow({
            title: _('Version'),
            subtitle: String(this.metadata.version ?? 1),
        }));
        detailsGroup.add(new Adw.ActionRow({
            title: _('Compatible with'),
            subtitle: _('GNOME Shell 45 to 49.5'),
        }));
        detailsGroup.add(new Adw.ActionRow({
            title: _('Author'),
            subtitle: 'neonninja09',
        }));

        const tipsGroup = new Adw.PreferencesGroup({
            title: _('Tips'),
        });
        for (const [title, subtitle] of [
            [_('Panel menu'), _('Use the top-bar menu to skip, pause, or resume immediately.')],
            [_('Supported formats'), _('JPG, JPEG, PNG, WEBP, BMP, and GIF files are detected.')],
            [_('Random mode'), _('Use "Random Each Time" if you do not want a fixed order.')],
        ]) {
            tipsGroup.add(new Adw.ActionRow({title, subtitle}));
        }

        page.add(detailsGroup);
        page.add(tipsGroup);
        return page;
    }

    _intervalValues() {
        return [
            10,
            30,
            60,
            5 * 60,
            10 * 60,
            15 * 60,
            30 * 60,
            60 * 60,
        ];
    }
}
