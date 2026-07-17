UUID = ping_indicator_plusplus@info.sig9.ch
ZIP = $(UUID).zip

all: $(ZIP)

$(ZIP): schemas/gschemas.compiled
	zip -r $@ . -x@exclude.lst

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.pingindicatorplusplus.gschema.xml
	glib-compile-schemas schemas/

clean:
	rm -f $(ZIP) schemas/gschemas.compiled

.PHONY: all clean
