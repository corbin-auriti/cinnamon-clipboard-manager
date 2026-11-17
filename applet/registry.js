/*
 * Persistent storage for clipboard history.
 *
 * Text entries live inline in the registry file.  Image entries are written
 * to individual files beside it and referenced by name, so their bytes are
 * only read when an entry is actually used.
 *
 * When a key is set, the registry and every image file are encrypted with it
 * (see crypto.js) and the registry is stored as registry.enc instead of
 * registry.json.
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const PLAIN_REGISTRY = 'registry.json';
const ENCRYPTED_REGISTRY = 'registry.enc';

var DEFAULT_MIMETYPE = 'text/plain;charset=utf-8';

function isTextMimetype (mimetype) {
    return mimetype.startsWith('text/') ||
        mimetype === 'STRING' ||
        mimetype === 'UTF8_STRING';
}

function readFile (path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error('could not read ' + path);
    return contents;
}

function writeFile (path, data) {
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(new GLib.Bytes(data), null);
    stream.close(null);
}

function deleteFile (path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    }
    catch (e) {
        /* Already gone. */
    }
}

/*
 * A single clipboard item.  Text items carry their contents; image items
 * carry the name of the cache file holding them.
 */
var ClipboardEntry = class ClipboardEntry {
    constructor (mimetype, params) {
        params = params || {};
        this.mimetype = mimetype || DEFAULT_MIMETYPE;
        this.text = params.text !== undefined ? params.text : null;
        this.filename = params.filename || null;
        this.favorite = !!params.favorite;
        this.tag = params.tag || null;
    }

    static fromText (text, mimetype) {
        return new ClipboardEntry(mimetype || DEFAULT_MIMETYPE, { text: text });
    }

    static fromImageFile (mimetype, filename) {
        return new ClipboardEntry(mimetype, { filename: filename });
    }

    static fromJSON (json) {
        const mimetype = json.mimetype || DEFAULT_MIMETYPE;
        const params = { favorite: json.favorite, tag: json.tag };

        if (isTextMimetype(mimetype))
            params.text = json.contents;
        else
            params.filename = GLib.path_get_basename(json.contents);

        return new ClipboardEntry(mimetype, params);
    }

    toJSON () {
        const json = {
            mimetype: this.mimetype,
            favorite: this.favorite,
            contents: this.isText() ? this.text : this.filename
        };
        if (this.tag)
            json.tag = this.tag;
        return json;
    }

    isText () {
        return isTextMimetype(this.mimetype);
    }

    isImage () {
        return this.mimetype.startsWith('image/');
    }

    isFavorite () {
        return this.favorite;
    }

    setFavorite (favorite) {
        this.favorite = !!favorite;
    }

    getTag () {
        return this.tag;
    }

    setTag (tag) {
        this.tag = tag || null;
    }

    setText (text) {
        if (this.isText())
            this.text = text;
    }

    getStringValue () {
        return this.isText() ? (this.text || '') : '[Image]';
    }

    getKey () {
        return this.isText() ? 'text:' + (this.text || '') : 'file:' + this.filename;
    }
};

/* Outcome of Registry.read(). */
var ReadStatus = {
    OK: 'ok',
    EMPTY: 'empty',
    /* An encrypted registry exists but this key cannot open it. */
    WRONG_KEY: 'wrong-key',
    /* An encrypted registry exists and no key is set. */
    LOCKED: 'locked'
};

var Registry = class Registry {
    constructor (uuid, dir, crypto) {
        this.uuid = uuid;
        this.dir = dir;
        this.crypto = crypto;
        this.key = null;
        /* Images are slow to encrypt, so they only use the key when asked. */
        this.encryptImages = false;
    }

    static defaultDir (uuid) {
        return GLib.get_user_cache_dir() + '/' + uuid;
    }

    setKey (key) {
        this.key = key;
    }

    _path (name) {
        return this.dir + '/' + name;
    }

    ensureDir () {
        GLib.mkdir_with_parents(this.dir, 0o700);
    }

    hasEncryptedRegistry () {
        return GLib.file_test(this._path(ENCRYPTED_REGISTRY), GLib.FileTest.EXISTS);
    }

    hasPlainRegistry () {
        return GLib.file_test(this._path(PLAIN_REGISTRY), GLib.FileTest.EXISTS);
    }

    /* Salt of the stored encrypted registry, needed to re-derive a password key. */
    storedSalt () {
        if (!this.hasEncryptedRegistry())
            return null;
        return this.crypto.saltOf(readFile(this._path(ENCRYPTED_REGISTRY)));
    }

    /* Returns { status, entries }, entries oldest first. */
    read () {
        let bytes;

        if (this.hasEncryptedRegistry()) {
            if (!this.key)
                return { status: ReadStatus.LOCKED, entries: [] };

            bytes = this.key.decrypt(readFile(this._path(ENCRYPTED_REGISTRY)));
            if (bytes === null)
                return { status: ReadStatus.WRONG_KEY, entries: [] };
        }
        else if (this.hasPlainRegistry()) {
            bytes = readFile(this._path(PLAIN_REGISTRY));
        }
        else {
            return { status: ReadStatus.EMPTY, entries: [] };
        }

        const text = new TextDecoder().decode(bytes);
        if (text.trim().length === 0)
            return { status: ReadStatus.EMPTY, entries: [] };

        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (e) {
            global.logError('[' + this.uuid + '] history file is corrupt, starting over');
            return { status: ReadStatus.EMPTY, entries: [] };
        }

        const entries = parsed
            .map(json => ClipboardEntry.fromJSON(json))
            .filter(entry => !entry.isImage() ||
                GLib.file_test(this._path(entry.filename), GLib.FileTest.EXISTS));

        return { status: ReadStatus.OK, entries: entries };
    }

    /*
     * Writes the registry in the current key's format and removes the file
     * of the other format, so only one ever exists.
     */
    write (entries) {
        this.ensureDir();

        let data = new TextEncoder().encode(JSON.stringify(entries.map(e => e.toJSON())));
        let name = PLAIN_REGISTRY;
        let stale = ENCRYPTED_REGISTRY;

        if (this.key) {
            data = this.key.encrypt(data);
            name = ENCRYPTED_REGISTRY;
            stale = PLAIN_REGISTRY;
        }

        try {
            writeFile(this._path(name), data);
            deleteFile(this._path(stale));
        }
        catch (e) {
            global.logError('[' + this.uuid + '] could not write history: ' + e);
        }
    }

    /* Stores image bytes (GLib.Bytes or Uint8Array) and returns the file name. */
    writeImage (bytes) {
        this.ensureDir();

        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.get_data());
        const key = this.encryptImages ? this.key : null;
        const name = key
            ? key.nameFor(data)
            : GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(data));
        const path = this._path(name);

        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            writeFile(path, key ? key.encrypt(data) : data);

        return name;
    }

    /* Image bytes as a Uint8Array, or null when missing or undecryptable. */
    loadImage (entry) {
        if (entry.memoryData)
            return entry.memoryData;
        try {
            const data = readFile(this._path(entry.filename));
            /* Detect per file, so both formats read fine mid-switch. */
            if (!this.crypto.isEncrypted(data))
                return data;
            return this.key ? this.key.decrypt(data) : null;
        }
        catch (e) {
            return null;
        }
    }

    /* Removes cache files that no live entry points at. */
    pruneImageFiles (entries) {
        const keep = new Set(entries.filter(e => e.isImage()).map(e => e.filename));

        for (const name of this._listFiles()) {
            if (name !== PLAIN_REGISTRY && name !== ENCRYPTED_REGISTRY && !keep.has(name))
                deleteFile(this._path(name));
        }
    }

    /* Deletes the registry and every cached image. */
    clear () {
        for (const name of this._listFiles())
            deleteFile(this._path(name));
    }

    _listFiles () {
        const names = [];
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(this.dir)
                .enumerate_children('standard::name,standard::type',
                                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        }
        catch (e) {
            return names;
        }

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.REGULAR)
                names.push(info.get_name());
        }
        enumerator.close(null);
        return names;
    }

    /*
     * Rewrites the given entries into another directory and/or under another
     * key, then removes this registry's files.  Image entries are renamed in
     * place to their new file names.  Returns a registry for the new location.
     */
    migrate (entries, newDir, newKey, encryptImages = this.encryptImages) {
        const target = new Registry(this.uuid, newDir, this.crypto);
        target.setKey(newKey);
        target.encryptImages = encryptImages;
        target.ensureDir();

        const oldNames = new Set(this._listFiles());
        const written = new Set();

        for (const entry of entries) {
            if (!entry.isImage())
                continue;

            const data = this.loadImage(entry);
            if (data === null)
                throw new Error('could not read image ' + entry.filename);

            entry.filename = target.writeImage(data);
            delete entry.memoryData;
            written.add(entry.filename);
        }

        target.write(entries);

        /* Clean up the old location, sparing anything we just wrote there. */
        const sameDir = GLib.canonicalize_filename(newDir, null) ===
                        GLib.canonicalize_filename(this.dir, null);
        for (const name of oldNames) {
            if (sameDir && (written.has(name) ||
                            name === PLAIN_REGISTRY || name === ENCRYPTED_REGISTRY))
                continue;
            deleteFile(this._path(name));
        }

        if (!sameDir) {
            try {
                Gio.File.new_for_path(this.dir).delete(null);
            }
            catch (e) {
                /* Not empty, or not ours to remove.  Leave it. */
            }
        }

        return target;
    }
};
