# Dreamcast VMU Manager (web)

A single-page, browser-based version of `dcvmu-tool`, published at
<https://bucanero.github.io/dcvmu-tool/>. It opens Sega Dreamcast VMU
memory card images, lists and previews the files on them, imports and exports
individual saves, and writes the card back out as a raw image or a Nexus dump.

Everything happens locally in the page — no server, no upload, no build step, no
dependencies. The whole app is one self-contained `index.html`.

## Running it

**Option 1 — just open the file**

Double-click `web/index.html`, or drag it onto a browser window.

**Option 2 — serve it locally** (needed only if your browser restricts `file://` pages)

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/web/index.html>.

## What it does

| CLI command | Web equivalent |
| --- | --- |
| `--mc-info`, `--mc-free` | Counters at the top of an open card, and the custom VMU colour if set |
| `--list` | The file grid, plus a map of all 256 blocks |
| `--file-info` | The grid card: descriptions, type, size, date, copy protection, CRC check |
| `--icons` | *Export ▾ → Icon frames / Eyecatch (.png)* |
| `--icon-gif` | *Export ▾ → Animated icon (.gif)* — byte-identical to the CLI's |
| `--dci-export`, `--vmi-export`, `--extract-file` | *Export ▾* on any file |
| `--import` | *Import save…*, or drop saves onto an open card |
| `--inject-file` | Import a `.vms` on its own; the page asks for the VMU file name |
| `--rename`, `--remove` | *Rename*, *Remove* on a file |
| `--mc-create`, `--mc-format` | *New blank card*, *Format card* |
| `--raw-image`, `--dcm-image` | *Download card ▾* |
| *(not in the CLI)* | *Hex* — edit a file's bytes in place |
| *(not in the CLI)* | *Fix CRC* — shown on a data file whose CRC does not match |

Hovering a file highlights the blocks it occupies in the block map.

### Formats

- **Cards:** raw 128 KB images (`.bin`, `.vmu`, as Flycast and Redream write them)
  and Nexus `.dcm` dumps. The byte order is detected from the root block, so a
  renamed `.dcm` still opens.
- **Saves:** `.dci` (Nexus), `.vmi` + `.vms` (the Dreamcast web browser's pair) and
  raw `.vms`. A `.vmi` names its `.vms` through an 8-character resource name, so
  pick or drop both files together; they are paired up by that name.

Icons are drawn from each file's VMS header, animated with the same frame time
the exported GIF carries (vmu2gif's: the header's speed times 4 hundredths of a
second), and `ICONDATA_VMS` shows the card's own icon. Descriptions are decoded
from Shift-JIS where the browser supports it.

## Hex editor and CRC

*Hex* opens the byte editor (`web/hexedit.js`, inlined into the page; the same
module ps2vmc-tool's pages use) over the file's blocks — exactly what `--extract-file` writes. Edits go
back into the blocks the file already occupies, so its size and FAT chain never
change.

Data files carry a CRC-16 over their header and payload, which games may check.
Editing the bytes usually breaks it: the page says so after saving, marks the
file *CRC mismatch*, and *Fix CRC* recomputes and stores it. Game files have no
CRC.

Not every save keeps it up to date, and those still load. On
`samples/newvmu.DCM`, three saves store `0000` — the game or cheat tool never
filled it in — and show as *no CRC*, with no fix offered; Soldier of Fortune
stores a stale value, and shows as a mismatch. `--file-info` makes the same
distinction: *not set* against *does not match*.

## Tests

`make test` (or `node web/test/dctest.js` after `make`) runs the page's engine under Node
and compares it with the CLI byte for byte: every export, card images after the
same imports, renames and removals, icon pixels against `--icons`, icon GIFs
against `--icon-gif` (and decoded frame by frame by a separate GIF reader), the damaged-card
handling, and that the inlined hex editor has not drifted from the shared module.
The build workflow runs it on every push. With `DC_SAVES` set to a directory of
`.VMI`/`.VMS` saves it also imports and exports every one of them through both
the page and the CLI.

## Credits

Ported from `dcvmu-tool` in this repository; first developed inside
[ps2vmc-tool](https://github.com/bucanero/ps2vmc-tool). The VMU filesystem is based on
[FUSE-VMU](https://github.com/RossMeikleham/FUSE-VMU) by Ross Meikleham, and the DCI
and VMI/VMS handling on [dci4vmi](https://github.com/bucanero/dci4vmi); the animated GIF
export comes from [vmu2gif](https://github.com/bucanero/vmu2gif). GPLv3, same as
the rest of this repository.
