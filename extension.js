import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const SOUND_FILE_PATH = "/usr/share/sounds/freedesktop/stereo/bell.oga";
// Watchdog checks the last-success timestamp this often.
const WATCHDOG_INTERVAL_SEC = 1;
// Per-packet reply wait passed to ping via -W (seconds). Keeps ping
// from blocking for a long time on silent hosts.
const PING_REPLY_WAIT_SEC = 1;

const PingIndicator = GObject.registerClass(
class PingIndicator extends PanelMenu.Button {
    _init(ext) {
      super._init(0.0, "Ping Indicator++", false);

      this._ext = ext;
      this._settings = ext.getSettings();
      this._proc = null;
      this._stream = null;
      this._cancellable = null;
      this._watchdogId = null;
      this._reapplyTimeoutId = null;
      this._lastSuccessMs = 0;
      this._inError = false;
      this._appliedColor = null;

      this._buttonText = new St.Label({
        text: "...",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this.add_child(this._buttonText);

      let item = new PopupMenu.PopupMenuItem("Settings");
      item.connect("activate", () => {
        this._ext.openPreferences();
      });
      this.menu.addMenuItem(item);

      this._settingsChangedId = this._settings.connect("changed", () => {
        this._startPing();
      });

      // GNOME Shell applies `#panel:overview { background-color:
      // transparent }` during overview transitions, which overrides
      // our inline style. Re-apply our error color after any overview
      // transition completes, if we're still in error state. We use a
      // 0ms timeout to defer the re-apply past GNOME Shell's own
      // transition styling. The source ID is tracked and removed in
      // destroy() to satisfy the EGO-L-004 lint rule.
      const reapplyIfInError = () => {
        if (!this._inError) return;
        if (this._reapplyTimeoutId) return;
        this._reapplyTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          0,
          () => {
            this._reapplyTimeoutId = null;
            if (this._inError) this._applyErrorStyle(true);
            return GLib.SOURCE_REMOVE;
          },
        );
      };
      this._overviewShowingId = Main.overview.connect("showing", reapplyIfInError);
      this._overviewHiddenId = Main.overview.connect("hidden", reapplyIfInError);

      this._startPing();
    }

    _startPing() {
      this._stopPing();
      this._cancellable = new Gio.Cancellable();

      // Only seed the last-success timestamp on the very first start
      // (or after destroy). On restarts triggered by the watchdog when
      // ping exited (DNS failure, host unreachable), we must preserve
      // the previous timestamp — otherwise a host that fails fast would
      // never accumulate enough elapsed time to trigger the timeout.
      const isFirstStart = this._lastSuccessMs === 0;
      if (isFirstStart) this._lastSuccessMs = Date.now();

      const dest = this._settings.get_string("ping-destination");
      const interval = this._settings.get_int("refresh-interval");

      try {
        this._proc = new Gio.Subprocess({
          argv: [
            "ping",
            "-i", String(interval),
            "-W", String(PING_REPLY_WAIT_SEC),
            "-s", "16",
            dest,
          ],
          flags: Gio.SubprocessFlags.STDOUT_PIPE,
        });
        this._proc.init(null);

        this._stream = new Gio.DataInputStream({
          base_stream: this._proc.get_stdout_pipe(),
        });

        this._readLine();
      } catch (e) {
        console.error("Ping Indicator++: failed to start ping", e);
      }

      this._watchdogId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        WATCHDOG_INTERVAL_SEC,
        () => {
          this._checkWatchdog();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _checkWatchdog() {
      const timeoutMs = this._settings.get_int("failure-timeout") * 1000;
      if (Date.now() - this._lastSuccessMs > timeoutMs) {
        this._handleError();
      }

      // If the process died (e.g. DNS failure, host unreachable),
      // restart it so we keep retrying the connection. Done after
      // the timeout check so a fast-failing ping still trips the
      // timeout correctly.
      if (this._proc === null) {
        this._startPing();
      }
    }

    _handleError() {
      if (this._inError) return;
      this._inError = true;

      this._buttonText.set_text("Timeout");
      this._applyErrorStyle(false);

      if (this._settings.get_boolean("beep-when-timeout")) {
        try {
          GLib.spawn_command_line_async(
            `canberra-gtk-play -f ${SOUND_FILE_PATH}`,
          );
        } catch (_e) {
          /* ignore */
        }
      }
    }

    _readLine() {
      if (!this._stream) return;
      this._stream.read_line_async(
        GLib.PRIORITY_DEFAULT,
        this._cancellable,
        (stream, result) => {
          try {
            let [line] = stream.read_line_finish(result);
            if (!line) {
              // EOF: ping exited (DNS failure, host unreachable, killed).
              // Null out _proc so the watchdog restarts the subprocess.
              this._proc = null;
              this._stream = null;
              return;
            }

            let output = new TextDecoder().decode(line);

            let match = output.match(/time[=<](\d+(?:\.\d+)?)\s*ms/);
            if (match) {
              this._buttonText.set_text(
                `${Math.round(parseFloat(match[1]))} ms`,
              );
              this._lastSuccessMs = Date.now();
              this._clearError();
            }
            // Per-packet timeout / unreachable lines are handled by the
            // watchdog via the lastSuccess timestamp; we don't toggle the
            // error style on individual failed packets to avoid flicker.

            this._readLine();
          } catch (_e) {
            // Cancelled or stream closed, clean up
            try {
              stream.close(null);
            } catch (__e) {
              /* already closed */
            }
          }
        },
      );
    }

    _applyErrorStyle(force) {
      if (!this._settings.get_boolean("enable-color-on-failure")) return;

      const color = this._settings.get_string("color-on-failure");
      // Skip the write if the style is already correct. Repeatedly
      // setting the same inline string causes St to re-evaluate and
      // re-render the panel actor, which produces a visible flicker.
      // `force` bypasses the cache for the overview-hidden case, where
      // GNOME Shell cleared our inline style behind our back.
      if (!force && this._appliedColor === color) return;
      this._appliedColor = color;
      Main.panel.set_style(`background-color: ${color};`);
    }

    _clearError() {
      if (!this._inError) return;
      this._inError = false;
      if (this._appliedColor !== null) {
        this._appliedColor = null;
        Main.panel.set_style(null);
      }
    }

    _stopPing() {
      if (this._watchdogId) {
        GLib.source_remove(this._watchdogId);
        this._watchdogId = null;
      }
      if (this._reapplyTimeoutId) {
        GLib.source_remove(this._reapplyTimeoutId);
        this._reapplyTimeoutId = null;
      }
      if (this._cancellable) {
        this._cancellable.cancel();
        this._cancellable = null;
      }
      if (this._proc) {
        let proc = this._proc;
        this._proc = null;
        proc.force_exit();
      }
      this._stream = null;
    }

    destroy() {
      this._stopPing();
      this._clearError();
      // Reset so the next enable() starts with a fresh timestamp.
      this._lastSuccessMs = 0;

      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = undefined;
      }
      if (this._overviewShowingId) {
        Main.overview.disconnect(this._overviewShowingId);
        this._overviewShowingId = undefined;
      }
      if (this._overviewHiddenId) {
        Main.overview.disconnect(this._overviewHiddenId);
        this._overviewHiddenId = undefined;
      }

      super.destroy();
    }
  },
);

export default class PingIndicatorExtension extends Extension {
  enable() {
    console.debug(`enabling ${this.metadata.name} version ${this.metadata.version}`);
    this._indicator = new PingIndicator(this);
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    console.debug(`disabling ${this.metadata.name} version ${this.metadata.version}`);
    this._indicator.destroy();
    this._indicator = null;
  }
}
