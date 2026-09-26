# DCVMU Tool

[![Downloads](https://img.shields.io/github/downloads/bucanero/dcvmu-tool/total.svg?maxAge=3600)](https://github.com/bucanero/dcvmu-tool/releases)
[![License](https://img.shields.io/github/license/bucanero/dcvmu-tool.svg?maxAge=2592000)](https://github.com/bucanero/dcvmu-tool/blob/main/LICENSE)
[![macOS Linux binaries](https://github.com/bucanero/dcvmu-tool/actions/workflows/build.yml/badge.svg)](https://github.com/bucanero/dcvmu-tool/actions/workflows/build.yml)
[![Windows binaries](https://github.com/bucanero/dcvmu-tool/actions/workflows/build-win.yml/badge.svg)](https://github.com/bucanero/dcvmu-tool/actions/workflows/build-win.yml)
[![Web tool](https://github.com/bucanero/dcvmu-tool/actions/workflows/pages.yml/badge.svg)](https://github.com/bucanero/dcvmu-tool/actions/workflows/pages.yml)
[![Twitter](https://img.shields.io/twitter/follow/dparrino?label=Follow)](https://twitter.com/dparrino)

DCVMU Tool is a command-line application for managing Sega Dreamcast VMU
(Visual Memory Unit) virtual memory cards directly from the PC.

It works on raw 128 KB VMU dumps, as written by emulators such as Flycast and
Redream (`.bin`, `.vmu`), and on Nexus card dumps (`.dcm`), which hold the same
data with every 4-byte group reversed. The byte order is detected from the root
block, so a renamed dump still opens, and a card is saved back in the order it
was read in.

It also runs in the browser, with nothing to install and nothing uploaded &mdash;
the card is read and written locally, and never leaves your machine:

- **[Dreamcast VMU Manager](https://bucanero.github.io/dcvmu-tool/)** &mdash; see [web/README.md](web/README.md).
  It can also play the VMU mini-games on a card, on an emulated VMU.

For PlayStation 2 and PlayStation 1 memory cards, see [ps2vmc-tool](https://github.com/bucanero/ps2vmc-tool).

## Usage

```
DCVMU-TOOL v1.0.0
Copyright (C) 2026 - by Bucanero
based on FUSE-VMU by Ross Meikleham, dci4vmi and vmu2gif

Usage:
./dcvmu-tool <VMU filepath> <command> [<arguments>]

Available commands:
	 --mc-info, -i
	 --mc-free, -f
	 --mc-format
	 --mc-create, -new  (write a new empty card to <VMU filepath>)
	 --list, -ls
	 --file-info, -fi <vmu filename>
	 --icons <vmu filename>  (icons and eyecatch as PNG)
	 --icon-gif, -gif <vmu filename> [<output filepath>]  (animated icon)
	 --raw-image, -raw <output filepath>
	 --dcm-image, -dcm <output filepath>
	 --extract-file, -x <vmu filename> <output filepath>
	 --inject-file, -in <input filepath> <vmu filename>
	 --remove, -rm <vmu filename>
	 --rename, -mv <vmu filename> <new vmu filename>
	 --import, -imp <save filepath>  (DCI or VMI/VMS)
	 --dci-export, -dci <vmu filename> <output filepath>
	 --vmi-export, -vmi <vmu filename> <output basename>  (writes .VMI and .VMS)
```

VMU files have no directories: each is addressed by its name on the card, up to
12 characters, as `--list` shows it.

### Save formats

- **`.DCI`** (Nexus) &mdash; the file's 32-byte directory entry followed by its
  blocks, so the name, type, copy protection and date travel with it. This is
  the one to use for keeping saves.
- **`.VMI` + `.VMS`** &mdash; the pair the Dreamcast web browser downloads. The
  `.VMS` is the file itself; the `.VMI` names it and carries its VMU file name,
  date and flags. `--import` takes the `.VMI` and finds the `.VMS` next to it
  through the resource name. `--vmi-export` writes both, and uses the base name
  as the resource name, which has room for 8 characters. VMIs written by other
  tools are read as they are found in the wild: the Planetweb browser's fixed
  `ADD@` checksum is accepted, and timestamps written in BCD, or with a
  0-based month, are read as meant rather than as binary.
- **Raw** &mdash; `--extract-file` and `--inject-file` move the bare blocks.
  A raw file carries no metadata, so an injected file is always a data file
  dated now; a plain `.VMS` with no `.VMI` goes in this way.

Game files (VMU minigames) are supported: the VMU runs them in place, so one is
stored contiguously from block 0, and a card holds at most one.

`--file-info` decodes a file's VMS header and checks its CRC, telling a wrong
CRC from one the game never filled in (stored as `0000`). Descriptions are
Shift-JIS: `--list` and `--file-info` show full-width letters, digits and
punctuation as plain ASCII, and kana and kanji as `?`. `--icons` writes
each icon frame, and the eyecatch image if there is one, as PNG; for
`ICONDATA_VMS` it writes the card's monochrome and colour icons.

Dreamcast icons are usually animations, so `--icon-gif` writes one as a looping
GIF, the way [vmu2gif](https://github.com/bucanero/vmu2gif) does: one frame per
icon, each shown for the header's animation speed times 4 hundredths of a
second. Palette entries that are transparent stay transparent in the GIF. The
file is named after the VMU file unless an output path is given.

## Building the source code

```
make
```

There are no dependencies beyond a C compiler: PNGs are written with the
header-only [svpng](https://github.com/miloyip/svpng) and GIFs by the tool
itself. The Windows binaries are cross-compiled on Linux with mingw-w64:

```
make CC=x86_64-w64-mingw32-gcc EXE=.exe
```

`make test` (it needs Node) runs the web page's VMU engine against the CLI,
byte for byte, over the sample cards in `samples/`. Pointed at a collection of
`.VMI`/`.VMS` saves, it also runs every one of them through both, e.g. a
checkout of [dreamcast-saves](https://github.com/bucanero/dreamcast-saves):

```
DC_SAVES=../dreamcast-saves make test
```

## Credits

- VMU filesystem based on [FUSE-VMU](https://github.com/RossMeikleham/FUSE-VMU) by [Ross Meikleham](https://github.com/RossMeikleham) (MIT License), which also provides the sample card `samples/dcvmu.bin` and the `.dci` samples
- DCI and VMI/VMS support from [dci4vmi](https://github.com/bucanero/dci4vmi)
- Animated GIF icons from [vmu2gif](https://github.com/bucanero/vmu2gif), whose LZW encoder is GIFSAVE by Sverre H. Huseby
- VMS header layout from [Marcus Comstedt's Dreamcast documentation](http://mc.pp.se/dc/)
- Byte helpers (`src/util.c`) from ps3mca-tool by jimmikaelkael, by way of [ps2vmc-tool](https://github.com/bucanero/ps2vmc-tool)
- VMU emulator in the web page ported from SoftVMS 1.10 by [Marcus Comstedt](http://mc.pp.se/dc/), which [vmucd](https://github.com/bucanero/vmucd) is also based on; its `cpu.c` is kept unmodified in `web/test/softvms/` as the reference the port is tested against
- PNG export with [svpng](https://github.com/miloyip/svpng) by Milo Yip (BSD-style license, in `include/svpng.h`)

## License

This software is licensed under GNU GPLv3, please review the [LICENSE](https://github.com/bucanero/dcvmu-tool/blob/main/LICENSE)
file for further details. No warranty provided.
