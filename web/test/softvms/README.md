# SoftVMS reference

`cpu.c` and `prototypes.h` are from [SoftVMS](http://mc.pp.se/dc/sw.html) 1.10 by [Marcus Comstedt](https://github.com/zeldin), unmodified. (They are the same in 1.9: 1.10 only changed
the X11 front end's build.) SoftVMS is the VMU emulator the web page's
emulator is ported from; [vmucd](https://github.com/bucanero/vmucd), released
under the GPLv3, is based on an earlier version of the same code.

`ref.c` is a headless front end for it, written for the tests: no display, a
fixed clock, button presses from a script, and the LCD, flash and tones printed
as text. `web/test/dctest.js` builds the two with the system C compiler and
compares the output with what the page's emulator does with the same input.
