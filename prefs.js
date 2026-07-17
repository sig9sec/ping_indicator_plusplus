import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class PingIndicatorPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup();

    // Interval
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
    group.add(intervalRow);

    // Destination
    const destRow = new Adw.EntryRow({
      title: "Destination, IP or URL",
    });
    destRow.set_text(settings.get_string("ping-destination"));
    destRow.connect("entry-activated", () => {
      settings.set_string("ping-destination", destRow.get_text());
    });
    group.add(destRow);

    // Beep on timeout
    const beepRow = new Adw.SwitchRow({
      title: "Beep signal when timeout",
    });
    settings.bind(
      "beep-when-timeout",
      beepRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(beepRow);

    page.add(group);
    window.add(page);
  }
}
