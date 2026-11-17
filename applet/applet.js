/*
 * Clipboard Manager applet for Cinnamon.
 *
 * A port of the GNOME Shell "Clipboard Indicator" extension by Tudmotu.
 * Clipboard reads go through Meta.Selection (Cinnamon's St.Clipboard can only
 * read plain text), writes go through St.Clipboard.
 */

const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Cogl = imports.gi.Cogl;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const St = imports.gi.St;

const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;

const Gettext = imports.gettext;

const UUID = 'clipboard-manager@ravetcofx';

/*
 * Local modules come from the xlet's own importer when the running Cinnamon
 * provides one (6.8+); Cinnamon clears that importer's cache on reload.
 * Released Cinnamon (6.0 - 6.6) has no such API, so fall back to the
 * searchPath convention used by stock xlets there.
 */
let Me = null;
try {
    Me = imports.ui.extension.getCurrentExtension();
} catch (e) {
    Me = null;
}

let Registry, Crypto;
if (Me && Me.imports) {
    Registry = Me.imports.registry;
    Crypto = Me.imports.crypto;
} else {
    imports.searchPath.push(imports.ui.appletManager.appletMeta[UUID].path);
    Registry = imports.registry;
    Crypto = imports.crypto;
}

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _ (str) {
    const translated = Gettext.dgettext(UUID, str);
    return translated !== str ? translated : Gettext.gettext(str);
}

const ICON_NAME = 'edit-paste-symbolic';

/* Ordered by preference: the first type the clipboard offers is the one used. */
const READ_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/svg+xml'
];

const PASTE_COMBOS = {
    'ctrl-v':       [Clutter.KEY_Control_L, Clutter.KEY_v],
    'shift-insert': [Clutter.KEY_Shift_L, Clutter.KEY_Insert],
    'ctrl-shift-v': [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_V]
};

const DISPLAY_ICON_ONLY = 0;
const DISPLAY_TEXT_ONLY = 1;
const DISPLAY_ICON_AND_TEXT = 2;

const IMAGE_PREVIEW_HEIGHT = 28;

const MODE_NONE = 'none';
const MODE_SESSION = 'session';
const MODE_PASSWORD = 'password';

function truncate (text, length) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const chars = [...collapsed];
    if (chars.length <= length)
        return collapsed;
    return chars.slice(0, length - 1).join('') + '…';
}

/*
 * One row in the history or pinned section.  Everything lives inside a single
 * box so the row lays out like a normal horizontal container rather than
 * Cinnamon's column-based menu item layout.
 */
class ClipboardMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init (applet, entry) {
        super._init({ hover: true, focusOnHover: false });

        this.applet = applet;
        this.entry = entry;
        this.currentlySelected = false;

        this.box = new St.BoxLayout({
            style_class: 'clipboard-item-box',
            vertical: false,
            x_expand: true
        });

        this._selectedIcon = new St.Icon({
            icon_name: 'object-select-symbolic',
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 12,
            style_class: 'clipboard-item-selected-icon',
            opacity: 0
        });
        this.box.add(this._selectedIcon, { y_align: St.Align.MIDDLE, y_fill: false });

        this.previewBin = new St.Bin({ style_class: 'clipboard-item-preview' });
        this.box.add(this.previewBin, { y_align: St.Align.MIDDLE, y_fill: false });

        this.label = new St.Label({ text: '', style_class: 'clipboard-item-label' });
        this.box.add(this.label, { expand: true, x_fill: true, y_align: St.Align.MIDDLE, y_fill: false });

        this.tagLabel = new St.Label({ text: '', style_class: 'clipboard-item-tag' });
        this.tagLabel.visible = false;
        this.box.add(this.tagLabel, { y_align: St.Align.MIDDLE, y_fill: false });

        this.buttonBox = new St.BoxLayout({ style_class: 'clipboard-item-buttons', vertical: false });
        this.box.add(this.buttonBox, { y_align: St.Align.MIDDLE, y_fill: false });

        this.pinButton = this._addButton('view-pin-symbolic', _("Pin"),
                                         () => this.applet.toggleFavorite(this));
        this.pasteButton = this._addButton('edit-paste-symbolic', _("Paste"),
                                           () => this.applet.pasteItem(this));
        this.editButton = this._addButton('document-edit-symbolic', _("Edit"),
                                          () => this.applet.editItem(this));
        this.tagButton = this._addButton('user-bookmarks-symbolic', _("Tag"),
                                         () => this.applet.tagItem(this));
        this.deleteButton = this._addButton('edit-delete-symbolic', _("Delete"),
                                            () => this.applet.deleteItem(this));

        this.addActor(this.box, { span: -1, expand: true });

        this._signals.connect(this.actor, 'key-press-event', this._onKeyPress.bind(this));

        this.refresh();
    }

    _addButton (iconName, tooltip, callback) {
        const button = new St.Button({
            style_class: 'clipboard-item-button',
            can_focus: true,
            child: new St.Icon({
                icon_name: iconName,
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 14
            })
        });
        button.set_accessible_name(tooltip);
        this._signals.connect(button, 'clicked', callback);
        this.buttonBox.add(button);
        return button;
    }

    /* Rebuilds the label, preview and button visibility from current settings. */
    refresh () {
        const applet = this.applet;

        if (this.entry.isText()) {
            this.label.set_text(truncate(this.entry.getStringValue(), applet.previewSize));
            this.previewBin.visible = false;
            this.editButton.visible = applet.showEditButton;
        }
        else {
            this.label.set_text('');
            this.previewBin.visible = true;
            this.editButton.visible = false;
            if (applet.isPopupOpen())
                this.ensurePreview();
        }

        const tag = this.entry.getTag();
        this.tagLabel.set_text(tag || '');
        this.tagLabel.visible = !!tag;

        this.pinButton.visible = applet.showPinButton;
        this.pasteButton.visible = applet.showPasteButton;
        this.tagButton.visible = applet.showTagButton;
        this.deleteButton.visible = applet.showDeleteButton;

        this.pinButton.change_style_pseudo_class('active', this.entry.isFavorite());
    }

    /*
     * Decodes the image in memory, so decrypted pixels never touch the disk.
     * Called lazily when the menu opens rather than for every stored entry.
     */
    ensurePreview () {
        if (this._previewLoaded || !this.entry.isImage())
            return;
        this._previewLoaded = true;

        try {
            const data = this.applet.registry.loadImage(this.entry);
            if (!data)
                throw new Error('image unavailable');

            const loader = new GdkPixbuf.PixbufLoader();
            loader.write(data);
            loader.close();

            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            let pixbuf = loader.get_pixbuf();
            const height = IMAGE_PREVIEW_HEIGHT * scale;
            const width = Math.max(1, Math.round(pixbuf.get_width() * height / pixbuf.get_height()));
            pixbuf = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);

            const content = St.ImageContent.new_with_preferred_size(width / scale, height / scale);
            content.set_data(pixbuf.get_pixels(),
                             pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                             width, height, pixbuf.get_rowstride());

            this.previewBin.set_child(new St.Widget({
                content: content,
                width: width / scale,
                height: height / scale
            }));
        }
        catch (e) {
            this.label.set_text(_("[Image]"));
            this.previewBin.visible = false;
        }
    }

    setSelected (selected) {
        this.currentlySelected = selected;
        this._selectedIcon.opacity = selected ? 255 : 0;
    }

    _onKeyPress (actor, event) {
        switch (event.get_key_symbol()) {
            case Clutter.KEY_Delete:
                this.applet.selectNeighbourOf(this);
                this.applet.deleteItem(this);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_p:
                this.applet.toggleFavorite(this);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_v:
                this.applet.pasteItem(this);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_e:
                if (this.entry.isText()) {
                    this.applet.editItem(this);
                    return Clutter.EVENT_STOP;
                }
                break;
            case Clutter.KEY_t:
                this.applet.tagItem(this);
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

class ClipboardApplet extends Applet.TextIconApplet {
    _init (metadata, orientation, panelHeight, instanceId) {
        super._init(orientation, panelHeight, instanceId);

        /* Works on side panels too; the label is dropped there. */
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_show_label_in_vertical_panels(false);

        this.metadata = metadata;
        this.orientation = orientation;
        this.instance_id = instanceId;

        this._timeouts = new Set();
        this._items = [];
        this._refreshInProgress = false;
        this._suppressCapture = false;
        this._destroyed = false;

        this._locked = false;
        this._needsNewPassword = false;

        this._bindSettings();

        this._activeDir = this._resolveStorageDir();
        this._activeMode = this.encryptionMode;
        this.registry = new Registry.Registry(UUID, this._activeDir, Crypto);
        this.registry.encryptImages = this.encryptImages;

        this.set_applet_icon_symbolic_name(ICON_NAME);
        this.set_applet_tooltip(_("Clipboard history"));

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.actor.add_style_class_name('clipboard-menu');

        this._buildMenu();
        this._loadHistory();
        this._updatePanel();
        this._updateKeybindings();
        this._startMonitoring();
    }

    /* ------------------------------------------------------------------ */
    /* Settings                                                            */
    /* ------------------------------------------------------------------ */

    _bindSettings () {
        this.settings = new Settings.AppletSettings(this, UUID, this.instance_id);

        const simple = [
            'history-size', 'historySize',
            'preview-size', 'previewSize',
            'topbar-preview-size', 'topbarPreviewSize',
            'display-mode', 'displayMode',
            'move-item-first', 'moveItemFirst',
            'strip-text', 'stripText',
            'paste-on-select', 'pasteOnSelect',
            'paste-keys', 'pasteKeys',
            'keep-selected-on-clear', 'keepSelectedOnClear',
            'confirm-clear', 'confirmClear',
            'confirm-pinned-delete', 'confirmPinnedDelete',
            'cache-images', 'cacheImages',
            'cache-only-favorites', 'cacheOnlyFavorites',
            'clear-on-boot', 'clearOnBoot',
            'excluded-apps', 'excludedAppsRaw',
            'show-search-bar', 'showSearchBar',
            'case-sensitive-search', 'caseSensitiveSearch',
            'pinned-on-bottom', 'pinnedOnBottom',
            'show-private-mode', 'showPrivateModeToggle',
            'show-clear-history-button', 'showClearButton',
            'show-settings-button', 'showSettingsButton',
            'show-pin-button', 'showPinButton',
            'show-paste-button', 'showPasteButton',
            'show-edit-button', 'showEditButton',
            'show-tag-button', 'showTagButton',
            'show-delete-button', 'showDeleteButton',
            'notify-on-copy', 'notifyOnCopy',
            'notify-on-cycle', 'notifyOnCycle',
            'notify-on-clear', 'notifyOnClear',
            'popup-location', 'popupLocation'
        ];

        for (let i = 0; i < simple.length; i += 2)
            this.settings.bind(simple[i], simple[i + 1], this._onSettingsChanged.bind(this));

        this.settings.bind('private-mode', 'privateMode', this._onPrivateModeChanged.bind(this));
        this.settings.bind('storage-dir', 'storageDir', this._onStorageDirChanged.bind(this));
        this.settings.bind('encryption-mode', 'encryptionMode', this._onEncryptionModeChanged.bind(this));
        this.settings.bind('encrypt-images', 'encryptImages', this._onEncryptImagesChanged.bind(this));

        for (const key of ['toggle-menu-key', 'next-entry-key', 'prev-entry-key',
                           'clear-history-key', 'private-mode-key']) {
            const prop = key.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
            this.settings.bind(key, prop, this._updateKeybindings.bind(this));
        }
    }

    get excludedApps () {
        return (this.excludedAppsRaw || '')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 0);
    }

    _onSettingsChanged () {
        if (this._destroyed)
            return;

        this._trimHistory();
        this._items.forEach(item => item.refresh());
        this._layoutSections();
        this._updatePanel();
        this._saveHistory();
    }

    _onPrivateModeChanged () {
        if (this._destroyed)
            return;

        if (this.privateModeItem)
            this.privateModeItem.setToggleState(this.privateMode);

        this.actor.change_style_pseudo_class('private-mode', this.privateMode);
        this._updatePanel();

        if (!this.privateMode) {
            /* Re-sync with whatever the clipboard holds now. */
            this._queueRefresh();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Menu construction                                                   */
    /* ------------------------------------------------------------------ */

    _buildMenu () {
        this.searchEntryItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
            focusOnHover: false
        });

        this.searchEntry = new St.Entry({
            name: 'clipboardSearchEntry',
            style_class: 'clipboard-search-entry',
            hint_text: _("Search history…"),
            can_focus: true,
            track_hover: true,
            x_expand: true
        });
        this.searchEntry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 14
        }));
        this.searchEntry.clutter_text.connect('text-changed', this._onSearchChanged.bind(this));
        this.searchEntry.clutter_text.connect('key-press-event', this._onSearchKeyPress.bind(this));
        this.searchEntryItem.addActor(this.searchEntry, { span: -1, expand: true });

        this.favoritesSection = new PopupMenu.PopupMenuSection();
        this.favoritesScroll = new St.ScrollView({ style_class: 'clipboard-scrollview vfade' });
        this.favoritesScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.favoritesScroll.add_actor(this.favoritesSection.actor);

        this.historySection = new PopupMenu.PopupMenuSection();
        this.historyScroll = new St.ScrollView({ style_class: 'clipboard-scrollview vfade' });
        this.historyScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.historyScroll.add_actor(this.historySection.actor);

        /* Separators are created once and re-parented, never rebuilt. */
        this.sectionSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.footerSeparator = new PopupMenu.PopupSeparatorMenuItem();

        this.emptyLabel = new St.Label({
            text: _("Clipboard history is empty"),
            style_class: 'clipboard-empty-label'
        });
        this.emptyItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        this.emptyItem.addActor(this.emptyLabel, { span: -1, expand: true });

        this.privateModeItem = new PopupMenu.PopupSwitchIconMenuItem(
            _("Private mode"), this.privateMode, 'security-medium-symbolic', St.IconType.SYMBOLIC);
        this.privateModeItem.connect('toggled', (item, state) => {
            this.privateMode = state;
        });

        this.clearItem = new PopupMenu.PopupIconMenuItem(
            _("Clear history"), 'user-trash-symbolic', St.IconType.SYMBOLIC);
        this.clearItem.connect('activate', () => {
            this._closePopups();
            this.clearHistory();
        });

        this.unlockItem = new PopupMenu.PopupIconMenuItem(
            _("Unlock saved history…"), 'changes-prevent-symbolic', St.IconType.SYMBOLIC);
        this.unlockItem.connect('activate', () => {
            this._closePopups();
            this.promptUnlock();
        });

        this.settingsItem = new PopupMenu.PopupIconMenuItem(
            _("Settings"), 'preferences-system-symbolic', St.IconType.SYMBOLIC);
        this.settingsItem.connect('activate', () => {
            this._closePopups();
            Util.spawn(['xlet-settings', 'applet', UUID, '-i', String(this.instance_id)]);
        });

        this.menu.connect('open-state-changed', this._onMenuOpenStateChanged.bind(this));

        this._layoutSections();
    }

    /*
     * Re-parents the menu's top level pieces into the order the current
     * settings ask for.  Only the long-lived actors created in _buildMenu are
     * ever added here, so nothing leaks across relayouts.
     */
    _layoutSections () {
        const box = this.menu.box;

        for (const child of box.get_children())
            box.remove_actor(child);

        const favouritesCount = this.favoritesSection._getMenuItems().length;
        const historyCount = this.historySection._getMenuItems().length;
        const hasItems = favouritesCount + historyCount > 0;

        if (this._locked) {
            this.unlockItem.label.set_text(this._needsNewPassword
                ? _("Set a password to save history…")
                : _("Unlock saved history…"));
            box.add_actor(this.unlockItem.actor);
        }

        if (this.showSearchBar && !this.privateMode && hasItems)
            box.add_actor(this.searchEntryItem.actor);

        if (this.privateMode || !hasItems) {
            this.emptyLabel.set_text(this.privateMode
                ? _("Private mode is on")
                : _("Clipboard history is empty"));
            box.add_actor(this.emptyItem.actor);
        }
        else {
            const order = this.pinnedOnBottom
                ? [[this.historyScroll, historyCount], [this.favoritesScroll, favouritesCount]]
                : [[this.favoritesScroll, favouritesCount], [this.historyScroll, historyCount]];

            let added = 0;
            for (const [scroll, count] of order) {
                if (count === 0) {
                    scroll.visible = false;
                    continue;
                }
                if (added > 0)
                    box.add_actor(this.sectionSeparator.actor);
                scroll.visible = true;
                box.add_actor(scroll);
                added++;
            }
        }

        const footer = [];
        if (this.showPrivateModeToggle)
            footer.push(this.privateModeItem.actor);
        if (this.showClearButton && !this.privateMode && hasItems)
            footer.push(this.clearItem.actor);
        if (this.showSettingsButton)
            footer.push(this.settingsItem.actor);

        if (footer.length > 0) {
            box.add_actor(this.footerSeparator.actor);
            for (const actor of footer)
                box.add_actor(actor);
        }
    }

    _onMenuOpenStateChanged (menu, open) {
        if (open)
            this._onPopupOpened();
    }

    _onPopupOpened () {
        this.searchEntry.set_text('');
        this._onSearchChanged();
        this._items.forEach(item => item.ensurePreview());

        this._addTimeout(50, () => {
            if (!this.isPopupOpen())
                return;

            /*
             * Focus must land on something actually shown.  Focusing the
             * search box while it is not in the menu (empty history) drops
             * the grab and closes the menu straight away.
             */
            const candidates = [this.searchEntry]
                .concat(this._visibleItems().map(item => item.actor))
                .concat([this.unlockItem.actor, this.privateModeItem.actor,
                         this.clearItem.actor, this.settingsItem.actor]);

            const target = candidates.find(actor => actor.mapped);
            if (target)
                global.stage.set_key_focus(target);
        });
    }

    isPopupOpen () {
        return (this.menu && this.menu.isOpen) || !!this._floating;
    }

    _closePopups () {
        if (this.menu.isOpen)
            this.menu.close();
        this._hideFloating();
    }

    /* ------------------------------------------------------------------ */
    /* Floating window                                                     */
    /* ------------------------------------------------------------------ */

    /*
     * Shows the menu's contents in a draggable box under the pointer.  The
     * menu box itself is borrowed and handed back on close, so every item and
     * handler behaves exactly as it does in the panel menu.
     */
    _showFloating () {
        if (this._floating)
            return;
        if (this.menu.isOpen)
            this.menu.close(false);

        const container = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style_class: 'menu popup-menu-content clipboard-floating'
        });

        const header = new St.BoxLayout({
            reactive: true,
            track_hover: true,
            style_class: 'clipboard-floating-header'
        });
        header.add(new St.Icon({
            icon_name: ICON_NAME,
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 16
        }), { y_align: St.Align.MIDDLE, y_fill: false });
        header.add(new St.Label({
            text: _("Clipboard history"),
            style_class: 'clipboard-floating-title'
        }), { expand: true, y_align: St.Align.MIDDLE, y_fill: false });

        const closeButton = new St.Button({
            style_class: 'clipboard-item-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 14
            })
        });
        closeButton.connect('clicked', () => this._hideFloating());
        header.add(closeButton, { y_align: St.Align.MIDDLE, y_fill: false });

        container.add_actor(header);

        this._menuBoxParent = this.menu.box.get_parent();
        this._menuBoxParent.remove_actor(this.menu.box);
        container.add_actor(this.menu.box);

        Main.uiGroup.add_actor(container);

        const floating = { container: container, header: header, stageEventId: 0, drag: null };
        this._floating = floating;

        this._placeUnderPointer(container);

        if (!Main.pushModal(container)) {
            this._hideFloating();
            return;
        }
        floating.modal = true;

        header.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            floating.drag = { dx: x - container.x, dy: y - container.y };
            return Clutter.EVENT_STOP;
        });

        /*
         * The stage sees every event while we hold the modal grab, which is
         * what lets a drag continue outside the header and lets a click
         * outside the window dismiss it.
         */
        floating.stageEventId = global.stage.connect('captured-event', (stage, event) => {
            const type = event.type();

            if (floating.drag) {
                if (type === Clutter.EventType.MOTION) {
                    const [x, y] = event.get_coords();
                    container.set_position(Math.round(x - floating.drag.dx),
                                           Math.round(y - floating.drag.dy));
                    return Clutter.EVENT_STOP;
                }
                if (type === Clutter.EventType.BUTTON_RELEASE) {
                    floating.drag = null;
                    return Clutter.EVENT_STOP;
                }
            }

            if (type === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = event.get_coords();
                const [cx, cy] = container.get_transformed_position();
                const [cw, ch] = container.get_transformed_size();
                const inside = x >= cx && x < cx + cw && y >= cy && y < cy + ch;
                /* Dialogs opened from the window sit outside it; leave those alone. */
                if (!inside && Main.modalCount <= 1) {
                    this._hideFloating();
                    return Clutter.EVENT_STOP;
                }
            }

            if (type === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape &&
                Main.modalCount <= 1) {
                this._hideFloating();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this._onPopupOpened();
    }

    _placeUnderPointer (actor) {
        const [px, py] = global.get_pointer();
        const monitor = Main.layoutManager.monitors.find(m =>
            px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height) ||
            Main.layoutManager.primaryMonitor;

        const [, width] = actor.get_preferred_width(-1);
        const [, height] = actor.get_preferred_height(width);
        const margin = 8;

        let x = px - Math.round(width / 2);
        let y = py + 16;
        /* Not enough room below: open above the pointer instead. */
        if (y + height > monitor.y + monitor.height - margin)
            y = py - height - 16;

        x = Math.max(monitor.x + margin, Math.min(x, monitor.x + monitor.width - width - margin));
        y = Math.max(monitor.y + margin, Math.min(y, monitor.y + monitor.height - height - margin));
        actor.set_position(x, y);
    }

    _hideFloating () {
        const floating = this._floating;
        if (!floating)
            return;
        this._floating = null;

        if (floating.stageEventId)
            global.stage.disconnect(floating.stageEventId);
        if (floating.modal)
            Main.popModal(floating.container);

        floating.container.remove_actor(this.menu.box);
        if (this._menuBoxParent)
            this._menuBoxParent.add_actor(this.menu.box);
        this._menuBoxParent = null;

        floating.container.destroy();
    }

    /* ------------------------------------------------------------------ */
    /* Search                                                              */
    /* ------------------------------------------------------------------ */

    _onSearchChanged () {
        let needle = this.searchEntry.get_text();
        if (!this.caseSensitiveSearch)
            needle = needle.toLowerCase();

        for (const item of this._items) {
            if (needle === '') {
                item.actor.visible = true;
                continue;
            }

            let haystack = item.entry.getStringValue() + ' ' + (item.entry.getTag() || '');
            if (!this.caseSensitiveSearch)
                haystack = haystack.toLowerCase();

            item.actor.visible = haystack.indexOf(needle) !== -1;
        }
    }

    _onSearchKeyPress (actor, event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Tab) {
            const first = this._visibleItems()[0];
            if (first) {
                first.actor.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
        }
        else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            const first = this._visibleItems()[0];
            if (first) {
                this.activateItem(first);
                return Clutter.EVENT_STOP;
            }
        }
        else if (symbol === Clutter.KEY_Escape) {
            this._closePopups();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /* Items in the order they appear on screen, newest first per section. */
    _visibleItems () {
        const favourites = this.favoritesSection._getMenuItems();
        const history = this.historySection._getMenuItems();
        const ordered = this.pinnedOnBottom
            ? history.concat(favourites)
            : favourites.concat(history);

        return ordered.filter(item => item.actor.visible);
    }

    /* ------------------------------------------------------------------ */
    /* History                                                             */
    /* ------------------------------------------------------------------ */

    _loadHistory () {
        const registry = this.registry;

        if (this.clearOnBoot)
            registry.clear();

        let entries = [];

        switch (this._activeMode) {
            case MODE_SESSION:
                /* Last session's key is gone, so its data is unreadable. */
                if (registry.hasEncryptedRegistry())
                    registry.clear();
                else
                    entries = registry.read().entries;
                registry.setKey(Crypto.Key.random());
                break;

            case MODE_PASSWORD:
                this._locked = true;
                this._needsNewPassword = !registry.hasEncryptedRegistry();
                if (registry.hasPlainRegistry())
                    entries = registry.read().entries;
                break;

            default:
                if (registry.hasEncryptedRegistry())
                    this._locked = true;
                else
                    entries = registry.read().entries;
        }

        for (const entry of entries)
            this._addItem(entry, false);

        const last = this._items[this._items.length - 1];
        if (last)
            this._setSelected(last);

        /* Plain history found in session mode: re-save it encrypted. */
        if (this._activeMode === MODE_SESSION && entries.length > 0)
            this._migrateTo(this._activeDir, registry.key);

        this._layoutSections();
    }

    /* Entries that belong on disk under the current settings. */
    _persistedEntries () {
        return this._items
            .map(item => item.entry)
            .filter(entry => !this.cacheOnlyFavorites || entry.isFavorite());
    }

    _saveHistory () {
        /* Never write while locked: it would overwrite the stored history. */
        if (this._locked)
            return;

        this.registry.write(this._persistedEntries());
    }

    /*
     * Moves all history to a directory and key.  Returns true on success;
     * on failure the old registry stays active and the user is told why.
     */
    _migrateTo (dir, key) {
        try {
            GLib.mkdir_with_parents(dir, 0o700);
            this.registry = this.registry.migrate(this._items.map(item => item.entry), dir, key);
            this._activeDir = dir;
            this._saveHistory();
            return true;
        }
        catch (e) {
            global.logError('[' + UUID + '] migration failed: ' + e);
            Main.notify(_("Clipboard Manager"), _("Could not update stored history: ") + e.message);
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Storage location and encryption                                     */
    /* ------------------------------------------------------------------ */

    _resolveStorageDir () {
        let value = (this.storageDir || '').trim();

        if (value === '') {
            value = Registry.Registry.defaultDir(UUID);
            /* Written back so the settings page shows where history lives. */
            this._activeDir = value;
            this.storageDir = Gio.File.new_for_path(value).get_uri();
            return value;
        }

        if (value.startsWith('file://'))
            return Gio.File.new_for_uri(value).get_path();
        if (value === '~' || value.startsWith('~/'))
            return GLib.get_home_dir() + value.slice(1);
        return value;
    }

    _onStorageDirChanged () {
        if (this._destroyed || !this.registry)
            return;

        const dir = this._resolveStorageDir();
        if (GLib.canonicalize_filename(dir, null) === GLib.canonicalize_filename(this._activeDir, null))
            return;

        const revert = message => {
            Main.notify(_("Clipboard Manager"), message);
            this.storageDir = Gio.File.new_for_path(this._activeDir).get_uri();
        };

        if (this._locked) {
            revert(_("Unlock the saved history before moving it."));
            return;
        }

        const target = new Registry.Registry(UUID, dir, Crypto);
        if (target.hasPlainRegistry() || target.hasEncryptedRegistry()) {
            revert(_("That folder already holds clipboard history. Choose an empty folder."));
            return;
        }

        if (this._migrateTo(dir, this.registry.key))
            Main.notify(_("Clipboard Manager"), _("History moved to ") + dir);
        else
            this.storageDir = Gio.File.new_for_path(this._activeDir).get_uri();
    }

    _onEncryptionModeChanged () {
        if (this._destroyed || !this.registry || this._revertingMode)
            return;

        const mode = this.encryptionMode;
        const previous = this._activeMode;
        if (mode === previous)
            return;

        const revert = () => {
            this._revertingMode = true;
            this.encryptionMode = previous;
            this._revertingMode = false;
        };

        const commit = () => {
            this._activeMode = mode;
            this._layoutSections();
            this._updatePanel();
        };

        if (this._locked) {
            if (mode === MODE_SESSION) {
                this._confirm(
                    _("Saved history is locked and will be discarded if you switch to a per-session key. Continue?"),
                    () => {
                        this.registry.clear();
                        this.registry.setKey(Crypto.Key.random());
                        this._locked = false;
                        this._needsNewPassword = false;
                        this._saveHistory();
                        commit();
                    },
                    revert);
                return;
            }
            /* Stays locked; unlocking migrates to the chosen mode. */
            if (mode === MODE_NONE && this._needsNewPassword) {
                this._locked = false;
                this._needsNewPassword = false;
                this.registry.setKey(null);
                this._saveHistory();
            }
            commit();
            return;
        }

        switch (mode) {
            case MODE_NONE:
                if (this._migrateTo(this._activeDir, null))
                    commit();
                else
                    revert();
                break;

            case MODE_SESSION:
                if (this._migrateTo(this._activeDir, Crypto.Key.random()))
                    commit();
                else
                    revert();
                break;

            case MODE_PASSWORD:
                this._openPasswordDialog({
                    title: _("Set a password for clipboard history"),
                    confirm: true,
                    onSubmit: password => {
                        if (!this._migrateTo(this._activeDir, Crypto.Key.fromPassword(password)))
                            return _("Could not encrypt the stored history.");
                        commit();
                        return null;
                    },
                    onCancel: revert
                });
                break;
        }
    }

    _confirm (message, onYes, onNo) {
        const dialog = new ModalDialog.ModalDialog();
        const label = new St.Label({ text: message, style_class: 'clipboard-dialog-message' });
        label.clutter_text.line_wrap = true;
        dialog.contentLayout.add_actor(label);
        dialog.setButtons([
            { label: _("Cancel"), key: Clutter.KEY_Escape, action: () => { dialog.destroy(); onNo(); } },
            { label: _("Continue"), default: true, action: () => { dialog.destroy(); onYes(); } }
        ]);
        dialog.open();
    }

    _onEncryptImagesChanged () {
        if (this._destroyed || !this.registry || this.registry.encryptImages === this.encryptImages)
            return;

        if (this._locked) {
            Main.notify(_("Clipboard Manager"), _("Unlock the saved history before changing image encryption."));
            this.encryptImages = this.registry.encryptImages;
            return;
        }

        const previous = this.registry.encryptImages;
        this.registry.encryptImages = this.encryptImages;
        if (!this._migrateTo(this._activeDir, this.registry.key)) {
            this.registry.encryptImages = previous;
            this.encryptImages = previous;
        }
    }

    /* Settings button: open the storage folder in the file manager. */
    on_open_storage_dir () {
        try {
            GLib.mkdir_with_parents(this._activeDir, 0o700);
            /* A separate process, so a slow file manager cannot stall the shell. */
            Util.spawn(['xdg-open', Gio.File.new_for_path(this._activeDir).get_uri()]);
        }
        catch (e) {
            Main.notify(_("Clipboard Manager"), e.message);
        }
    }

    /* Settings button: re-encrypt everything under a new password. */
    on_change_password () {
        if (this._activeMode !== MODE_PASSWORD) {
            Main.notify(_("Clipboard Manager"), _("Set encryption to \"Password\" first."));
            return;
        }
        if (this._locked) {
            this.promptUnlock();
            return;
        }

        this._openPasswordDialog({
            title: _("Choose a new password"),
            confirm: true,
            onSubmit: password => {
                if (!this._migrateTo(this._activeDir, Crypto.Key.fromPassword(password)))
                    return _("Could not re-encrypt the stored history.");
                Main.notify(_("Clipboard Manager"), _("Password changed"));
                return null;
            }
        });
    }

    promptUnlock () {
        if (!this._locked)
            return;

        if (this._needsNewPassword) {
            this._openPasswordDialog({
                title: _("Set a password for clipboard history"),
                confirm: true,
                onSubmit: password => {
                    if (!this._migrateTo(this._activeDir, Crypto.Key.fromPassword(password)))
                        return _("Could not encrypt the stored history.");
                    this._locked = false;
                    this._needsNewPassword = false;
                    this._layoutSections();
                    this._updatePanel();
                    return null;
                }
            });
            return;
        }

        this._openPasswordDialog({
            title: _("Unlock clipboard history"),
            confirm: false,
            onSubmit: password => this._unlock(password)
        });
    }

    /* Returns an error message, or null once unlocked. */
    _unlock (password) {
        const registry = this.registry;
        const key = Crypto.Key.fromPassword(password, registry.storedSalt());

        registry.setKey(key);
        const result = registry.read();
        if (result.status === Registry.ReadStatus.WRONG_KEY) {
            registry.setKey(null);
            return _("Wrong password");
        }

        /* Stored entries come first (older); things copied while locked follow. */
        const storedKeys = new Set(result.entries.map(e => e.getKey()));
        const selectedKey = (this._items.find(i => i.currentlySelected) || { entry: null }).entry;
        const pending = this._items.map(i => i.entry).filter(e => !storedKeys.has(e.getKey()));

        for (const item of this._items.slice())
            this._removeItem(item, false);

        this._locked = false;

        for (const entry of result.entries.concat(pending))
            this._addItem(entry, false);

        const keyToSelect = selectedKey ? selectedKey.getKey() : null;
        const toSelect = (keyToSelect && this._findItemByKey(keyToSelect)) ||
                         this._items[this._items.length - 1];
        if (toSelect)
            this._setSelected(toSelect);

        this._trimHistory();

        /* Mode may have changed while locked; land in the chosen one. */
        const targetKey = this._activeMode === MODE_PASSWORD ? key
            : this._activeMode === MODE_SESSION ? Crypto.Key.random() : null;
        this._migrateTo(this._activeDir, targetKey);

        this._layoutSections();
        this._updatePanel();
        return null;
    }

    /*
     * Password prompt.  onSubmit returns an error string to keep the dialog
     * open, or null to close it.
     */
    _openPasswordDialog (params) {
        const dialog = new ModalDialog.ModalDialog();
        let finished = false;

        dialog.contentLayout.add_actor(new St.Label({
            text: params.title,
            style_class: 'clipboard-dialog-title'
        }));

        const makeEntry = hint => {
            const entry = new St.Entry({
                hint_text: hint,
                can_focus: true,
                style_class: 'clipboard-dialog-entry',
                style: 'min-width: 320px;'
            });
            entry.clutter_text.set_password_char('\u25cf');
            dialog.contentLayout.add_actor(entry);
            return entry;
        };

        const first = makeEntry(_("Password"));
        const second = params.confirm ? makeEntry(_("Repeat password")) : null;

        const error = new St.Label({ text: '', style_class: 'clipboard-dialog-error' });
        error.visible = false;
        dialog.contentLayout.add_actor(error);

        const cancel = () => {
            if (finished)
                return;
            finished = true;
            dialog.destroy();
            if (params.onCancel)
                params.onCancel();
        };

        const submit = () => {
            const password = first.get_text();
            let message = null;

            if (password.length === 0)
                message = _("Enter a password");
            else if (second && second.get_text() !== password)
                message = _("The passwords do not match");
            else
                message = params.onSubmit(password);

            if (message) {
                error.set_text(message);
                error.visible = true;
                first.clutter_text.set_selection(0, -1);
                global.stage.set_key_focus(first);
                return;
            }

            finished = true;
            dialog.destroy();
        };

        first.clutter_text.connect('activate', () => {
            if (second)
                global.stage.set_key_focus(second);
            else
                submit();
        });
        if (second)
            second.clutter_text.connect('activate', submit);

        dialog.setButtons([
            { label: _("Cancel"), action: cancel, key: Clutter.KEY_Escape },
            { label: params.confirm ? _("Save") : _("Unlock"), action: submit, default: true }
        ]);

        dialog.open();
        this._addTimeout(50, () => global.stage.set_key_focus(first));
    }

    /* Items are stored oldest first; the menu shows newest first. */
    _addItem (entry, relayout = true) {
        const item = new ClipboardMenuItem(this, entry);

        item.connect('activate', () => this.activateItem(item));

        this._items.push(item);

        const section = entry.isFavorite() ? this.favoritesSection : this.historySection;
        section.addMenuItem(item, 0);

        if (relayout)
            this._layoutSections();

        return item;
    }

    _removeItem (item, clearClipboard = true) {
        const index = this._items.indexOf(item);
        if (index === -1)
            return;

        if (clearClipboard && item.currentlySelected)
            this._clearClipboard();

        this._items.splice(index, 1);
        item.destroy();
    }

    _trimHistory () {
        let unpinned = this._items.filter(item => !item.entry.isFavorite());

        while (unpinned.length > this.historySize) {
            this._removeItem(unpinned.shift(), false);
        }

        this._pruneImageCache();
    }

    /*
     * Drops cached image files nothing points at any more.  Done as a sweep
     * rather than per entry, because identical images share one file.
     */
    _pruneImageCache () {
        /* While locked the stored entries are unknown, so nothing is safe to delete. */
        if (this._locked)
            return;
        this.registry.pruneImageFiles(this._items.map(item => item.entry));
    }

    _findItemByKey (key) {
        return this._items.find(item => item.entry.getKey() === key);
    }

    /* ------------------------------------------------------------------ */
    /* Item actions                                                        */
    /* ------------------------------------------------------------------ */

    activateItem (item) {
        const entry = item.entry;

        this._setSelected(item);
        this._setClipboard(entry);

        /* This replaces the item, so nothing may touch it afterwards. */
        if (this.moveItemFirst && !entry.isFavorite())
            this._moveItemFirst(item);

        this._closePopups();

        if (this.pasteOnSelect)
            this._addTimeout(120, () => this._sendPasteKeystroke());
    }

    pasteItem (item) {
        this._setSelected(item);
        this._setClipboard(item.entry);
        this._closePopups();

        this._addTimeout(120, () => this._sendPasteKeystroke());
    }

    toggleFavorite (item) {
        item.entry.setFavorite(!item.entry.isFavorite());
        this._moveItemFirst(item);
        this._layoutSections();
        this._saveHistory();
    }

    deleteItem (item) {
        const remove = () => {
            this._removeItem(item);
            this._layoutSections();
            this._saveHistory();
            this._pruneImageCache();
        };

        if (item.entry.isFavorite() && this.confirmPinnedDelete) {
            this._closePopups();
            new ModalDialog.ConfirmDialog(
                _("Delete this pinned entry? This cannot be undone."), remove).open();
            return;
        }

        remove();
    }

    tagItem (item) {
        this._closePopups();
        this._openTextDialog(_("Tag"), item.entry.getTag() || '', false, text => {
            item.entry.setTag(text.trim() || null);
            item.refresh();
            this._saveHistory();
        });
    }

    editItem (item) {
        if (!item.entry.isText())
            return;

        this._closePopups();
        this._openTextDialog(_("Edit entry"), item.entry.getStringValue(), true, text => {
            item.entry.setText(text);
            item.refresh();
            this._saveHistory();
            if (item.currentlySelected)
                this._setClipboard(item.entry);
        });
    }

    /* Rebuilds an item at the top of its section, preserving selection. */
    _moveItemFirst (item) {
        const entry = item.entry;
        const wasSelected = item.currentlySelected;

        this._removeItem(item, false);
        const newItem = this._addItem(entry);

        if (wasSelected)
            this._setSelected(newItem);
    }

    _setSelected (item) {
        for (const other of this._items)
            other.setSelected(other === item);
    }

    selectNeighbourOf (item) {
        const visible = this._visibleItems();
        const index = visible.indexOf(item);
        const next = visible[index + 1] || visible[index - 1];
        if (next)
            next.actor.grab_key_focus();
    }

    clearHistory (automatic = false) {
        const doClear = () => {
            const keep = this.keepSelectedOnClear
                ? this._items.find(item => item.currentlySelected && !item.entry.isFavorite())
                : null;

            for (const item of this._items.slice()) {
                if (item.entry.isFavorite() || item === keep)
                    continue;
                this._removeItem(item, false);
            }

            this._layoutSections();
            this._saveHistory();
            this._pruneImageCache();

            if (this.notifyOnClear)
                Main.notify(_("Clipboard Manager"), _("Clipboard history cleared"));
        };

        if (this.confirmClear && !automatic) {
            this._closePopups();
            new ModalDialog.ConfirmDialog(
                _("Clear the clipboard history? Pinned entries are kept."), doClear).open();
            return;
        }

        doClear();
    }

    /* ------------------------------------------------------------------ */
    /* Dialogs                                                             */
    /* ------------------------------------------------------------------ */

    _openTextDialog (title, initialText, multiline, onSave) {
        const dialog = new ModalDialog.ModalDialog();

        const titleLabel = new St.Label({ text: title, style_class: 'clipboard-dialog-title' });
        dialog.contentLayout.add_actor(titleLabel);

        const entry = new St.Entry({
            text: initialText,
            can_focus: true,
            style_class: 'clipboard-dialog-entry',
            x_expand: true
        });
        entry.clutter_text.set_single_line_mode(!multiline);
        entry.clutter_text.set_activatable(!multiline);
        if (multiline) {
            entry.clutter_text.set_line_wrap(true);
            entry.style = 'min-width: 420px; min-height: 120px;';
        }
        else {
            entry.style = 'min-width: 320px;';
        }

        dialog.contentLayout.add_actor(entry);

        const save = () => {
            onSave(entry.get_text());
            dialog.destroy();
        };

        dialog.setButtons([
            { label: _("Cancel"), action: () => dialog.destroy(), key: Clutter.KEY_Escape },
            { label: _("Save"), action: save, default: true }
        ]);

        if (!multiline)
            entry.clutter_text.connect('activate', save);

        dialog.open();
        this._addTimeout(50, () => global.stage.set_key_focus(entry));
    }

    /* ------------------------------------------------------------------ */
    /* Clipboard plumbing                                                  */
    /* ------------------------------------------------------------------ */

    _startMonitoring () {
        try {
            this._selection = global.display.get_selection();
            this._selectionOwnerChangedId = this._selection.connect('owner-changed',
                (selection, selectionType) => {
                    if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD)
                        this._queueRefresh();
                });
        }
        catch (e) {
            global.logWarning('[' + UUID + '] Meta.Selection unavailable, polling instead: ' + e);
            this._selection = null;
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, 1, () => {
                this._queueRefresh();
                return GLib.SOURCE_CONTINUE;
            });
        }

        this._queueRefresh();
    }

    _queueRefresh () {
        if (this._refreshQueued)
            return;

        this._refreshQueued = true;
        this._addTimeout(80, () => {
            this._refreshQueued = false;
            this._captureClipboard();
        });
    }

    _captureClipboard () {
        if (this._destroyed || this.privateMode || this._suppressCapture || this._refreshInProgress)
            return;

        const focusWindow = global.display.focus_window;
        const wmClass = focusWindow ? focusWindow.get_wm_class() : null;
        if (wmClass && this.excludedApps.indexOf(wmClass.toLowerCase()) !== -1)
            return;

        this._refreshInProgress = true;

        this._readClipboard((mimetype, bytes) => {
            this._refreshInProgress = false;

            if (this._destroyed || !mimetype || !bytes || bytes.get_size() === 0)
                return;

            let entry;

            if (Registry.isTextMimetype(mimetype)) {
                let text = new TextDecoder().decode(bytes.get_data());
                if (this.stripText)
                    text = text.trim();
                if (text.length === 0)
                    return;
                entry = Registry.ClipboardEntry.fromText(text, mimetype);
            }
            else {
                if (!this.cacheImages)
                    return;
                const data = new Uint8Array(bytes.get_data());
                if (this._locked) {
                    /* Nowhere safe to write yet; hold it until unlocked. */
                    entry = Registry.ClipboardEntry.fromImageFile(mimetype,
                        GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes));
                    entry.memoryData = data;
                }
                else {
                    try {
                        entry = Registry.ClipboardEntry.fromImageFile(mimetype,
                                                                      this.registry.writeImage(data));
                    }
                    catch (e) {
                        global.logError('[' + UUID + '] could not cache image: ' + e);
                        return;
                    }
                }
            }

            const existing = this._findItemByKey(entry.getKey());
            if (existing) {
                this._setSelected(existing);
                if (this.moveItemFirst && !existing.entry.isFavorite())
                    this._moveItemFirst(existing);
                this._updatePanel();
                return;
            }

            const item = this._addItem(entry);
            this._setSelected(item);
            this._trimHistory();
            this._layoutSections();
            this._saveHistory();
            this._updatePanel();

            if (this.notifyOnCopy)
                Main.notify(_("Clipboard Manager"), truncate(entry.getStringValue(), 60));
        });
    }

    /*
     * Reads the clipboard, preferring text over images.  Calls back with
     * (mimetype, GLib.Bytes) or (null, null).
     */
    _readClipboard (callback) {
        if (!this._selection) {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
                if (!text) {
                    callback(null, null);
                    return;
                }
                callback('text/plain;charset=utf-8',
                         new GLib.Bytes(new TextEncoder().encode(text)));
            });
            return;
        }

        let available;
        try {
            available = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) || [];
        }
        catch (e) {
            callback(null, null);
            return;
        }

        const mimetype = READ_MIMETYPES.find(type => available.indexOf(type) !== -1);
        if (!mimetype) {
            callback(null, null);
            return;
        }

        const stream = Gio.MemoryOutputStream.new_resizable();

        this._selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD,
                                       mimetype, -1, stream, null, (selection, result) => {
            try {
                selection.transfer_finish(result);
                stream.close(null);
                /* UTF8_STRING is really UTF-8 text; normalise it. */
                const type = mimetype === 'UTF8_STRING' || mimetype === 'STRING'
                    ? 'text/plain;charset=utf-8'
                    : mimetype;
                callback(type, stream.steal_as_bytes());
            }
            catch (e) {
                callback(null, null);
            }
        });
    }

    _setClipboard (entry) {
        const clipboard = St.Clipboard.get_default();

        this._suppressCapture = true;
        this._addTimeout(300, () => { this._suppressCapture = false; });

        if (entry.isText()) {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.getStringValue());
        }
        else {
            const data = this.registry.loadImage(entry);
            const bytes = data ? new GLib.Bytes(data) : null;
            if (!bytes) {
                Main.notify(_("Clipboard Manager"), _("The cached image is no longer available"));
                return;
            }
            clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mimetype, bytes);
        }

        this._updatePanel();
    }

    _clearClipboard () {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
        this._updatePanel();
    }

    _sendPasteKeystroke () {
        if (!this._virtualKeyboard) {
            try {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._virtualKeyboard = seat.create_virtual_device(
                    Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            catch (e) {
                global.logWarning('[' + UUID + '] cannot synthesise a paste keystroke: ' + e);
                return;
            }
        }

        const keys = PASTE_COMBOS[this.pasteKeys] || PASTE_COMBOS['ctrl-v'];
        /* Virtual devices want monotonic microseconds, not event time. */
        const time = GLib.get_monotonic_time();

        for (const key of keys)
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);

        for (const key of keys.slice().reverse())
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    /* ------------------------------------------------------------------ */
    /* Panel button                                                        */
    /* ------------------------------------------------------------------ */

    _updatePanel () {
        const selected = this._items.find(item => item.currentlySelected);
        const showIcon = this.displayMode !== DISPLAY_TEXT_ONLY;
        const vertical = this.orientation === St.Side.LEFT || this.orientation === St.Side.RIGHT;
        const showText = this.displayMode !== DISPLAY_ICON_ONLY && !vertical;

        if (showIcon)
            this.set_applet_icon_symbolic_name(this._locked ? 'changes-prevent-symbolic' : ICON_NAME);
        else if (typeof this.hide_applet_icon === 'function')
            this.hide_applet_icon();

        if (!showText) {
            this.set_applet_label('');
            if (typeof this.hide_applet_label === 'function')
                this.hide_applet_label(true);
        }
        else {
            if (typeof this.hide_applet_label === 'function')
                this.hide_applet_label(false);

            let label = '…';
            if (this.privateMode)
                label = _("Private");
            else if (selected)
                label = truncate(selected.entry.getStringValue(), this.topbarPreviewSize);

            this.set_applet_label(label);
        }

        const tooltip = this.privateMode
            ? _("Clipboard history (private mode)")
            : (selected ? truncate(selected.entry.getStringValue(), 120) : _("Clipboard history"));
        this.set_applet_tooltip(tooltip);
    }

    /* ------------------------------------------------------------------ */
    /* Keybindings                                                         */
    /* ------------------------------------------------------------------ */

    _updateKeybindings () {
        const bindings = [
            ['toggle-menu-key', this.toggleMenuKey, () => this.toggleMenu()],
            ['next-entry-key', this.nextEntryKey, () => this.cycleEntry(1)],
            ['prev-entry-key', this.prevEntryKey, () => this.cycleEntry(-1)],
            ['clear-history-key', this.clearHistoryKey, () => this.clearHistory()],
            ['private-mode-key', this.privateModeKey, () => {
                this.privateMode = !this.privateMode;
            }]
        ];

        for (const [name, binding, callback] of bindings) {
            Main.keybindingManager.removeXletHotKey(this, name);
            if (binding)
                Main.keybindingManager.addXletHotKey(this, name, binding, callback);
        }
    }

    toggleMenu () {
        if (this.isPopupOpen()) {
            this._closePopups();
            return;
        }

        if (this.popupLocation === 'pointer')
            this._showFloating();
        else
            this.menu.open(true);
    }

    cycleEntry (direction) {
        if (this.privateMode || this._items.length === 0)
            return;

        const visible = this._visibleItems();
        if (visible.length === 0)
            return;

        let index = visible.findIndex(item => item.currentlySelected);
        if (index === -1)
            index = 0;
        else
            index = (index + direction + visible.length) % visible.length;

        const item = visible[index];
        this._setSelected(item);
        this._setClipboard(item.entry);

        if (this.notifyOnCycle) {
            Main.notify(_("Clipboard Manager"),
                        (index + 1) + ' / ' + visible.length + ': ' +
                        truncate(item.entry.getStringValue(), 60));
        }
    }

    /* ------------------------------------------------------------------ */
    /* Applet lifecycle                                                    */
    /* ------------------------------------------------------------------ */

    on_applet_clicked () {
        this._hideFloating();
        this.menu.toggle();
    }

    on_orientation_changed (orientation) {
        this.orientation = orientation;
        if (!this.menu)
            return;
        this.menu.setOrientation(orientation);
        this._updatePanel();
    }

    on_applet_removed_from_panel () {
        this._destroyed = true;

        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }

        if (this._selection && this._selectionOwnerChangedId) {
            this._selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = null;
        }

        for (const name of ['toggle-menu-key', 'next-entry-key', 'prev-entry-key',
                            'clear-history-key', 'private-mode-key'])
            Main.keybindingManager.removeXletHotKey(this, name);

        if (this._virtualKeyboard) {
            this._virtualKeyboard.run_dispose();
            this._virtualKeyboard = null;
        }

        this._hideFloating();
        this.settings.finalize();
    }

    _addTimeout (ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            if (!this._destroyed)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }
}

function main (metadata, orientation, panelHeight, instanceId) {
    return new ClipboardApplet(metadata, orientation, panelHeight, instanceId);
}
