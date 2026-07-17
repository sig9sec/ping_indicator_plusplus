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
const RETRY_INTERVAL_SEC = 5;

const PingIndicator = GObject.registerClass(
class PingIndicator extends PanelMenu.Button {
    _init(ext) {
      super._init(0.0, "Ping Indicator++", false);

      this._ext = ext;
      this._settings = ext.getSettings();
      this._proc = null;
      this._stream = null;
      this._cancellable = null;
      this._retryId = null;
      this._cssProvider = null;

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

      this._startPing();
    }

    _startPing() {
      this._stopPing();
      this._clearError();
      this._cancellable = new Gio.Cancellable();

      const dest = this._settings.get_string("ping-destination");
      const interval = this._settings.get_int("refresh-interval");

      try {
        this._proc = new Gio.Subprocess({
          argv: ["ping", "-i", String(interval), "-s", "16", dest],
          flags: Gio.SubprocessFlags.STDOUT_PIPE,
        });
        this._proc.init(null);

        this._stream = new Gio.DataInputStream({
          base_stream: this._proc.get_stdout_pipe(),
        });

        this._readLine();
      } catch (e) {
        logError(e, "Ping Indicator++: failed to start ping");
        this._handleError();
      }
    }

    _handleError() {
      this._buttonText.set_text("Error");
      this._applyErrorStyle();
      // Schedule a retry
      this._retryId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        RETRY_INTERVAL_SEC,
        () => {
          this._retryId = null;
          this._startPing();
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _readLine() {
      this._stream.read_line_async(
        GLib.PRIORITY_DEFAULT,
        this._cancellable,
        (stream, result) => {
          try {
            let [line] = stream.read_line_finish(result);
            if (!line) {
              // EOF: ping exited. Clean up and retry if still active.
              if (this._proc !== null) {
                this._proc = null;
                this._stream = null;
                this._handleError();
              }
              return;
            }

            let output = new TextDecoder().decode(line);

            let match = output.match(/time[=<](\d+(?:\.\d+)?)\s*ms/);
            if (match) {
              this._buttonText.set_text(
                `${Math.round(parseFloat(match[1]))} ms`,
              );
              this._clearError();
            } else if (
              output.includes("timeout") ||
              output.includes("Unreachable")
            ) {
              this._buttonText.set_text("Timeout");
              this._applyErrorStyle();
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

    _applyErrorStyle() {
      if (!this._settings.get_boolean("enable-color-on-failure")) return;

      const color = this._settings.get_string("color-on-failure");
      const css = `#panel { background-color: ${color}; }`;

      if (!this._cssProvider) {
        this._cssProvider = new St.CssProvider();
        St.StyleContext.add_provider_for_stage(
          global.stage,
          this._cssProvider,
          St.StyleContext.STYLE_PRIORITY_USER,
        );
      }
      this._cssProvider.load_from_data(css, css.length);
    }

    _clearError() {
      if (this._cssProvider) {
        St.StyleContext.remove_provider_for_stage(
          global.stage,
          this._cssProvider,
          St.StyleContext.STYLE_PRIORITY_USER,
        );
        this._cssProvider = null;
      }
    }

    _stopPing() {
      if (this._retryId) {
        GLib.source_remove(this._retryId);
        this._retryId = null;
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
    }

    destroy() {
      this._stopPing();
      this._clearError();

      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = undefined;
      }

      super.destroy();
    }
  },
);

export default class PingIndicatorExtension extends Extension {
  enable() {
    log(`enabling ${this.metadata.name} version ${this.metadata.version}`);
    this._indicator = new PingIndicator(this);
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    log(`disabling ${this.metadata.name} version ${this.metadata.version}`);
    this._indicator.destroy();
    this._indicator = null;
  }
}
