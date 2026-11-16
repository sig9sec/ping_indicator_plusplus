UUID = ping_indicator_plusplus@info.sig9.ch
ZIP = $(UUID).zip

DOMAIN = gnome-shell-extension-pingindicatorplusplus
PO_FILES = $(wildcard po/*.po)
MO_FILES = $(PO_FILES:po/%.po=locale/%/LC_MESSAGES/$(DOMAIN).mo)

ZIP_SOURCES = \
	extension.js \
	prefs.js \
	failureClassifier.js \
	metadata.json \
	schemas/org.gnome.shell.extensions.pingindicatorplusplus.gschema.xml \
	exclude.lst

all: $(ZIP)

$(ZIP): $(ZIP_SOURCES) $(MO_FILES) schemas/gschemas.compiled
	rm -f $@
	zip -r $@ . -x@exclude.lst

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.pingindicatorplusplus.gschema.xml
	glib-compile-schemas schemas/

locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt --check -o $@ $<

pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=N_ --add-comments=Translators \
		--package-name="Ping Indicator++" \
		-o po/$(DOMAIN).pot extension.js prefs.js

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

check:
	glib-compile-schemas --dry-run --strict schemas/
	node --check extension.js prefs.js
	node --test tests/classifier.test.js
	for po in $(PO_FILES); do msgfmt --check -o /dev/null $$po || exit 1; done

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
	rm -rf locale

.PHONY: all clean install check pot
