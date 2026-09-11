import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const MODE_VALUES = ["ipv4", "ipv6", "both"];
const MODE_LABELS = ["IPv4", "IPv6", "Both"];

export default class PingIndicatorPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage();

    // --- General ---
    const general = new Adw.PreferencesGroup({ title: "General" });

    const intervalRow = new Adw.SpinRow({
      title: "Interval, sec.",
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 86400,
        step_increment: 1,
        value: settings.get_int("refresh-interval"),
      }),
    });
    settings.bind(
      "refresh-interval",
      intervalRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    general.add(intervalRow);

    // Failure timeout: max seconds without a successful reply before
    // a protocol counts as down.
    const timeoutRow = new Adw.SpinRow({
      title: "Failure timeout, sec.",
      adjustment: new Gtk.Adjustment({
        lower: 2,
        upper: 3600,
        step_increment: 1,
        value: settings.get_int("failure-timeout"),
      }),
    });
    settings.bind(
      "failure-timeout",
      timeoutRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    general.add(timeoutRow);

    // Smart-retry cadence for protocols whose ping process exited
    // (no route, DNS failure, bad destination).
    const retryRow = new Adw.SpinRow({
      title: "Retry interval, sec.",
      adjustment: new Gtk.Adjustment({
        lower: 5,
        upper: 300,
        step_increment: 5,
        value: settings.get_int("retry-interval"),
      }),
    });
    settings.bind(
      "retry-interval",
      retryRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    general.add(retryRow);

    page.add(general);

    // --- Destinations ---
    const dests = new Adw.PreferencesGroup({ title: "Destinations" });

    const modeRow = new Adw.ComboRow({ title: "Protocol mode" });
    const modeModel = new Gtk.StringList();
    for (const label of MODE_LABELS) modeModel.append(label);
    modeRow.model = modeModel;
    const syncMode = () => {
      const idx = MODE_VALUES.indexOf(settings.get_string("ping-mode"));
      modeRow.selected = idx >= 0 ? idx : MODE_VALUES.indexOf("both");
    };
    syncMode();
    modeRow.connect("notify::selected", () => {
      const value = MODE_VALUES[modeRow.selected];
      if (value !== undefined && settings.get_string("ping-mode") !== value) {
        settings.set_string("ping-mode", value);
      }
    });
    dests.add(modeRow);

    const flushers = [];
    const v4Row = new Adw.EntryRow({
      title: "IPv4 destination, IP or hostname",
    });
    this._bindEntry(settings, v4Row, "ping-destination-v4", flushers);
    dests.add(v4Row);

    const v6Row = new Adw.EntryRow({
      title: "IPv6 destination, IP or hostname",
    });
    this._bindEntry(settings, v6Row, "ping-destination-v6", flushers);
    dests.add(v6Row);

    const syncDestSensitivity = () => {
      const mode = settings.get_string("ping-mode");
      v4Row.sensitive = mode !== "ipv6";
      v6Row.sensitive = mode !== "ipv4";
    };
    syncDestSensitivity();
    settings.connect("changed::ping-mode", () => {
      syncMode();
      syncDestSensitivity();
    });
    page.add(dests);

    // Flush pending destination edits when the dialog goes away:
    // GNOME 47+ uses Adw.Dialog ("closed"), older uses Gtk.Window
    // ("close-request").
    const flushPending = () => {
      for (const flush of flushers) flush();
    };
    try {
      window.connect("closed", flushPending);
    } catch (_e) {
      window.connect("close-request", () => {
        flushPending();
        return false;
      });
    }

    // --- Alerts ---
    const alerts = new Adw.PreferencesGroup({ title: "Alerts" });

    const beepRow = new Adw.SwitchRow({
      title: "Beep signal when offline",
    });
    settings.bind(
      "beep-when-timeout",
      beepRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    alerts.add(beepRow);

    const colorSwitchRow = new Adw.SwitchRow({
      title: "Change color when offline",
    });
    settings.bind(
      "enable-color-on-failure",
      colorSwitchRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    alerts.add(colorSwitchRow);

    const colorRow = new Adw.ActionRow({
      title: "Offline color",
    });
    settings.bind(
      "enable-color-on-failure",
      colorRow,
      "sensitive",
      Gio.SettingsBindFlags.GET,
    );
    const colorButton = new Gtk.ColorDialogButton({
      dialog: new Gtk.ColorDialog(),
    });
    const rgba = new Gdk.RGBA();
    rgba.parse(settings.get_string("color-on-failure"));
    colorButton.rgba = rgba;
    colorButton.connect("notify::rgba", () => {
      const c = colorButton.rgba;
      const hex = `#${Math.round(c.red * 255)
        .toString(16)
        .padStart(2, "0")}${Math.round(c.green * 255)
        .toString(16)
        .padStart(2, "0")}${Math.round(c.blue * 255)
        .toString(16)
        .padStart(2, "0")}`;
      settings.set_string("color-on-failure", hex);
    });
    colorRow.add_suffix(colorButton);
    alerts.add(colorRow);

    page.add(alerts);

    // --- Display ---
    const display = new Adw.PreferencesGroup({ title: "Display" });

    const statusRow = new Adw.SwitchRow({
      title: "Show protocol status",
      subtitle: "Per-protocol latency and up/down markers in the top bar",
    });
    settings.bind(
      "show-protocol-status",
      statusRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    display.add(statusRow);

    page.add(display);

    window.add(page);
  }

  _bindEntry(settings, row, key, flushers) {
    row.set_text(settings.get_string(key));
    let timeoutId = null;

    const write = () => {
      const text = row.get_text();
      if (settings.get_string(key) !== text) {
        settings.set_string(key, text);
      }
    };
    const commit = () => {
      if (timeoutId !== null) {
        GLib.source_remove(timeoutId);
        timeoutId = null;
      }
      write();
    };
    flushers.push(commit);

    // Debounced live persistence: the extension restarts the ping
    // processes when a destination changes, so writing on every
    // keystroke would churn subprocesses.
    const schedule = () => {
      if (timeoutId !== null) GLib.source_remove(timeoutId);
      timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        timeoutId = null;
        write();
        return GLib.SOURCE_REMOVE;
      });
    };

    // Adw.EntryRow implements Gtk.Editable ("changed") since
    // libadwaita 1.6; older versions only get Enter-key commits.
    if (GObject.signal_lookup("changed", Adw.EntryRow.$gtype) !== 0) {
      row.connect("changed", schedule);
    }
    row.connect("entry-activated", commit);
  }
}
