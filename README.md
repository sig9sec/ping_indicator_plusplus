# Ping Indicator Plus Plus

A GNOME Shell extension that displays ping latency in the top bar.

Fork of the [original ping_indicator](https://github.com/trifonovkv/ping_indicator),
rewritten for GNOME 45+ with:

- Persistent `ping` subprocess (no spawning per refresh)
- Automatic retry on connection loss
- Optional top bar color change when the network is down
- Modern Adwaita preferences UI

![screenshot](screenshot.png)

## Installation

### From source

```sh
make
gnome-extensions install --force ping_indicator_plusplus@info.sig9.ch.zip
```

Log out and back in, then enable:

```sh
gnome-extensions enable ping_indicator_plusplus@info.sig9.ch
```

### Manual

```sh
cd ~/.local/share/gnome-shell/extensions/
wget https://github.com/sig9sec/ping_indicator_plusplus/releases/download/v1/ping_indicator_plusplus@info.sig9.ch.zip
unzip ping_indicator_plusplus@info.sig9.ch.zip -d ping_indicator_plusplus@info.sig9.ch
rm ping_indicator_plusplus@info.sig9.ch.zip
```

Log out and back in, then enable with `gnome-extensions enable ping_indicator_plusplus@info.sig9.ch`.

## Building the schema

The `schemas/gschemas.compiled` file is generated from the `.gschema.xml`:

```sh
glib-compile-schemas schemas/
```

This is done automatically by `make`.

## Troubleshooting

1. Check for GNOME Shell errors: `journalctl --user -f | grep -i ping`
2. Inspect via Looking Glass: `Alt+F2` → type `lg` → Extensions
3. Verify the extension is listed: `gnome-extensions list`
4. Run `gnome-tweaks` and make sure the extension is enabled
