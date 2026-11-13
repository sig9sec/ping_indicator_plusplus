UUID = ping_indicator_plusplus@info.sig9.ch
ZIP = $(UUID).zip

ZIP_SOURCES = \
	extension.js \
	prefs.js \
	failureClassifier.js \
	metadata.json \
	schemas/org.gnome.shell.extensions.pingindicatorplusplus.gschema.xml \
	exclude.lst

all: $(ZIP)

$(ZIP): $(ZIP_SOURCES) schemas/gschemas.compiled
	rm -f $@
	zip -r $@ . -x@exclude.lst

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.pingindicatorplusplus.gschema.xml
	glib-compile-schemas schemas/

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

check:
	glib-compile-schemas --dry-run --strict schemas/
	node --check extension.js prefs.js
	node --test tests/classifier.test.js

clean:
	rm -f $(ZIP) schemas/gschemas.compiled

.PHONY: all clean install check
