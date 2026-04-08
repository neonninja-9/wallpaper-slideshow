# Wallpaper Slideshow

A GNOME Shell extension that turns a plain wallpaper rotation into something that feels deliberate: smooth transitions, simple controls in the top bar, and a preferences window that stays out of the way.

It cycles through images from a folder, updates both light and dark wallpaper URIs, and lets you move forward, backward, pause, or resume without leaving the desktop.

## Highlights

- Smooth wallpaper transitions: `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom-in`, `zoom-out`, `random`, or `none`
- Clean panel indicator with quick actions for previous, next, pause/resume, and settings
- Folder-based wallpaper source with automatic image discovery
- Sequential or shuffled playback
- Adjustable change interval from `10 seconds` to `1 hour`
- Adjustable animation duration from `100 ms` to `5000 ms`
- Preferences window built with GTK4 and Libadwaita
- Live preview of the current wallpaper inside preferences
- Supports `JPG`, `JPEG`, `PNG`, `WEBP`, `BMP`, and `GIF`
- Compatible with GNOME Shell `45`, `46`, `47`, `48`, and `49`

## How It Works

When the slideshow advances, the extension creates a temporary animated overlay inside GNOME Shell's background layer, plays the chosen transition, then commits the new wallpaper through `org.gnome.desktop.background`. This keeps the desktop feeling fluid without interfering with the panel, windows, notifications, or the rest of the shell UI.

## Panel Controls

The extension adds a wallpaper icon to the top bar. Its menu gives you:

- `Previous Wallpaper`
- `Pause` or `Resume`
- `Next Wallpaper`
- `Settings`

The menu also shows the current file name and its position in the playlist.

## Preferences

The preferences window is split into three sections:

### General

- Choose the wallpaper folder
- Clear the current folder selection
- Set the auto-change interval
- Enable or disable random order
- Pause the slideshow

### Transition

- Select a transition effect
- Adjust animation duration
- Reset transition settings to defaults

### About

- Extension version
- Supported GNOME Shell range
- Usage tips

## Installation

### Option 1: Clone This Repository

```bash
git clone https://github.com/neonninja-9/wallpaper-slideshow.git \
  ~/.local/share/gnome-shell/extensions/wallpaper-slideshow@neonninja09
cd ~/.local/share/gnome-shell/extensions/wallpaper-slideshow@neonninja09
glib-compile-schemas schemas
```

Then reload GNOME Shell:

- On X11, press `Alt` + `F2`, type `r`, and press Enter.
- On Wayland, log out and back in.

### Option 2: Install From a Local Folder

Copy the extension into:

```bash
~/.local/share/gnome-shell/extensions/wallpaper-slideshow@neonninja09
```

Then compile schemas:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/wallpaper-slideshow@neonninja09/schemas
```

## Development

Useful files in this project:

- `extension.js` - slideshow engine, transitions, and top-bar menu
- `prefs.js` - preferences UI
- `metadata.json` - extension metadata
- `schemas/org.gnome.shell.extensions.wallpaper-slideshow.gschema.xml` - settings schema
- `stylesheet.css` - shell styling

If you edit the schema, recompile it before testing:

```bash
glib-compile-schemas schemas
```

## Settings Stored

The extension stores its configuration under:

```text
org.gnome.shell.extensions.wallpaper-slideshow
```

Main keys include:

- `wallpaper-folder`
- `interval`
- `transition-type`
- `animation-duration`
- `random-order`
- `paused`
- `current-index`

## Supported Image Formats

The extension recognizes:

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.bmp`
- `.gif`

## License

No license file is included yet. If you plan to publish or accept contributions, add a license to make reuse terms explicit.
