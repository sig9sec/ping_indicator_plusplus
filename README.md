# Ping Indicator Plus Plus

A GNOME Shell extension that displays ping latency in the top bar.

Fork of the [original ping_indicator](https://github.com/trifonovkv/ping_indicator),
rewritten for GNOME 45+ with:

- Dual-stack monitoring: IPv4 and/or IPv6, each tracked independently
  (`ipv4`, `ipv6` or `both` mode)
- Per-protocol status in the top bar (`ipv4 23ms ✅ ipv6 31ms ✅`)
- Smart retry: hard-failed protocols (no route, DNS failure, bad
  destination) are re-probed on a configurable cadence instead of
  respawning every second
- Offline alert (sound + top bar color) fires only when **all** active
  protocols are down, and only once per outage
- Failure reasons in the panel menu: Timeout, Unreachable,
  No network, DNS Err, Bad dest
- Persistent `ping` subprocesses (no spawning per refresh)
- Modern Adwaita preferences UI

![screenshot1](screenshot1.png)

![screenshot2](screenshot2.png)

## Installation

### From source

```sh
make install
```

This builds the extension and runs `gnome-extensions install --force` for you.

Log out and back in, then enable:

```sh
gnome-extensions enable ping_indicator_plusplus@info.sig9.ch
```

If you prefer to run the steps manually:

```sh
make
gnome-extensions install --force ping_indicator_plusplus@info.sig9.ch.zip
```

### Manual

```sh
cd ~/.local/share/gnome-shell/extensions/
wget https://github.com/sig9sec/ping_indicator_plusplus/releases/download/v1/ping_indicator_plusplus@info.sig9.ch.zip
unzip ping_indicator_plusplus@info.sig9.ch.zip -d ping_indicator_plusplus@info.sig9.ch
rm ping_indicator_plusplus@info.sig9.ch.zip
```

Log out and back in, then enable with `gnome-extensions enable ping_indicator_plusplus@info.sig9.ch`.

## Configuration

All settings are available in the preferences dialog. Notable keys:

| Key                    | Default                | Meaning                                                       |
|------------------------|------------------------|---------------------------------------------------------------|
| `ping-mode`            | `both`                 | Which protocol(s) to monitor                                  |
| `ping-destination-v4`  | `8.8.8.8`              | IPv4 destination (IP or hostname)                             |
| `ping-destination-v6`  | `2001:4860:4860::8888` | IPv6 destination (IP or hostname)                             |
| `refresh-interval`     | `2`                    | Seconds between pings                                         |
| `failure-timeout`      | `10`                   | Seconds without a reply before a protocol counts as down      |
| `retry-interval`       | `30`                   | Smart-retry cadence for exited protocols                      |
| `show-protocol-status` | `true`                 | Per-protocol panel display; `false` = single legacy value     |

Tips:

- The IPv6 destination should be a real external address: `::1` or a
  link-local address is always reachable and would report IPv6 as
  healthy even without actual connectivity.
- Leaving a destination empty disables that protocol.
- The offline alert (sound, bar color) only fires when **every**
  active protocol is down. If you only care about IPv4, set the mode
  to `ipv4`.

### Upgrading from v4

The old `ping-destination` setting was replaced by the per-protocol
destinations; set your destination once in the preferences dialog. By
default both protocols are now monitored; switch `ping-mode` to
`ipv4` for the old single-stack behavior and display.

## Development

Run the static checks (schema strict compile, JS syntax, unit tests):

```sh
make check
```

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
