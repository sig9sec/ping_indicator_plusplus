import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { classifyStderr, stdoutUnreachable } from "./failureClassifier.js";

const SOUND_FILE_PATH = "/usr/share/sounds/freedesktop/stereo/bell.oga";
const WATCHDOG_INTERVAL_SEC = 1;
const PING_REPLY_WAIT_SEC = 1;

const PROTO_NAMES = ["v4", "v6"];
const PROTO_FLAG = { v4: "-4", v6: "-6" };
const PROTO_LABEL = { v4: "IPv4", v6: "IPv6" };
const ICON_DOWN = "network-offline-symbolic";
// Value of the ping-mode setting that selects this protocol. The
// schema uses full names ("ipv4"/"ipv6") while the internal protocol
// keys are short ("v4"/"v6", matching the -v4/-v6 settings keys).
const PROTO_MODE = { v4: "ipv4", v6: "ipv6" };
// Settings changes on these keys restart the ping processes; all other
// keys only affect rendering and are picked up on the next tick.
const RESTART_KEYS = [
  "refresh-interval",
  "ping-mode",
  "ping-destination-v4",
  "ping-destination-v6",
];
const COLOR_KEYS = ["color-on-failure", "enable-color-on-failure"];

const PingIndicator = GObject.registerClass(
  class PingIndicator extends PanelMenu.Button {
    constructor(ext) {
      super(0.0, "Ping Indicator++", false);

      this._ext = ext;
      this._settings = ext.getSettings();
      this._protos = {
        v4: this._newProtoState(),
        v6: this._newProtoState(),
      };
      this._watchdogId = null;
      this._reapplyTimeoutId = null;
      this._fullError = false;
      this._appliedColor = null;

      this._statusBox = new St.BoxLayout({
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._statusKey = "";
      this.add_child(this._statusBox);

      this._menuRows = {};
      for (const name of PROTO_NAMES) {
        const row = new PopupMenu.PopupMenuItem("-", {
          reactive: false,
          can_focus: false,
        });
        this.menu.addMenuItem(row);
        this._menuRows[name] = row;
      }
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      let item = new PopupMenu.PopupMenuItem("Settings");
      item.connect("activate", () => {
        this._ext.openPreferences();
      });
      this.menu.addMenuItem(item);

      this._settings.connectObject(
        "changed",
        (settings, key) => this._onSettingsChanged(key),
        this,
      );

      // Shell's overview CSS sets the panel background to transparent
      // and overrides our inline style. Re-apply after the transition,
      // deferred so we run after Shell's own style change.
      const reapplyIfInError = () => {
        if (!this._fullError) return;
        if (this._reapplyTimeoutId) return;
        this._reapplyTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          0,
          () => {
            this._reapplyTimeoutId = null;
            if (this._fullError) this._applyErrorStyle(true);
            return GLib.SOURCE_REMOVE;
          },
        );
      };
      Main.overview.connectObject(
        "showing",
        reapplyIfInError,
        "hidden",
        reapplyIfInError,
        this,
      );

      for (const name of PROTO_NAMES) {
        if (this._isActive(name)) this._startProto(name);
      }

      this._watchdogId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        WATCHDOG_INTERVAL_SEC,
        () => {
          this._checkWatchdog();
          return GLib.SOURCE_CONTINUE;
        },
      );
      this._updateLabel();
    }

    _newProtoState() {
      return {
        proc: null,
        stream: null,
        errStream: null,
        cancellable: null,
        stderrText: "",
        dest: null,
        lastSuccessMs: 0,
        lastLatencyMs: null,
        failureReason: null,
        exited: false,
        lastRetryMs: 0,
      };
    }

    _protoDest(name) {
      return this._settings.get_string(`ping-destination-${name}`).trim();
    }

    _modeIncludes(name) {
      const mode = this._settings.get_string("ping-mode");
      return mode === "both" || mode === PROTO_MODE[name];
    }

    _isActive(name) {
      return this._modeIncludes(name) && this._protoDest(name) !== "";
    }

    _startProto(name) {
      if (!this._isActive(name)) return;
      const p = this._protos[name];
      this._stopProto(name);

      // Only seed the last-success timestamp on the very first start of
      // a destination. Restarts, re-probes and settings changes preserve
      // the previous timestamp: a host that fails fast must still
      // accumulate enough elapsed time to trip the timeout, and the
      // offline latch must not be re-armed by a restart.
      if (p.lastSuccessMs === 0) p.lastSuccessMs = Date.now();

      p.dest = this._protoDest(name);
      p.exited = false;
      p.failureReason = null;
      p.stderrText = "";
      p.cancellable = new Gio.Cancellable();

      const interval = this._settings.get_int("refresh-interval");

      try {
        // ping translates its per-packet line ("temps=" in French,
        // "Zeit=" in German), which the latency regex cannot match.
        // Force the C locale so the output stays language-independent.
        const launcher = new Gio.SubprocessLauncher({
          flags:
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv("LC_ALL", "C", true);
        p.proc = launcher.spawnv([
          "ping",
          PROTO_FLAG[name],
          "-i", String(interval),
          "-W", String(PING_REPLY_WAIT_SEC),
          "-s", "16",
          p.dest,
        ]);

        p.stream = new Gio.DataInputStream({
          base_stream: p.proc.get_stdout_pipe(),
        });
        p.errStream = new Gio.DataInputStream({
          base_stream: p.proc.get_stderr_pipe(),
        });

        this._readPipe(name, p.stream, true);
        this._readPipe(name, p.errStream, false);
        p.proc.wait_async(p.cancellable, (proc, result) =>
          this._onProcExit(name, proc, result),
        );
      } catch (e) {
        console.error(`Ping Indicator++: failed to start ping (${name})`, e);
        p.proc = null;
        p.exited = true;
        p.lastRetryMs = Date.now();
        p.failureReason = "Error";
        this._updateLabel();
      }
    }

    _readPipe(name, stream, isStdout) {
      const p = this._protos[name];
      const isCurrent = () =>
        isStdout ? p.stream === stream : p.errStream === stream;
      stream.read_line_async(
        GLib.PRIORITY_DEFAULT,
        p.cancellable,
        (s, result) => {
          let line;
          try {
            [line] = s.read_line_finish(result);
          } catch (_e) {
            return;
          }
          if (!isCurrent()) return;
          if (line === null) {
            if (isStdout) {
              p.stream = null;
            } else {
              p.errStream = null;
              // GLib does not order the child-watch source against
              // pipe readability, so the exit callback can win the
              // race and classify from partial stderr. Re-classify
              // now that stderr is complete.
              if (p.exited) {
                p.failureReason = classifyStderr(p.stderrText);
                this._updateLabel();
              }
            }
            return;
          }

          const text = new TextDecoder().decode(line);

          if (isStdout) {
            this._onStdoutLine(name, text);
          } else if (p.stderrText.length < 4096) {
            p.stderrText = `${p.stderrText}${text}\n`;
          }

          this._readPipe(name, s, isStdout);
        },
      );
    }

    _onStdoutLine(name, text) {
      const p = this._protos[name];
      if (stdoutUnreachable(text)) p.failureReason = "Unreachable";

      const match = text.match(/time[=<](\d+(?:\.\d+)?)\s*ms/);
      if (match) {
        p.lastLatencyMs = parseFloat(match[1]);
        p.lastSuccessMs = Date.now();
        p.failureReason = null;
        this._clearFullError();
        this._updateLabel();
      }
      // A missed packet is not an outage. The watchdog decides that,
      // so the bar does not flicker on a single lost reply.
    }

    _onProcExit(name, proc, result) {
      try {
        proc.wait_finish(result);
      } catch (_e) {
        return;
      }
      const p = this._protos[name];
      if (!p || p.proc !== proc) return;
      p.proc = null;
      // Deliberately keep p.stream / p.errStream: GLib does not order
      // the child-watch source against pipe readability, so buffered
      // output (including the stderr we classify from) may still be in
      // flight. Dropping the references here would make isCurrent()
      // reject those reads and freeze the reason at whatever partial
      // text had arrived. The EOF handlers null them out.
      p.exited = true;
      p.lastRetryMs = Date.now();
      p.failureReason = classifyStderr(p.stderrText);
      this._updateLabel();
    }

    _checkWatchdog() {
      const now = Date.now();
      const timeoutMs = this._settings.get_int("failure-timeout") * 1000;
      const retryMs = this._settings.get_int("retry-interval") * 1000;

      let anyActive = false;
      let allDown = true;

      for (const name of PROTO_NAMES) {
        if (!this._isActive(name)) continue;
        anyActive = true;
        const p = this._protos[name];

        if (p.exited && p.proc === null && now - p.lastRetryMs >= retryMs) {
          this._startProto(name);
        }

        // A protocol counts as down for the offline latch only once its
        // grace window has elapsed since its last success (or first
        // start). Hard failures exit instantly, but the latch waits
        // anyway so login and resume do not beep before the network
        // has had a chance to come up. The latch itself is only ever
        // cleared by a real reply, so re-probes cannot flap it.
        if (now - p.lastSuccessMs <= timeoutMs) allDown = false;
      }

      if (!anyActive) {
        // Nothing is monitored: never alert, and release a latch left
        // from before the destinations were cleared.
        this._clearFullError();
      } else if (allDown) {
        this._setFullError();
      }
      this._updateLabel();
    }

    _setFullError() {
      if (this._fullError) return;
      this._fullError = true;
      this._applyErrorStyle(false);

      if (this._settings.get_boolean("beep-when-timeout")) {
        const file = Gio.File.new_for_path(SOUND_FILE_PATH);
        if (file.query_exists(null)) {
          global.display
            .get_sound_player()
            .play_from_file(file, "Ping Indicator++ Offline", null);
        }
      }
    }

    _clearFullError() {
      if (!this._fullError) return;
      this._fullError = false;
      this._clearErrorStyle();
    }

    _onSettingsChanged(key) {
      if (RESTART_KEYS.includes(key)) {
        this._restart();
        return;
      }
      if (this._fullError && COLOR_KEYS.includes(key)) {
        this._clearErrorStyle();
        this._applyErrorStyle(false);
      }
      this._updateLabel();
    }

    _restart() {
      for (const name of PROTO_NAMES) {
        const p = this._protos[name];
        const started = p.proc !== null || p.exited;
        const stillActive = this._isActive(name);
        const sameDest = p.dest === this._protoDest(name);
        this._stopProto(name);
        // Preserve timing state for protocols that keep running
        // against the same destination; reset for destination changes
        // and for protocols that were off, so reactivation gets a
        // fresh grace window instead of a stale timestamp.
        if (!stillActive || !sameDest || !started) {
          this._protos[name] = this._newProtoState();
        }
      }
      for (const name of PROTO_NAMES) {
        if (this._isActive(name)) this._startProto(name);
      }
      this._updateLabel();
    }

    _updateLabel() {
      this._updateMenu();
      const now = Date.now();
      const timeoutMs = this._settings.get_int("failure-timeout") * 1000;
      const names = PROTO_NAMES.filter((n) => this._isActive(n));

      if (names.length === 0) {
        this._setStatus([{ text: "--" }]);
        return;
      }

      const isDown = (name) => {
        const p = this._protos[name];
        return p.exited || now - p.lastSuccessMs > timeoutMs;
      };
      const reasonOf = (name) => this._protos[name].failureReason ?? "Timeout";

      if (!this._settings.get_boolean("show-protocol-status")) {
        const healthy = names.find(
          (n) => !isDown(n) && this._protos[n].lastLatencyMs !== null,
        );
        if (healthy !== undefined) {
          this._setStatus([
            { text: `${Math.round(this._protos[healthy].lastLatencyMs)} ms` },
          ]);
        } else {
          const down = names.find((n) => isDown(n));
          this._setStatus([
            { text: down !== undefined ? reasonOf(down) : "..." },
          ]);
        }
        return;
      }

      const parts = [];
      for (const name of names) {
        if (parts.length > 0) parts.push({ text: " " });
        const p = this._protos[name];
        if (isDown(name)) {
          parts.push({ text: `${name} ${reasonOf(name)}` });
          parts.push({ icon: ICON_DOWN });
        } else if (p.lastLatencyMs === null) {
          parts.push({ text: `${name} ...` });
        } else {
          parts.push({ text: `${name} ${Math.round(p.lastLatencyMs)}ms` });
        }
      }
      this._setStatus(parts);
    }

    _updateMenu() {
      const now = Date.now();
      const timeoutMs = this._settings.get_int("failure-timeout") * 1000;
      const retryMs = this._settings.get_int("retry-interval") * 1000;

      for (const name of PROTO_NAMES) {
        const row = this._menuRows[name];
        if (!row) continue;
        const p = this._protos[name];

        let text;
        if (!this._isActive(name)) {
          text = this._modeIncludes(name)
            ? `${PROTO_LABEL[name]}: no destination set`
            : `${PROTO_LABEL[name]}: off (mode)`;
        } else if (p.exited) {
          const retryIn = Math.max(
            0,
            Math.ceil((retryMs - (now - p.lastRetryMs)) / 1000),
          );
          text = `${PROTO_LABEL[name]}: down - ${p.failureReason ?? "Error"}, retry in ${retryIn} s`;
        } else if (now - p.lastSuccessMs > timeoutMs) {
          text = `${PROTO_LABEL[name]}: down - ${p.failureReason ?? "Timeout"}`;
        } else if (p.lastLatencyMs === null) {
          text = `${PROTO_LABEL[name]}: waiting for reply...`;
        } else {
          text = `${PROTO_LABEL[name]}: ${Math.round(p.lastLatencyMs)} ms`;
        }

        if (row.label.text !== text) row.label.set_text(text);
      }
    }

    _setStatus(parts) {
      // Skip the rebuild when nothing changed: replacing the panel
      // actors on every watchdog tick produces a visible flicker.
      const key = parts.map((part) => part.icon ?? part.text).join("\0");
      if (key === this._statusKey) return;
      this._statusKey = key;
      this._statusBox.destroy_all_children();
      for (const part of parts) {
        if (part.icon) {
          this._statusBox.add_child(
            new St.Icon({
              icon_name: part.icon,
              icon_size: 16,
              y_align: Clutter.ActorAlign.CENTER,
              style: "margin-left: 6px;",
            }),
          );
        } else {
          this._statusBox.add_child(
            new St.Label({
              text: part.text,
              y_align: Clutter.ActorAlign.CENTER,
            }),
          );
        }
      }
    }

    _applyErrorStyle(force) {
      if (!this._fullError) return;
      if (!this._settings.get_boolean("enable-color-on-failure")) return;

      const color = this._settings.get_string("color-on-failure");
      // Skip the write if the style is already correct. `force`
      // bypasses the cache for the overview-hidden case, where GNOME
      // Shell cleared our inline style behind our back.
      if (!force && this._appliedColor === color) return;
      this._appliedColor = color;
      Main.panel.set_style(`background-color: ${color};`);
    }

    _clearErrorStyle() {
      if (this._appliedColor === null) return;
      this._appliedColor = null;
      Main.panel.set_style(null);
    }

    _stopProto(name) {
      const p = this._protos[name];
      if (!p) return;
      if (p.cancellable) {
        p.cancellable.cancel();
        p.cancellable = null;
      }
      if (p.proc) {
        let proc = p.proc;
        p.proc = null;
        proc.force_exit();
      }
      p.stream = null;
      p.errStream = null;
    }

    destroy() {
      // Sources first, then signals, then child processes, so a
      // callback cannot restart work while teardown is in progress.
      if (this._watchdogId) {
        GLib.source_remove(this._watchdogId);
        this._watchdogId = null;
      }
      if (this._reapplyTimeoutId) {
        GLib.source_remove(this._reapplyTimeoutId);
        this._reapplyTimeoutId = null;
      }
      this._settings.disconnectObject(this);
      Main.overview.disconnectObject(this);
      for (const name of PROTO_NAMES) this._stopProto(name);
      this._clearErrorStyle();
      this._fullError = false;

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
