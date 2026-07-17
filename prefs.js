import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
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

    // Failure timeout: max seconds without a successful reply before
    // the extension considers the connection down.
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
    group.add(timeoutRow);

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

    // Color on failure
    const colorSwitchRow = new Adw.SwitchRow({
      title: "Change color on failure",
    });
    settings.bind(
      "enable-color-on-failure",
      colorSwitchRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(colorSwitchRow);

    const colorRow = new Adw.ActionRow({
      title: "Failure color",
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
    group.add(colorRow);

    page.add(group);
    window.add(page);
  }
}
