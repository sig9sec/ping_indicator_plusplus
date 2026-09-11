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
// Watchdog checks the last-success timestamps this often.
const WATCHDOG_INTERVAL_SEC = 1;
// Per-packet reply wait passed to ping via -W (seconds). Keeps ping
// from blocking for a long time on silent hosts.
const PING_REPLY_WAIT_SEC = 1;

const PROTO_NAMES = ["v4", "v6"];
const PROTO_FLAG = { v4: "-4", v6: "-6" };
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
    _init(ext) {
      super._init(0.0, "Ping Indicator++", false);

      this._ext = ext;
      this._settings = ext.getSettings();
      this._protos = {
        v4: this._newProtoState(),
        v6: this._newProtoState(),
      };
      this._watchdogId = null;
      this._reapplyTimeoutId = null;
      this._fullError = false;
      this._destroyed = false;
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

      this._settings.connectObject(
        "changed",
        (settings, key) => this._onSettingsChanged(key),
        this,
      );

      // GNOME Shell applies `#panel:overview { background-color:
      // transparent }` during overview transitions, which overrides
      // our inline style. Re-apply our error color after any overview
      // transition completes, if we're still in error state. We use a
      // 0ms timeout to defer the re-apply past GNOME Shell's own
      // transition styling. The source ID is tracked and removed in
      // destroy() to satisfy the EGO-L-004 lint rule.
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
        stream: null, // stdout DataInputStream
        errStream: null, // stderr DataInputStream
        cancellable: null,
        stderrText: "",
        dest: null,
        // Timestamp of the last successful reply (or of the very first
        // start). Seeded only once per destination; restarts and
        // re-probes deliberately preserve it so the grace window is
        // not re-armed while a protocol is already known to be down.
        lastSuccessMs: 0,
        lastLatencyMs: null,
        // Informational failure reason; recorded as soon as a failure
        // is observed. Displayed when the protocol shows as down.
        failureReason: null,
        // True once the ping process exited or failed to spawn; the
        // watchdog re-probes on the retry-interval cadence.
        exited: false,
        lastRetryMs: 0,
      };
    }

    _protoDest(name) {
      return this._settings.get_string(`ping-destination-${name}`).trim();
    }

    _isActive(name) {
      const mode = this._settings.get_string("ping-mode");
      return (mode === "both" || mode === name) && this._protoDest(name) !== "";
    }

    _startProto(name) {
      if (this._destroyed || !this._isActive(name)) return;
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
        p.proc = new Gio.Subprocess({
          argv: [
            // ping translates its per-packet output ("temps=" in French,
            // "Zeit=" in German, ...), which the regex in _onStdoutLine
            // cannot match. Force the C locale so parsing stays
            // language-independent.
            "env", "LC_ALL=C",
            "ping",
            PROTO_FLAG[name],
            "-i", String(interval),
            "-W", String(PING_REPLY_WAIT_SEC),
            "-s", "16",
            p.dest,
          ],
          flags:
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        p.proc.init(null);

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
      // Ignore lines from a pipe that is no longer current (the proto
      // was restarted or torn down while the read was in flight).
      const isCurrent = () =>
        isStdout ? p.stream === stream : p.errStream === stream;
      stream.read_line_async(
        GLib.PRIORITY_DEFAULT,
        p.cancellable,
        (s, result) => {
          if (this._destroyed || !isCurrent()) return;
          try {
            let [line] = s.read_line_finish(result);
            if (line === null) {
              // EOF on this pipe. wait_async() is the authoritative
              // process-death signal, so just stop reading.
              if (isStdout) p.stream = null;
              else p.errStream = null;
              return;
            }

            const text = new TextDecoder().decode(line);

            if (isStdout) {
              this._onStdoutLine(name, text);
            } else if (p.stderrText.length < 4096) {
              p.stderrText = `${p.stderrText}${text}\n`;
            }

            this._readPipe(name, s, isStdout);
          } catch (_e) {
            // Cancelled or stream closed, clean up
            try {
              s.close(null);
            } catch (__e) {
              /* already closed */
            }
          }
        },
      );
    }

    _onStdoutLine(name, text) {
      const p = this._protos[name];
      const match = text.match(/time[=<](\d+(?:\.\d+)?)\s*ms/);
      if (match) {
        p.lastLatencyMs = parseFloat(match[1]);
        p.lastSuccessMs = Date.now();
        p.failureReason = null;
        this._clearFullError();
        this._updateLabel();
      }
      // Per-packet timeout / unreachable lines are handled by the
      // watchdog via the lastSuccess timestamp; we don't toggle the
      // error style on individual failed packets to avoid flicker.
    }

    _onProcExit(name, proc, result) {
      if (this._destroyed) return;
      const p = this._protos[name];
      if (!p || p.proc !== proc) return;
      try {
        proc.wait_finish(result);
      } catch (_e) {
        // Cancelled during teardown; ignore.
        return;
      }
      p.proc = null;
      p.stream = null;
      p.errStream = null;
      p.exited = true;
      p.lastRetryMs = Date.now();
      // Provisional reason; the failure classifier refines this from
      // the collected stderr text.
      p.failureReason = "Error";
      this._updateLabel();
    }

    _checkWatchdog() {
      if (this._destroyed) return;
      const now = Date.now();
      const timeoutMs = this._settings.get_int("failure-timeout") * 1000;
      const retryMs = this._settings.get_int("retry-interval") * 1000;

      let anyActive = false;
      let allDown = true;

      for (const name of PROTO_NAMES) {
        if (!this._isActive(name)) continue;
        anyActive = true;
        const p = this._protos[name];

        // Smart retry: re-probe hard-failed protocols on the retry
        // cadence instead of respawning every second. The proc guard
        // prevents double spawns while a probe is in flight.
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

      if (anyActive && allDown) this._setFullError();
      this._updateLabel();
    }

    _setFullError() {
      if (this._fullError) return;
      this._fullError = true;
      this._applyErrorStyle(false);

      if (this._settings.get_boolean("beep-when-timeout")) {
        try {
          let player = global.display.get_sound_player();
          let file = Gio.File.new_for_path(SOUND_FILE_PATH);
          player.play_from_file(file, "Ping Indicator++ Offline", null);
        } catch (_e) {
          /* ignore */
        }
      }
    }

    _clearFullError() {
      if (!this._fullError) return;
      this._fullError = false;
      this._clearErrorStyle();
    }

    _onSettingsChanged(key) {
      if (this._destroyed) return;
      if (RESTART_KEYS.includes(key)) {
        this._restart();
        return;
      }
      // Refresh the error style in place when color settings change
      // while we are latched: no process restart, no re-beep.
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
      if (this._destroyed) return;
      const now = Date.now();
      const timeoutMs = this._settings.get_int("failure-timeout") * 1000;
      const names = PROTO_NAMES.filter((n) => this._isActive(n));

      if (names.length === 0) {
        this._setText("--");
        return;
      }

      // A protocol shows as down once it is known dead (process exit)
      // or its grace window since the last success has elapsed.
      const isDown = (name) => {
        const p = this._protos[name];
        return p.exited || now - p.lastSuccessMs > timeoutMs;
      };
      const reasonOf = (name) => this._protos[name].failureReason ?? "Timeout";

      if (!this._settings.get_boolean("show-protocol-status")) {
        // Legacy single-value style: latency of the first healthy
        // protocol (v4 preferred), or the failure reason once all
        // active protocols are down.
        const healthy = names.find(
          (n) => !isDown(n) && this._protos[n].lastLatencyMs !== null,
        );
        if (healthy !== undefined) {
          this._setText(`${Math.round(this._protos[healthy].lastLatencyMs)} ms`);
        } else {
          const down = names.find((n) => isDown(n));
          this._setText(down !== undefined ? reasonOf(down) : "...");
        }
        return;
      }

      const single = names.length === 1;
      const parts = names.map((name) => {
        const p = this._protos[name];
        if (isDown(name)) {
          // In single-protocol mode show the reason; in both mode the
          // reason lives in the popup menu to keep the bar compact.
          return single ? `${name} ${reasonOf(name)} ⛔` : `${name} ⛔`;
        }
        if (p.lastLatencyMs === null) return `${name} ...`;
        return `${name} ${Math.round(p.lastLatencyMs)}ms ✅`;
      });
      this._setText(parts.join(" "));
    }

    _setText(text) {
      // Skip the write when the text is unchanged: repeatedly setting
      // the same string causes St to re-evaluate and re-render the
      // panel actor, which produces a visible flicker.
      if (this._buttonText.text !== text) this._buttonText.set_text(text);
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

    _stopAll() {
      if (this._watchdogId) {
        GLib.source_remove(this._watchdogId);
        this._watchdogId = null;
      }
      if (this._reapplyTimeoutId) {
        GLib.source_remove(this._reapplyTimeoutId);
        this._reapplyTimeoutId = null;
      }
      for (const name of PROTO_NAMES) this._stopProto(name);
    }

    destroy() {
      this._destroyed = true;
      this._stopAll();
      this._clearErrorStyle();
      this._fullError = false;

      this._settings.disconnectObject(this);
      Main.overview.disconnectObject(this);

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
