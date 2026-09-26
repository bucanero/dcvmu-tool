# Changelog

## v1.0.0

The first release.

### Command-line tool

A command-line tool for Sega Dreamcast VMU memory cards, first developed
inside [ps2vmc-tool](https://github.com/bucanero/ps2vmc-tool). The filesystem
is based on FUSE-VMU, reworked to edit the card image in place; DCI and VMI/VMS
support comes from dci4vmi.

- raw 128 KB VMU images, and Nexus `.dcm` dumps
- list, file details with VMS header and CRC check, free space, format, create
- import `.dci` and `.vmi`/`.vms` saves; export to `.dci` and `.vmi`/`.vms`
- raw file extract and inject, remove, rename
- icon frames, eyecatch images and `ICONDATA_VMS` icons as PNG
- animated icons as looping GIFs (`--icon-gif`), ported from vmu2gif, with transparency
- VMU game files, placed contiguously from block 0 as the VMU requires
- tested against a real Nexus card dump (`samples/newvmu.DCM`): 25 files, a VMU game,
  the card icon, a Shift-JIS title, an eyecatch and animated icons
- tested against all 3,383 saves in [dreamcast-saves](https://github.com/bucanero/dreamcast-saves)
  (`DC_SAVES=... make test`): every save imports identically in the CLI and the
  web page, and the icons match vmu2gif's GIFs pixel for pixel
- reads VMIs as other tools wrote them: Planetweb's fixed `ADD@` checksum, and
  timestamps in BCD or with a 0-based month

### Dreamcast VMU Manager (web)

A browser version of `dcvmu-tool`, published at
**[bucanero.github.io/dcvmu-tool](https://bucanero.github.io/dcvmu-tool/)**. Like the PS1
page it is one self-contained file, with a JavaScript port of the CLI's VMU
code that `web/test/dctest.js` checks against the CLI byte for byte.

- animated save icons, and a map of all 256 blocks that highlights a file's blocks
- import `.dci`, `.vmi` + `.vms` (paired by resource name) and raw `.vms`
- export `.dci`, `.vmi` + `.vms`, raw files, animated icon GIFs, icon and eyecatch PNGs
- rename, remove, format, new blank card; download as `.bin` or `.dcm`
- a hex editor for any file, with CRC checking and *Fix CRC*
- links to the PS1 and PS2 memory card tools in ps2vmc-tool
