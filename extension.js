/**
 * extension.js — Wallpaper Slideshow Extension
 * UUID: wallpaper-slideshow@neonninja09
 *
 * Targets: GNOME Shell 45, 46, 47, 48, 49 (ESM / GJS)
 *
 * Architecture:
 *   WallpaperSlideshow      – core slideshow engine (timer, file list, transitions)
 *   SlideshowIndicator      – panel button + popup menu (pause/resume/next/prev)
 *   WallpaperSlideshowExt   – Extension lifecycle glue (enable / disable)
 *
 * Transition strategy:
 *   We create a temporary Clutter.Actor loaded with the NEW wallpaper image,
 *   insert it into Main.layoutManager._backgroundGroup (above the real
 *   wallpaper actors but below all windows/UI), animate it in, then
 *   commit the change to org.gnome.desktop.background and destroy the actor.
 *   This keeps every other Shell layer (panel, dash, notifications) intact.
 */

import GLib      from 'gi://GLib';
import Gio       from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Clutter   from 'gi://Clutter';
import Cogl      from 'gi://Cogl';
import GObject   from 'gi://GObject';
import St        from 'gi://St';

import * as Main       from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu  from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu  from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ }
  from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif',
]);
const SUPPORTED_EXT  = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

const DESKTOP_BG_SCHEMA = 'org.gnome.desktop.background';

/** All non-random transition names (used when mode === 'random'). */
const REAL_TRANSITIONS = [
  'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down',
  'zoom-in', 'zoom-out',
];

// ─── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Shuffle an array in-place using Fisher-Yates.
 * @param {Array} arr
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Attempt to detect image MIME type from file info, falling back to extension.
 * @param {Gio.FileInfo} info
 * @param {string} name
 * @returns {boolean}
 */
function isImageFile(info, name) {
  const contentType = info.get_content_type();
  if (contentType && SUPPORTED_MIME.has(contentType))
    return true;
  const ext = GLib.path_get_basename(name)
    .toLowerCase()
    .match(/\.[^.]+$/)?.[0];
  return ext ? SUPPORTED_EXT.has(ext) : false;
}

/**
 * Load a GdkPixbuf from a file path, scaled to fit the primary monitor.
 * Performed synchronously — called off the frame tick (not in paint cycle).
 * @param {string} filePath
 * @returns {GdkPixbuf.Pixbuf|null}
 */
function loadPixbuf(filePath) {
  try {
    const monitor = Main.layoutManager.primaryMonitor;
    const w = monitor.width;
    const h = monitor.height;
    // Load at native size first to get aspect ratio, then scale
    const raw = GdkPixbuf.Pixbuf.new_from_file(filePath);
    const scale = Math.max(w / raw.get_width(), h / raw.get_height());
    const sw    = Math.round(raw.get_width()  * scale);
    const sh    = Math.round(raw.get_height() * scale);
    return raw.scale_simple(sw, sh, GdkPixbuf.InterpType.BILINEAR);
  } catch (e) {
    console.error(`[WallpaperSlideshow] loadPixbuf failed: ${e.message}`);
    return null;
  }
}

/**
 * Convert a GdkPixbuf into a Clutter.Image for GPU rendering.
 * @param {GdkPixbuf.Pixbuf} pixbuf
 * @returns {Clutter.Image|null}
 */
function pixbufToClutterImage(pixbuf) {
  try {
    const image = new Clutter.Image();
    const fmt   = pixbuf.get_has_alpha()
      ? Cogl.PixelFormat.RGBA_8888
      : Cogl.PixelFormat.RGB_888;
    image.set_data(
      pixbuf.read_pixel_bytes(),
      fmt,
      pixbuf.get_width(),
      pixbuf.get_height(),
      pixbuf.get_rowstride()
    );
    return image;
  } catch (e) {
    console.error(`[WallpaperSlideshow] pixbufToClutterImage failed: ${e.message}`);
    return null;
  }
}

function getBackgroundGroup() {
  return Main.layoutManager._backgroundGroup ??
    Main.layoutManager.backgroundGroup ??
    null;
}

// ─── TransitionPlayer ──────────────────────────────────────────────────────────

/**
 * TransitionPlayer — creates a full-screen overlay actor loaded with the new
 * wallpaper image, animates it according to the chosen transition, then calls
 * the provided onComplete callback so the caller can commit the wallpaper to
 * GSettings and destroy the actor.
 */
class TransitionPlayer {
  /**
   * @param {string}   imagePath     - absolute path to the new wallpaper
   * @param {string}   transitionType - one of REAL_TRANSITIONS or 'none'
   * @param {number}   duration      - animation duration in ms
   * @param {Function} onComplete    - called after animation finishes
   */
  constructor(imagePath, transitionType, duration, onComplete) {
    this._imagePath      = imagePath;
    this._transitionType = transitionType;
    this._duration       = duration;
    this._onComplete     = onComplete;
    this._actor          = null;
  }

  /** Build actor and start animation. */
  play() {
    const monitor = Main.layoutManager.primaryMonitor;
    const backgroundGroup = getBackgroundGroup();

    if (!monitor || !backgroundGroup) {
      this._onComplete?.();
      return;
    }

    // ── Load image ──────────────────────────────────────────────────────────
    const pixbuf = loadPixbuf(this._imagePath);
    if (!pixbuf) {
      // Fallback: skip animation, still fire onComplete
      this._onComplete?.();
      return;
    }
    const clutterImage = pixbufToClutterImage(pixbuf);
    if (!clutterImage) {
      this._onComplete?.();
      return;
    }

    // ── Create fullscreen actor ──────────────────────────────────────────────
    this._actor = new Clutter.Actor({
      x:       monitor.x,
      y:       monitor.y,
      width:   monitor.width,
      height:  monitor.height,
      opacity: 255,
    });
    this._actor.set_content(clutterImage);
    if (this._actor.set_content_scaling_filters) {
      this._actor.set_content_scaling_filters(
        Clutter.ScalingFilter.TRILINEAR,
        Clutter.ScalingFilter.LINEAR
      );
    }
    if (this._actor.set_content_gravity)
      this._actor.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);

    // Insert into background group, on top of existing background actors
    backgroundGroup.add_child(this._actor);

    // ── Dispatch to the right transition ────────────────────────────────────
    switch (this._transitionType) {
      case 'fade':       this._playFade();                  break;
      case 'slide-left': this._playSlide('left');           break;
      case 'slide-right':this._playSlide('right');          break;
      case 'slide-up':   this._playSlide('up');             break;
      case 'slide-down': this._playSlide('down');           break;
      case 'zoom-in':    this._playZoom('in');              break;
      case 'zoom-out':   this._playZoom('out');             break;
      default:           this._finalize();                  break; // 'none'
    }
  }

  /** Destroy the overlay actor (called by finalize or externally on cleanup). */
  destroy() {
    if (this._actor) {
      this._actor.destroy();
      this._actor = null;
    }
  }

  // ── Private transition implementations ──────────────────────────────────────

  /** Cross-fade: start transparent, ease to full opacity. */
  _playFade() {
    this._actor.set_opacity(0);
    this._actor.ease({
      opacity:  255,
      duration: this._duration,
      mode:     Clutter.AnimationMode.EASE_IN_OUT_QUAD,
      onComplete: () => this._finalize(),
    });
  }

  /**
   * Slide: new wallpaper enters from off-screen in the given direction.
   * @param {'left'|'right'|'up'|'down'} dir
   */
  _playSlide(dir) {
    const monitor = Main.layoutManager.primaryMonitor;
    const W = monitor.width;
    const H = monitor.height;
    const X = monitor.x;
    const Y = monitor.y;

    let startX = X, startY = Y;
    switch (dir) {
      case 'left':  startX = X + W; break;
      case 'right': startX = X - W; break;
      case 'up':    startY = Y + H; break;
      case 'down':  startY = Y - H; break;
    }

    this._actor.set_position(startX, startY);
    this._actor.ease({
      x:        X,
      y:        Y,
      duration: this._duration,
      mode:     Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
      onComplete: () => this._finalize(),
    });
  }

  /**
   * Zoom: 'in' = start small and expand; 'out' = start large and shrink.
   * @param {'in'|'out'} type
   */
  _playZoom(type) {
    const monitor = Main.layoutManager.primaryMonitor;
    const W = monitor.width;
    const H = monitor.height;
    const X = monitor.x;
    const Y = monitor.y;

    // Pivot from screen center
    this._actor.set_pivot_point(0.5, 0.5);

    if (type === 'in') {
      // Start tiny, fade in, expand to full size
      this._actor.set_scale(0.3, 0.3);
      this._actor.set_opacity(0);
      this._actor.ease({
        scale_x:  1.0,
        scale_y:  1.0,
        opacity:  255,
        duration: this._duration,
        mode:     Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this._finalize(),
      });
    } else {
      // Start oversized, fade in, shrink to fill screen
      this._actor.set_scale(1.5, 1.5);
      this._actor.set_opacity(0);
      this._actor.ease({
        scale_x:  1.0,
        scale_y:  1.0,
        opacity:  255,
        duration: this._duration,
        mode:     Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this._finalize(),
      });
    }
  }

  /** Commit wallpaper change and clean up actor. */
  _finalize() {
    this._onComplete?.();
    this.destroy();
  }
}

// ─── WallpaperSlideshow Engine ─────────────────────────────────────────────────

/**
 * Core slideshow logic:
 *  - Scans the configured folder for image files.
 *  - Maintains an ordered or shuffled playlist.
 *  - Drives a GLib timer to advance the slideshow.
 *  - Delegates wallpaper rendering/transition to TransitionPlayer.
 *  - Writes the chosen image URI to org.gnome.desktop.background.
 */
class WallpaperSlideshow {
  /**
   * @param {Gio.Settings} extSettings - extension's GSettings instance
   */
  constructor(extSettings) {
    this._settings     = extSettings;
    this._bgSettings   = new Gio.Settings({ schema: DESKTOP_BG_SCHEMA });
    this._wallpapers   = [];   // full sorted list loaded from disk
    this._playlist     = [];   // current shuffled/ordered playlist
    this._currentIndex = 0;
    this._timerId      = null;
    this._player       = null; // active TransitionPlayer
    this._transitioning = false;

    this._settingsChangedIds = [];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Load wallpapers from folder and start the timer. */
  enable() {
    this._bindSettings();
    this._reloadWallpapers();
  }

  /** Stop timer and clean up any active transition. */
  disable() {
    this._stopTimer();
    this._disconnectSettings();
    this._player?.destroy();
    this._player = null;
  }

  /** Move to the next wallpaper immediately. */
  next() {
    this._advance(+1);
  }

  /** Move to the previous wallpaper immediately. */
  prev() {
    this._advance(-1);
  }

  /** Toggle pause / resume. */
  togglePause() {
    const paused = !this._settings.get_boolean('paused');
    this._settings.set_boolean('paused', paused);
    if (paused) {
      this._stopTimer();
    } else {
      this._startTimer();
      this._changeWallpaper(); // show next one immediately on resume
    }
  }

  /** @returns {boolean} */
  get isPaused() {
    return this._settings.get_boolean('paused');
  }

  /** @returns {string} basename of the current wallpaper file, or '—'. */
  get currentFileName() {
    const p = this._playlist[this._currentIndex];
    return p ? GLib.path_get_basename(p) : '—';
  }

  /** @returns {number} total number of loaded wallpapers. */
  get count() {
    return this._playlist.length;
  }

  // ── Settings wiring ────────────────────────────────────────────────────────

  _bindSettings() {
    const watch = (key, fn) => {
      const id = this._settings.connect(`changed::${key}`, fn.bind(this));
      this._settingsChangedIds.push(id);
    };

    watch('wallpaper-folder', this._reloadWallpapers);
    watch('interval',         this._restartTimer);
    watch('random-order',     this._buildPlaylist);
    watch('paused', () => {
      if (this._settings.get_boolean('paused'))
        this._stopTimer();
      else
        this._startTimer();
    });
  }

  _disconnectSettings() {
    for (const id of this._settingsChangedIds)
      this._settings.disconnect(id);
    this._settingsChangedIds = [];
  }

  // ── File loading ───────────────────────────────────────────────────────────

  /**
   * Enumerate images from the configured folder asynchronously.
   * Rebuilds the playlist when done.
   */
  _reloadWallpapers() {
    const folderPath = this._settings.get_string('wallpaper-folder');
    if (!folderPath) {
      this._wallpapers = [];
      this._buildPlaylist();
      return;
    }

    const dir = Gio.File.new_for_path(folderPath);
    if (!dir.query_exists(null)) {
      console.warn(`[WallpaperSlideshow] Folder not found: ${folderPath}`);
      this._wallpapers = [];
      this._buildPlaylist();
      return;
    }

    dir.enumerate_children_async(
      'standard::name,standard::type,standard::content-type',
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (obj, res) => {
        try {
          const enumerator = dir.enumerate_children_finish(res);
          const files      = [];
          let   info;

          while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR) continue;
            const name = info.get_name();
            if (isImageFile(info, name))
              files.push(GLib.build_filenamev([folderPath, name]));
          }
          enumerator.close(null);

          files.sort(); // deterministic base order
          this._wallpapers = files;
          console.log(
            `[WallpaperSlideshow] Loaded ${files.length} images from ${folderPath}`
          );
          this._buildPlaylist();
        } catch (e) {
          console.error(`[WallpaperSlideshow] _reloadWallpapers: ${e.message}`);
        }
      }
    );
  }

  // ── Playlist management ────────────────────────────────────────────────────

  /** Build/rebuild the active playlist (shuffled or sequential). */
  _buildPlaylist() {
    if (this._wallpapers.length === 0) {
      this._playlist     = [];
      this._currentIndex = 0;
      this._stopTimer();
      return;
    }

    this._playlist     = [...this._wallpapers];
    this._currentIndex = Math.min(
      this._settings.get_int('current-index'),
      this._playlist.length - 1
    );

    if (this._settings.get_boolean('random-order'))
      shuffleArray(this._playlist);

    this._commitBackground(this._playlist[this._currentIndex]);

    if (!this._settings.get_boolean('paused'))
      this._startTimer();
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  _startTimer() {
    this._stopTimer();
    if (this._playlist.length === 0) return;

    const intervalMs = this._settings.get_int('interval') * 1000;
    this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
      this._changeWallpaper();
      return GLib.SOURCE_CONTINUE; // keep repeating
    });
  }

  _stopTimer() {
    if (this._timerId !== null) {
      if (GLib.Source.remove)
        GLib.Source.remove(this._timerId);
      else
        GLib.source_remove(this._timerId);
      this._timerId = null;
    }
  }

  _restartTimer() {
    this._stopTimer();
    if (!this._settings.get_boolean('paused'))
      this._startTimer();
  }

  // ── Wallpaper change ───────────────────────────────────────────────────────

  /**
   * Called by the timer (or manually). Picks the next image and fires the
   * transition.
   */
  _changeWallpaper() {
    if (this._transitioning || this._playlist.length === 0) return;

    // Advance index
    this._currentIndex = (this._currentIndex + 1) % this._playlist.length;
    this._settings.set_int('current-index', this._currentIndex);

    const imagePath = this._playlist[this._currentIndex];
    let   transition = this._settings.get_string('transition-type');

    // Pick a random concrete transition when mode === 'random'
    if (transition === 'random')
      transition = REAL_TRANSITIONS[
        Math.floor(Math.random() * REAL_TRANSITIONS.length)
      ];

    const duration = this._settings.get_int('animation-duration');

    this._transitioning = true;
    this._player?.destroy(); // abort any in-flight transition

    if (transition === 'none') {
      // Instant change — no animation
      this._commitBackground(imagePath);
      this._transitioning = false;
    } else {
      this._player = new TransitionPlayer(
        imagePath,
        transition,
        duration,
        () => {
          this._commitBackground(imagePath);
          this._transitioning = false;
          this._player = null;
        }
      );
      this._player.play();
    }
  }

  /**
   * Advance by +1 (next) or -1 (prev) relative to the current index,
   * restarting the timer so the full interval resets after a manual skip.
   * @param {number} delta +1 or -1
   */
  _advance(delta) {
    if (this._playlist.length === 0) return;

    this._currentIndex =
      (this._currentIndex + delta + this._playlist.length) %
      this._playlist.length;
    this._settings.set_int('current-index', this._currentIndex);

    const imagePath  = this._playlist[this._currentIndex];
    let   transition = this._settings.get_string('transition-type');
    if (transition === 'random')
      transition = REAL_TRANSITIONS[
        Math.floor(Math.random() * REAL_TRANSITIONS.length)
      ];

    const duration = this._settings.get_int('animation-duration');

    // Reset the auto-advance timer
    this._restartTimer();

    if (this._transitioning) return; // don't stack animations
    this._transitioning = true;
    this._player?.destroy();

    if (transition === 'none') {
      this._commitBackground(imagePath);
      this._transitioning = false;
    } else {
      this._player = new TransitionPlayer(
        imagePath,
        transition,
        duration,
        () => {
          this._commitBackground(imagePath);
          this._transitioning = false;
          this._player = null;
        }
      );
      this._player.play();
    }
  }

  /**
   * Write the image path to org.gnome.desktop.background.
   * Sets both light and dark URI keys (GNOME 42+).
   * @param {string} imagePath
   */
  _commitBackground(imagePath) {
    try {
      const uri = GLib.filename_to_uri(imagePath, null);
      this._bgSettings.set_string('picture-uri',      uri);
      this._bgSettings.set_string('picture-uri-dark', uri);
      this._bgSettings.set_string('picture-options',  'zoom');
      Gio.Settings.sync();
    } catch (e) {
      console.error(`[WallpaperSlideshow] _commitBackground: ${e.message}`);
    }
  }
}

// ─── Panel Indicator ───────────────────────────────────────────────────────────

/**
 * SlideshowIndicator — a PanelMenu.Button that lives in the system status area.
 * Provides quick controls: pause/resume, next, previous, and shows the current
 * filename + index.
 */
class SlideshowIndicator extends PanelMenu.Button {
  static {
    GObject.registerClass(this);
  }

  /**
   * @param {WallpaperSlideshow} slideshow
   */
  _init(slideshow) {
    super._init(0.0, _('Wallpaper Slideshow'));
    this._slideshow = slideshow;

    // ── Panel icon ────────────────────────────────────────────────────────────
    const icon = new St.Icon({
      icon_name:  'preferences-desktop-wallpaper-symbolic',
      style_class: 'system-status-icon wallpaper-slideshow-icon',
    });
    this.add_child(icon);

    // ── Popup menu ────────────────────────────────────────────────────────────
    this._buildMenu();
  }

  _buildMenu() {
    const menu = this.menu;

    // Title label
    const titleItem = new PopupMenu.PopupMenuItem(
      _('Wallpaper Slideshow'),
      { reactive: false, can_focus: false }
    );
    titleItem.label.add_style_class_name('wallpaper-slideshow-filename');
    menu.addMenuItem(titleItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Current file label
    this._fileItem = new PopupMenu.PopupMenuItem('', {
      reactive: false, can_focus: false,
    });
    this._fileItem.label.add_style_class_name('wallpaper-slideshow-filename');
    menu.addMenuItem(this._fileItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // ── Controls ──────────────────────────────────────────────────────────────
    // Previous
    const prevItem = new PopupMenu.PopupImageMenuItem(
      _('Previous Wallpaper'), 'media-skip-backward-symbolic'
    );
    prevItem.connect('activate', () => {
      this._slideshow.prev();
      this._refresh();
    });
    menu.addMenuItem(prevItem);

    // Play / Pause
    this._pauseItem = new PopupMenu.PopupImageMenuItem(
      this._slideshow.isPaused ? _('Resume') : _('Pause'),
      this._slideshow.isPaused
        ? 'media-playback-start-symbolic'
        : 'media-playback-pause-symbolic'
    );
    this._pauseItem.connect('activate', () => {
      this._slideshow.togglePause();
      this._refresh();
    });
    menu.addMenuItem(this._pauseItem);

    // Next
    const nextItem = new PopupMenu.PopupImageMenuItem(
      _('Next Wallpaper'), 'media-skip-forward-symbolic'
    );
    nextItem.connect('activate', () => {
      this._slideshow.next();
      this._refresh();
    });
    menu.addMenuItem(nextItem);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Open Settings
    const settingsItem = new PopupMenu.PopupImageMenuItem(
      _('Settings'), 'preferences-system-symbolic'
    );
    settingsItem.connect('activate', () => {
      // Trigger the extension's openPreferences() via the Extension object.
      // We store a reference to the Extension on the slideshow for this.
      this._slideshow._extension?.openPreferences();
    });
    menu.addMenuItem(settingsItem);

    // Update labels on open
    menu.connect('open-state-changed', (m, open) => {
      if (open) this._refresh();
    });
  }

  /** Refresh pause button label + current filename. */
  _refresh() {
    const paused = this._slideshow.isPaused;
    this._pauseItem.label.set_text(paused ? _('Resume') : _('Pause'));
    this._pauseItem.setIcon(new Gio.ThemedIcon({
      name: paused
        ? 'media-playback-start-symbolic'
        : 'media-playback-pause-symbolic',
    }));

    const name  = this._slideshow.currentFileName;
    const count = this._slideshow.count;
    const idx   = (this._slideshow._currentIndex ?? 0) + 1;
    this._fileItem.label.set_text(
      count > 0 ? `${name}  (${idx} / ${count})` : _('No wallpapers loaded')
    );
  }
}

// ─── Extension entry-point ─────────────────────────────────────────────────────

export default class WallpaperSlideshowExt extends Extension {
  enable() {
    this._settings   = this.getSettings();
    this._slideshow  = new WallpaperSlideshow(this._settings);
    // Give the slideshow a back-reference so it can open prefs from the menu
    this._slideshow._extension = this;

    this._indicator = new SlideshowIndicator(this._slideshow);
    Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

    this._slideshow.enable();

    console.log('[WallpaperSlideshow] Extension enabled');
  }

  disable() {
    this._slideshow?.disable();
    this._slideshow  = null;
    this._indicator?.destroy();
    this._indicator  = null;
    this._settings   = null;

    console.log('[WallpaperSlideshow] Extension disabled');
  }
}
