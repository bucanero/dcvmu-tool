/*
 * dctest.js - checks the Dreamcast page's VMU engine against dcvmu-tool.
 *
 * The page is a single self-contained file, so its engine is pulled out of
 * the <script> and run under Node. Every export is compared byte for byte
 * with what the CLI writes for the same input, and every edit is applied to
 * both, with the resulting card images compared.
 *
 *     make && node web/test/dctest.js
 *
 * The page's VMU emulator is checked the same way against SoftVMS 1.10, the
 * emulator it was ported from: web/test/softvms/ holds its cpu.c, built here
 * with a headless front end, and both run the same game with the same button
 * presses, comparing the LCD, the flash and the tones slice by slice.
 *
 * With DC_SAVES pointing at a directory of .VMI/.VMS saves, every one of them
 * is also run through both, and every mini-game among them through both
 * emulators, e.g. a checkout of bucanero/dreamcast-saves:
 *
 *     DC_SAVES=../dreamcast-saves node web/test/dctest.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");   /* Node's own, to read the PNGs back */
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "dcvmu-tool");
const SAMPLES = path.join(ROOT, "samples");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dctest-"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? "  — " + detail : "")); }
}

const BEGIN = "/* ===== BEGIN inlined copy of web/hexedit.js";
const END = "/* ===== END inlined copy of web/hexedit.js";

const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];

/* The engine is everything before the inlined editor; the UI after it
 * needs a DOM. */
function loadCore() {
  const core = script.slice(0, script.indexOf(BEGIN));
  const tmp = path.join(TMP, "dccore.js");
  fs.writeFileSync(tmp, core + "\nmodule.exports = { VMU, VMS };\n");
  return require(tmp);
}

function cli(...args) {
  return execFileSync(CLI, args, { cwd: TMP, encoding: "latin1" });
}
const tmp = n => path.join(TMP, n);
const read = n => new Uint8Array(fs.readFileSync(tmp(n)));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* What --file-info should say about a data file's CRC, from the page's view */
const crcVerdict = f => f.crcUnset ? "(not set)" : f.crcOk === null ? "(can't check" : f.crcOk ? "(valid)" : "(does not match)";

/* The root block's format timestamp is "now", so it can never match */
function sameCard(a, b) {
  const x = a.slice(), y = b.slice();
  x.fill(0, 255 * 512 + 0x30, 255 * 512 + 0x38);
  y.fill(0, 255 * 512 + 0x30, 255 * 512 + 0x38);
  return same(x, y);
}

/* Enough of a PNG reader to get RGBA pixels back out of the CLI's icons */
function readPng(file) {
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8);
    const body = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); }
    if (type === "IDAT") idat.push(body);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const c = (x >= 4 && y) ? out[(y - 1) * stride + x - 4] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, px: out };
}

/* A minimal game file: header at block 1, as a VMU minigame has it */
function makeGameDci() {
  const hdr = new Uint8Array(32);
  hdr[0] = 0xcc;
  "MINIGAME.VMS".split("").forEach((c, i) => { hdr[4 + i] = c.charCodeAt(0); });
  hdr.set([0x19, 0x99, 0x09, 0x09, 0x12, 0x00, 0x00, 0x03], 0x10);
  hdr[0x18] = 4; hdr[0x1a] = 1;
  const body = new Uint8Array(4 * 512);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
  body.fill(0x20, 512, 512 + 0x30);
  body[512 + 0x40] = 1; body[512 + 0x41] = 0;
  body[512 + 0x44] = 0; body[512 + 0x45] = 0;
  const sw = body.slice();
  for (let i = 0; i < sw.length; i += 4) sw.subarray(i, i + 4).reverse();
  const out = new Uint8Array(32 + sw.length);
  out.set(hdr); out.set(sw, 32);
  return out;
}

/* An independent GIF reader: global palette, frames and their GCE fields,
 * enough to check what the encoder wrote without trusting its own code. */
function readGif(b) {
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
  const flags = b[10], ncol = 2 << (flags & 7);
  const pal = b.subarray(13, 13 + ncol * 3);
  let o = 13 + ((flags & 0x80) ? ncol * 3 : 0);
  const frames = [];
  let gce = null, loop = false;
  while (o < b.length) {
    const t = b[o++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[o++];
      const blocks = [];
      while (b[o]) { blocks.push(b.subarray(o + 1, o + 1 + b[o])); o += 1 + b[o]; }
      o++;
      if (label === 0xf9) gce = { flags: blocks[0][0], delay: blocks[0][1] | (blocks[0][2] << 8), trans: blocks[0][3] };
      if (label === 0xff && String.fromCharCode(...blocks[0]) === "NETSCAPE2.0") loop = true;
      continue;
    }
    if (t !== 0x2c) throw new Error("bad block 0x" + t.toString(16) + " at " + (o - 1));
    o += 9;
    const mcs = b[o++];
    const data = [];
    while (b[o]) { data.push(...b.subarray(o + 1, o + 1 + b[o])); o += 1 + b[o]; }
    o++;
    /* LZW decode */
    const clear = 1 << mcs, eoi = clear + 1;
    let size = mcs + 1, dict = [], bitpos = 0, prev = null;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict.push([i]); dict.push(null, null); size = mcs + 1; prev = null; };
    reset();
    const px = [];
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bitpos++) code |= ((data[bitpos >> 3] >> (bitpos & 7)) & 1) << i;
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      let entry = code < dict.length ? dict[code] : prev.concat(prev[0]);
      px.push(...entry);
      if (prev) dict.push(prev.concat(entry[0]));
      prev = entry;
      if (dict.length === (1 << size) && size < 12) size++;
    }
    frames.push({ px, gce });
    gce = null;
  }
  return { w, h, pal, frames, loop };
}

/* A GIF frame as RGBA, transparent pixels as all zeros */
function gifFrameRGBA(g, f) {
  const out = new Uint8Array(g.w * g.h * 4);
  f.px.forEach((p, i) => {
    if (f.gce && (f.gce.flags & 1) && p === f.gce.trans) return;
    out.set([g.pal[p * 3], g.pal[p * 3 + 1], g.pal[p * 3 + 2], 255], i * 4);
  });
  return out;
}
const flatten = px => { const o = Uint8Array.from(px); for (let i = 0; i < o.length; i += 4) if (o[i + 3] < 0x80) o.fill(0, i, i + 4); else o[i + 3] = 255; return o; };

/* ICONDATA_VMS with a colour icon, or with only the monochrome one */
function makeIcondata(color) {
  const d = new Uint8Array(color ? 0x20 + 128 + 32 + 512 : 0x20 + 128);
  "CARD ICON".split("").forEach((c, i) => { d[i] = c.charCodeAt(0); });
  d[0x10] = 0x20;
  for (let i = 0; i < 128; i++) d[0x20 + i] = (i * 37) & 0xff;
  if (color) {
    d[0x14] = 0xa0;
    for (let i = 0; i < 16; i++) { d[0xa0 + i * 2] = (i * 17) & 0xff; d[0xa0 + i * 2 + 1] = i ? 0xf0 | i : 0x00; }
    for (let i = 0; i < 512; i++) d[0xc0 + i] = (i * 11) & 0xff;
  }
  return d;
}

function main() {
  if (!fs.existsSync(CLI)) { console.error("build the CLI first: make"); process.exit(1); }
  const { VMU, VMS } = loadCore();
  const sample = new Uint8Array(fs.readFileSync(path.join(SAMPLES, "dcvmu.bin")));

  /* ---------- the inlined editor ---------- */
  console.log("\n=== inlined copy vs web/hexedit.js ===");
  const shared = fs.readFileSync(path.join(ROOT, "web", "hexedit.js"), "utf8");
  const b = html.indexOf(BEGIN), e = html.indexOf(END);
  ok("page contains the inlined editor", b >= 0 && e > b);
  if (b >= 0 && e > b) {
    const inlined = html.slice(html.indexOf("*/", b) + 3, e).replace(/\s+$/, "");
    ok("inlined copy is identical to the shared module", inlined === shared.replace(/\s+$/, ""),
       "re-copy web/hexedit.js into web/index.html");
  }

  /* ---------- reading ---------- */
  console.log("\n=== reading samples/dcvmu.bin ===");
  ok("opens", VMU.open(sample, "dcvmu.bin").ok);
  const files = VMU.files();
  const listing = cli(path.join(SAMPLES, "dcvmu.bin"), "--list");
  const cliNames = listing.split("\n").filter(l => /^ \S.* \| (DATA|GAME)/.test(l)).map(l => l.slice(1, 13).trim());
  ok("same files as --list, in the same order", same(files.map(f => f.name), cliNames),
     files.map(f => f.name).join(",") + " vs " + cliNames.join(","));
  const info = cli(path.join(SAMPLES, "dcvmu.bin"), "--mc-info");
  const st = VMU.stats();
  ok("same block counts as --mc-info", info.includes("Used " + st.used + " | Free " + st.free + " | Total " + st.total));

  for (const f of files) {
    const fi = cli(path.join(SAMPLES, "dcvmu.bin"), "--file-info", f.name);
    ok(f.name + ": CRC verdict matches --file-info",
       fi.includes(crcVerdict(f)));
    ok(f.name + ": description matches", fi.includes("DC desc.  : " + f.vms.descDc));
  }

  /* ---------- exports ---------- */
  console.log("\n=== exports vs the CLI ===");
  for (const f of files) {
    cli(path.join(SAMPLES, "dcvmu.bin"), "--dci-export", f.name, "x.dci");
    ok(f.name + ": .dci identical", same(VMU.dciEncode(f.idx), read("x.dci")));

    cli(path.join(SAMPLES, "dcvmu.bin"), "--vmi-export", f.name, "RES");
    const v = VMU.vmiEncode(f.idx, "RES", "DCVMU-TOOL by Bucanero");
    ok(f.name + ": .VMI identical", same(v.vmi, read("RES.VMI")));
    ok(f.name + ": .VMS identical", same(v.vms, read("RES.VMS")));

    cli(path.join(SAMPLES, "dcvmu.bin"), "--extract-file", f.name, "x.raw");
    ok(f.name + ": raw file identical", same(VMU.readFile(f.idx), read("x.raw")));
  }

  const f0 = files[1];
  const out = cli(path.join(SAMPLES, "dcvmu.bin"), "--icons", f0.name);
  for (let i = 0; i < f0.vms.icons; i++) {
    const png = readPng(tmp(f0.name + "_icon" + i + ".png"));
    ok(f0.name + ": icon " + i + " pixels match --icons", same(VMU.iconRGBA(f0.vms, i), png.px));
  }
  ok("--icons wrote them", out.includes("_icon0.png"));

  cli(path.join(SAMPLES, "dcvmu.bin"), "--dcm-image", "x.dcm");
  ok(".dcm image identical", same(VMU.exportCard(true), read("x.dcm")));
  ok(".dcm re-opens as the same card", VMU.open(read("x.dcm"), "renamed.bin").ok &&
     VMU.dcm && same(VMU.exportCard(false), sample));

  /* ---------- edits ---------- */
  console.log("\n=== edits vs the CLI ===");
  const game = makeGameDci();
  fs.writeFileSync(tmp("game.dci"), game);

  VMU.create();
  cli(tmp("card.bin"), "--mc-create");
  ok("a new card matches --mc-create", sameCard(VMU.exportCard(false), read("card.bin")));

  for (const s of ["sa2.dci", "evo.dci"]) {
    const d = VMU.dciDecode(new Uint8Array(fs.readFileSync(path.join(SAMPLES, s))));
    VMU.writeFile(d.ent, d.data);
    cli(tmp("card.bin"), "--import", path.join(SAMPLES, s));
  }
  ok("DCI imports land identically", sameCard(VMU.exportCard(false), read("card.bin")));

  const g = VMU.dciDecode(game);
  VMU.writeFile(g.ent, g.data);
  cli(tmp("card.bin"), "--import", tmp("game.dci"));
  ok("a game file lands identically", sameCard(VMU.exportCard(false), read("card.bin")));
  const gf = VMU.files().find(f => f.filetype === VMU.GAME);
  ok("the game starts at block 0", gf && gf.firstblk === 0 && gf.blocks.join() === "0,1,2,3");
  let refused = false;
  try { VMU.writeFile(Object.assign({}, g.ent, { name: "GAME2" }), g.data); } catch (err) { refused = /game/.test(err.message); }
  ok("a second game is refused", refused);

  /* VMI/VMS: exported by the CLI, imported by both */
  cli(path.join(SAMPLES, "dcvmu.bin"), "--vmi-export", "SONICADV_INT", "SADV");
  const vd = VMU.vmiDecode(read("SADV.VMI"));
  ok("the VMI names its VMS", vd.info.resource === "SADV", JSON.stringify(vd.info.resource));
  ok("and carries the VMU file name", vd.ent.name === "SONICADV_INT", JSON.stringify(vd.ent.name));
  VMU.writeFile(vd.ent, read("SADV.VMS").subarray(0, vd.info.filesize));
  cli(tmp("card.bin"), "--import", tmp("SADV.VMI"));
  ok("VMI/VMS import lands identically", sameCard(VMU.exportCard(false), read("card.bin")));

  VMU.renameFile(VMU.find("EVO_DATA.001"), "RENAMED");
  cli(tmp("card.bin"), "--rename", "EVO_DATA.001", "RENAMED");
  ok("rename matches", sameCard(VMU.exportCard(false), read("card.bin")));

  VMU.deleteFile(VMU.find("SONIC2___S01"));
  cli(tmp("card.bin"), "--remove", "SONIC2___S01");
  ok("remove matches", sameCard(VMU.exportCard(false), read("card.bin")));

  let dup = false;
  try { VMU.writeFile(vd.ent, read("SADV.VMS")); } catch (err) { dup = err.message === VMU.ERR.EXIST; }
  ok("a duplicate name is refused", dup);

  /* hex edit + CRC repair */
  VMU.open(sample, "dcvmu.bin");
  const idx = VMU.find("SONICADV_INT");
  const bytes = VMU.readFile(idx);
  bytes[0x200] ^= 0xff;
  ok("an edit writes back in place", VMU.writeFileData(idx, bytes));
  ok("and breaks the CRC", VMU.files().find(f => f.idx === idx).crcOk === false);
  ok("Fix CRC repairs it", VMU.fixCrc(idx) && VMU.files().find(f => f.idx === idx).crcOk === true);
  ok("a wrong-size edit is refused", !VMU.writeFileData(idx, bytes.subarray(0, 512)));


  /* ---------- animated GIF icons ---------- */
  console.log("\n=== icon GIFs vs the CLI ===");
  VMU.create();
  cli(tmp("gif.bin"), "--mc-create");
  const anim = VMU.dciDecode(new Uint8Array(fs.readFileSync(path.join(SAMPLES, "anim.dci"))));
  VMU.writeFile(anim.ent, anim.data);
  cli(tmp("gif.bin"), "--import", path.join(SAMPLES, "anim.dci"));
  /* one card icon per card: the colour one here, a monochrome-only one on its own card */
  fs.writeFileSync(tmp("icon_color.raw"), makeIcondata(1));
  fs.writeFileSync(tmp("icon_mono.raw"), makeIcondata(0));
  cli(tmp("gif.bin"), "--inject-file", tmp("icon_color.raw"), "ICONDATA_VMS");
  cli(tmp("mono.bin"), "--mc-create");
  cli(tmp("mono.bin"), "--inject-file", tmp("icon_mono.raw"), "ICONDATA_VMS");
  const gifCard = read("gif.bin");

  const gifCases = [[sample, "dcvmu.bin", "SONICADV_INT"], [sample, "dcvmu.bin", "SONIC2___S01"],
                    [gifCard, "gif.bin", "ANIMTEST.VMS"]];
  for (const [card, file, name] of gifCases) {
    VMU.open(card, file);
    const f = VMU.files().find(x => x.name === name);
    cli(file === "gif.bin" ? tmp(file) : path.join(SAMPLES, file), "--icon-gif", name, "x.gif");
    const js = VMU.iconGif(f.vms), c = read("x.gif");
    ok(name + ": .gif identical to --icon-gif", same(js, c));

    const g = readGif(c);
    ok(name + ": " + f.vms.icons + " frame(s), 32x32", g.frames.length === f.vms.icons && g.w === 32 && g.h === 32);
    ok(name + ": every frame decodes to the icon", g.frames.every((fr, i) => same(gifFrameRGBA(g, fr), flatten(VMU.iconRGBA(f.vms, i)))));
    if (f.vms.icons > 1) {
      ok(name + ": loops, with vmu2gif's timing", g.loop && g.frames.every(fr => fr.gce.delay === f.vms.animSpeed * 4));
    }
  }

  VMU.open(gifCard, "gif.bin");
  const af = VMU.files().find(x => x.name === "ANIMTEST.VMS");
  const ag = readGif(VMU.iconGif(af.vms));
  ok("ANIMTEST.VMS: the frames differ", !same(ag.frames[0].px, ag.frames[1].px) && !same(ag.frames[1].px, ag.frames[2].px));
  ok("ANIMTEST.VMS: transparency is on, and clears between frames",
     ag.frames.every(fr => (fr.gce.flags & 1) && ((fr.gce.flags >> 2) & 7) === 2));

  cli(tmp("gif.bin"), "--icon-gif", "ICONDATA_VMS", "x.gif");
  const idc = VMU.files().find(x => x.name === "ICONDATA_VMS");
  ok("ICONDATA_VMS (colour): .gif identical", same(VMU.icondataGif(idc.data), read("x.gif")));
  ok("ICONDATA_VMS (colour): decodes to the colour icon",
     same(gifFrameRGBA(readGif(read("x.gif")), readGif(read("x.gif")).frames[0]), flatten(VMU.icondataRGBA(idc.data, 1))));
  cli(tmp("mono.bin"), "--icon-gif", "ICONDATA_VMS", "x.gif");
  VMU.open(read("mono.bin"), "mono.bin");
  const idm = VMU.readFile(VMU.find("ICONDATA_VMS"));
  ok("monochrome-only icon: .gif identical", same(VMU.icondataGif(idm), read("x.gif")));
  ok("monochrome-only icon: decodes to the LCD icon",
     same(gifFrameRGBA(readGif(read("x.gif")), readGif(read("x.gif")).frames[0]), flatten(VMU.icondataRGBA(idm, 0))));

  const defname = cli(path.join(SAMPLES, "dcvmu.bin"), "--icon-gif", "SONICADV_INT");
  ok("--icon-gif names the file after the VMU file by default", defname.includes("SONICADV_INT.gif") && fs.existsSync(tmp("SONICADV_INT.gif")));


  /* ---------- a real Nexus card ---------- */
  console.log("\n=== samples/newvmu.DCM (Nexus byte order) ===");
  const NEX = path.join(SAMPLES, "newvmu.DCM");
  const nexus = new Uint8Array(fs.readFileSync(NEX));
  let nr = VMU.open(nexus, "renamed.bin");
  ok("the byte order is detected without the extension", nr.ok && VMU.dcm);
  nr = VMU.open(nexus, "newvmu.DCM");
  ok("opens as a DCM", nr.ok && VMU.dcm);
  ok("an untouched card downloads byte for byte as it came", same(VMU.exportCard(true), nexus));

  const nfiles = VMU.files();
  const nlist = cli(NEX, "--list");
  const nnames = nlist.split("\n").filter(l => /^ \S.* \| (DATA|GAME)/.test(l)).map(l => l.slice(1, 13).trim());
  ok("same " + nnames.length + " files as --list, in the same order", same(nfiles.map(f => f.name), nnames));
  const nst = VMU.stats();
  ok("same block counts as --mc-info",
     cli(NEX, "--mc-info").includes("Used " + nst.used + " | Free " + nst.free + " | Total " + nst.total));

  let nexOk = { crc: 0, dci: 0, vmi: 0, raw: 0, gif: 0, icons: 0 }, nexBad = [];
  for (const f of nfiles) {
    const fi = cli(NEX, "--file-info", f.name);
    if (f.filetype === VMU.GAME ? fi.includes("n/a (game file)")
        : f.isIcondata ? fi.includes("card icon")
        : fi.includes(crcVerdict(f))) nexOk.crc++;
    else nexBad.push(f.name + " crc");

    cli(NEX, "--dci-export", f.name, "n.dci");
    if (same(VMU.dciEncode(f.idx), read("n.dci"))) nexOk.dci++; else nexBad.push(f.name + " dci");

    cli(NEX, "--vmi-export", f.name, "NRES");
    const v = VMU.vmiEncode(f.idx, "NRES", "DCVMU-TOOL by Bucanero");
    if (same(v.vmi, read("NRES.VMI")) && same(v.vms, read("NRES.VMS"))) nexOk.vmi++; else nexBad.push(f.name + " vmi");

    cli(NEX, "--extract-file", f.name, "n.raw");
    if (same(VMU.readFile(f.idx), read("n.raw"))) nexOk.raw++; else nexBad.push(f.name + " raw");

    cli(NEX, "--icon-gif", f.name, "n.gif");
    const g = f.isIcondata ? VMU.icondataGif(f.data) : VMU.iconGif(f.vms);
    if (same(g, read("n.gif"))) nexOk.gif++; else nexBad.push(f.name + " gif");

    if (!f.isIcondata) {
      cli(NEX, "--icons", f.name);
      const safe = f.name.replace(/[^A-Za-z0-9.-]/g, "_");
      let good = true;
      for (let i = 0; i < f.vms.icons; i++)
        good = good && same(VMU.iconRGBA(f.vms, i), readPng(tmp(safe + "_icon" + i + ".png")).px);
      if (f.vms.eyecatch)
        good = good && same(VMU.eyecatchRGBA(f.vms), readPng(tmp(safe + "_eyecatch.png")).px);
      if (good) nexOk.icons++; else nexBad.push(f.name + " icons");
    }
  }
  const n = nfiles.length;
  ok("CRC verdicts match --file-info (" + nexOk.crc + "/" + n + ")", nexOk.crc === n, nexBad.join(", "));
  ok(".dci exports identical (" + nexOk.dci + "/" + n + ")", nexOk.dci === n, nexBad.join(", "));
  ok(".VMI/.VMS exports identical (" + nexOk.vmi + "/" + n + ")", nexOk.vmi === n, nexBad.join(", "));
  ok("raw files identical (" + nexOk.raw + "/" + n + ")", nexOk.raw === n, nexBad.join(", "));
  ok("icon GIFs identical (" + nexOk.gif + "/" + n + ")", nexOk.gif === n, nexBad.join(", "));
  ok("icon and eyecatch pixels match --icons (" + nexOk.icons + "/" + (n - 1) + ")", nexOk.icons === n - 1, nexBad.join(", "));

  const byName = nm => nfiles.find(f => f.name === nm);
  const logic = byName("LOGIC");
  ok("LOGIC is a game file, running from block 0", logic.filetype === VMU.GAME && logic.firstblk === 0);
  ok("its header is at block 1", VMU.headerOffset(logic) === 512 && logic.vms.descDc === "VMU Script");
  ok("copy protection is read", byName("CHU_CHU__RCT").copyprotect === VMU.PROTECTED &&
     byName("PJUSTICE_SYS").copyprotect === VMU.PROTECTED && byName("SONIC2___S01").copyprotect === 0);
  ok("DRACONUS.001 carries a true-colour eyecatch", byName("DRACONUS.001").vms.eyecatch === 1);
  const bang = byName("BANGAIO_DAT"), bg = readGif(VMU.iconGif(bang.vms));
  ok("BANGAIO_DAT animates: 3 distinct frames, looping",
     bg.loop && bg.frames.length === 3 && !same(bg.frames[0].px, bg.frames[1].px) && !same(bg.frames[1].px, bg.frames[2].px));
  ok("an unset CRC is told apart from a wrong one",
     byName("CDX_CODES_00").crcUnset && !byName("SFORTUNE.000").crcUnset && byName("SFORTUNE.000").crcOk === false);
  const puyo = byName("PUYOFEVERSYS");
  ok("a Shift-JIS description is decoded", /ぷよ/.test(puyo.vms.descDc), JSON.stringify(puyo.vms.descDc));
  const pv = VMU.vmiEncode(puyo.idx, "P", "x").vmi, praw = puyo.data.subarray(0x10, 0x30);
  let plen = 32; while (plen && (praw[plen - 1] === 0x20 || praw[plen - 1] === 0)) plen--;
  ok("and goes into a VMI as the original bytes", same(pv.subarray(4, 4 + plen), praw.subarray(0, plen)));
  /* The CLI brings Shift-JIS down to ASCII for the terminal: the long-vowel
   * mark (81 5B) is punctuation and becomes '-', each kana becomes '?' */
  const shown = cli(NEX, "--file-info", "PUYOFEVERSYS").split("\n").find(l => l.startsWith("DC desc.  : ")).slice(12);
  ok("the CLI shows Shift-JIS as ASCII: punctuation mapped, kana as '?'",
     shown === "??????-?-", JSON.stringify(shown));
  const vmuShown = cli(NEX, "--file-info", "PUYOFEVERSYS").split("\n").find(l => l.startsWith("VMU desc. : ")).slice(12);
  ok("half-width katakana show as '?' too", vmuShown === "????????", JSON.stringify(vmuShown));

  /* full-width letters, digits and punctuation, after an odd number of
   * ASCII bytes, then a kana and a second-level kanji (lead byte 0xE0+) */
  const sj = new Uint8Array(1024);
  const desc = [0x41, 0x82, 0x72, 0x82, 0x6e, 0x82, 0x6d, 0x82, 0x68, 0x82, 0x62, 0x81, 0x40,
                0x82, 0x51, 0x81, 0x49, 0x81, 0x69, 0x82, 0x94, 0x81, 0x6a, 0x82, 0xd5, 0xe0, 0x40, 0x5a];
  sj.fill(0x20, 0, 0x30);
  sj.set(desc, 0x10);
  fs.writeFileSync(tmp("sjis.raw"), sj);
  cli(tmp("sjis.bin"), "--mc-create");
  cli(tmp("sjis.bin"), "--inject-file", tmp("sjis.raw"), "SJIS");
  const sjShown = cli(tmp("sjis.bin"), "--file-info", "SJIS").split("\n").find(l => l.startsWith("DC desc.  : ")).slice(12);
  ok("mixed Shift-JIS converts pair by pair", sjShown === "ASONIC 2!(t)??Z", JSON.stringify(sjShown));

  /* edits on the DCM itself: the CLI keeps the Nexus byte order when saving */
  fs.writeFileSync(tmp("nex.DCM"), nexus);
  cli(NEX, "--dci-export", "SONICADV_INT", "sadv_n.dci");
  VMU.deleteFile(VMU.find("SONICADV_INT"));
  cli(tmp("nex.DCM"), "--remove", "SONICADV_INT");
  ok("remove on a DCM matches, in Nexus order", same(VMU.exportCard(true), read("nex.DCM")));
  const back = VMU.dciDecode(read("sadv_n.dci"));
  VMU.writeFile(back.ent, back.data);
  cli(tmp("nex.DCM"), "--import", tmp("sadv_n.dci"));
  ok("re-importing it matches too", same(VMU.exportCard(true), read("nex.DCM")));
  let full = false;
  try { VMU.writeFile(Object.assign({}, back.ent, { name: "TOOBIG" }), new Uint8Array(20 * 512)); }
  catch (err) { full = err.message === VMU.ERR.NOSPC; }
  ok("a file larger than the free space is refused", full);


  /* ---------- VMI quirks seen in real collections ---------- */
  console.log("\n=== VMI quirks ===");
  const vmiWith = (time, cks) => {
    const v = VMU.vmiEncode(VMU.find("SONICADV_INT"), "QUIRK", "x");
    const vmi = v.vmi.slice();
    if (time) vmi.set(time, 0x44);
    if (cks) vmi.set(cks, 0);
    fs.writeFileSync(tmp("QUIRK.VMI"), vmi);
    fs.writeFileSync(tmp("QUIRK.VMS"), v.vms);
    return vmi;
  };
  VMU.open(sample, "dcvmu.bin");
  for (const [label, time, want] of [
    ["binary", [0xcf, 0x07, 11, 27, 0, 1, 0, 5], "1999-11-27 00:01:00"],
    ["BCD, as some tools wrote it", [0x20, 0x03, 0x06, 0x28, 0x18, 0x31, 0x48, 4], "2003-06-28 18:31:48"],
    ["BCD with an unset day", [0x19, 0x00, 0x01, 0x00, 0, 0, 0, 6], "1900-01-01 00:00:00"],
    ["binary with a 0-based month", [0xcf, 0x07, 0x00, 0x0e, 0x00, 0x26, 0x2e, 4], "1999-01-14 00:38:46"]]) {
    const vmi = vmiWith(time);
    cli(tmp("q.bin"), "--mc-create");
    cli(tmp("q.bin"), "--import", tmp("QUIRK.VMI"));
    const line = cli(tmp("q.bin"), "--list").split("\n").find(l => l.includes("SONICADV_INT")) || "";
    const ts = VMU.vmiDecode(vmi).ent.timestamp;
    const page = Array.from(ts.subarray(0, 7), v => v.toString(16).padStart(2, "0"));
    const pageDate = page[0] + page[1] + "-" + page[2] + "-" + page[3] + " " + page[4] + ":" + page[5] + ":" + page[6];
    ok("VMI time, " + label + ": " + want, line.includes(want) && pageDate === want, line.split("|")[3] + " / page " + pageDate);
  }
  vmiWith(null, [0x41, 0x44, 0x44, 0x40]);
  const pw = cli(tmp("q.bin"), "--mc-format") && (cli(tmp("q.bin"), "--import", tmp("QUIRK.VMI")));
  ok("Planetweb's constant \"ADD@\" checksum is accepted", !/Warning/.test(pw) &&
     VMU.vmiDecode(new Uint8Array(fs.readFileSync(tmp("QUIRK.VMI")))).info.checksumOk);
  vmiWith(null, [0x53, 0x00, 0x00, 0x00]);
  cli(tmp("q.bin"), "--mc-format");
  ok("any other wrong checksum still warns", /Warning/.test(cli(tmp("q.bin"), "--import", tmp("QUIRK.VMI"))) &&
     !VMU.vmiDecode(new Uint8Array(fs.readFileSync(tmp("QUIRK.VMI")))).info.checksumOk);

  /* damaged cards */
  console.log("\n=== damaged input ===");
  ok("a short image is refused", !VMU.open(new Uint8Array(1000), "x.bin").ok);
  ok("a blank image reads as unformatted", VMU.open(new Uint8Array(VMU.SIZE), "x.bin").reason === VMU.ERR.FORMAT);
  const loop = sample.slice();
  loop[254 * 512 + 2 * 0xc7] = 0xc7; loop[254 * 512 + 2 * 0xc7 + 1] = 0;
  fs.writeFileSync(tmp("loop.bin"), loop);
  VMU.open(loop, "loop.bin");
  ok("a looping chain is reported broken", VMU.files()[0].broken);
  VMU.deleteFile(VMU.find("SONIC2___S01"));
  cli(tmp("loop.bin"), "--remove", "SONIC2___S01");
  ok("and removes like the CLI", same(VMU.exportCard(false), read("loop.bin")));

  const emu = emulator(VMU, VMS);

  /* ---------- optional: a whole collection of saves ---------- */
  /* DC_SAVES=<dir> runs every .VMI/.VMS pair under it through both the page
   * and the CLI: the same import, the same card, the same exports. */
  if (process.env.DC_SAVES) {
    corpus(VMU, process.env.DC_SAVES);
    if (emu) emulatorCorpus(VMU, VMS, process.env.DC_SAVES);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

/* ---------- the emulator vs SoftVMS ---------- */

const SOFTVMS = path.join(ROOT, "web", "test", "softvms");
const REF = path.join(TMP, "softvms-ref");

/* SoftVMS's cpu.c as it came, with web/test/softvms/ref.c as its front end */
function buildSoftvms() {
  const r = spawnSync(process.env.CC || "cc", [
    "-O2", "-w", "-DHAVE_UNISTD_H", "-DHAVE_FCNTL_H", "-DHAVE_ERRNO_H", "-DHAVE_SYS_TIME_H", "-DTIME_WITH_SYS_TIME",
    "-DBSD_STYLE_GETTIMEOFDAY", "-DTIMEZONE_IS_VOID",
    "-o", REF, path.join(SOFTVMS, "cpu.c"), path.join(SOFTVMS, "ref.c")
  ], { encoding: "utf8" });
  return r.status === 0 ? "" : (r.stderr || r.error && r.error.message || "failed").trim().split("\n")[0];
}

/* What ref.c fixes the clock at: 2001-02-03 04:05:06 UTC, a Saturday */
const REF_DATE = { year: 2001, mon: 2, mday: 3, hour: 4, min: 5, sec: 6, wday: 6 };

/* Button presses both emulators get: slice:button:state, mostly the d-pad,
 * A and B, with A+B together now and then (many games start on A+B), and
 * Mode and Sleep only when asked, since they usually quit the game. */
function keyScript(seed, total, withMode) {
  let s = seed >>> 0;
  const rnd = n => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) % n; };
  const out = [];
  for (let t = 30; t < total - 20 && out.length < 250; ) {
    const len = 3 + rnd(12);
    const r = rnd(40);
    const keys = withMode && r === 0 ? [6 + rnd(2)] : r < 6 ? [4, 5] : [rnd(6)];
    for (const k of keys) out.push(t + ":" + k + ":1", (t + len) + ":" + k + ":0");
    t += len + 2 + rnd(30);
  }
  return out.join(",");
}

const fnv = (b, h = 2166136261) => { for (const x of b) h = Math.imul(h ^ x, 16777619) >>> 0; return h; };
const hex8 = v => v.toString(16).padStart(8, "0");

/* ref.c's output, from the page's emulator */
function emulate(VMS, bytes, name, total, every, keys) {
  const ks = keys.split(",").filter(Boolean).map(k => k.split(":").map(Number));
  const out = [];
  let slice = 0, tones = 2166136261, stop = false;
  const lcd = tag => {
    let s = tag + " " + slice + " ";
    for (let y = 0; y < VMS.H; y++)
      for (let x = 0; x < VMS.W; x += 8) {
        let b = 0;
        for (let i = 0; i < 8; i++) b = (b << 1) | VMS.lcd[y * VMS.W + x + i];
        s += b.toString(16).padStart(2, "0");
      }
    out.push(s);
  };
  const finish = why => { lcd("L"); out.push("E " + why + " " + slice, "F " + hex8(fnv(VMS.flash)), "T " + hex8(tones)); };
  VMS.hooks.redraw = VMS.hooks.error = null;
  VMS.hooks.sound = f => {
    const ev = [slice, slice >> 8, slice >> 16, slice >>> 24, f, f >> 8, f >> 16, f >> 24].map(v => v & 0xff);
    tones = Math.imul(tones ^ fnv(ev), 16777619) >>> 0;
  };
  VMS.setBios(null);
  if (!VMS.load(bytes, name, REF_DATE)) return "";
  VMS.reset(REF_DATE);
  VMS.run(total, () => {
    if (stop) return;
    slice++;
    for (const [at, k, d] of ks) if (at === slice) VMS.key(k, d);
    if (every && slice % every === 0) lcd("S");
    if (slice >= total) { finish("done"); stop = true; }
  });
  if (!stop) finish("exit");
  return out.join("\n") + "\n";
}

function softvms(file, total, every, keys) {
  return execFileSync(REF, [file, String(total), String(every), keys],
                      { env: { TZ: "UTC" }, encoding: "latin1" });
}

/* Run a flash image through both; "" when they agree, else where they part */
function sameRun(VMS, bytes, name, total, every, keys) {
  const file = tmp(name);
  fs.writeFileSync(file, bytes);
  const a = softvms(file, total, every, keys), b = emulate(VMS, bytes, file, total, every, keys);
  if (a === b) return { diff: "", out: a };
  const al = a.split("\n"), bl = b.split("\n");
  const i = al.findIndex((l, n) => l !== bl[n]);
  return { diff: "first differs at: " + (al[i] || "(end)").slice(0, 24) + " vs " + (bl[i] || "(end)").slice(0, 24), out: a };
}

/* A test program for both emulators: every arithmetic and compare
 * instruction over all 256 values of ACC, with the carry in both states,
 * each result (ACC and PSW, and B and C for MUL/DIV) written to flash with
 * STF, where the final flash hash sees every one of them. */
function flagProgram() {
  const K = [0x00, 0x01, 0x0f, 0x10, 0x7f, 0x80, 0x9c, 0xff];
  const ops = [];
  for (const k of K) {
    ops.push([0x81, k], [0x91, k], [0xa1, k], [0xb1, k]);          /* ADD/ADDC/SUB/SUBC #k */
    ops.push([0x31, k, 0x00], [0x41, k, 0x00]);                    /* BE/BNE #k: CY */
  }
  ops.push([0x82, 0x31], [0x92, 0x31], [0xa2, 0x31], [0xb2, 0x31]); /* the same with d9 */
  ops.push([0xc0], [0xd0], [0xe0], [0xf0]);                         /* ROR RORC ROL ROLC */
  const muldiv = [];
  for (const [b, c] of [[0x00, 0x00], [0x03, 0x7f], [0xff, 0xff], [0x10, 0x01], [0x10, 0x00]])
    muldiv.push([0x30, b, c], [0x40, b, c]);
  const code = [0x21, 0x02, 0x00];                                   /* JMPF 0x200, past the vectors */
  while (code.length < 0x200) code.push(code.length % 8 === 3 ? 0xb0 : 0x00);   /* RETI at each vector */
  code.push(0x23, 0x08, 0x00);                                       /* MOV #0, IE: no interrupts */
  code.push(0x22, 0x31, 0x5a);                                       /* MOV #5a, 0x31: the d9 operand */
  let page = 0x40;
  const block = (op, pre, extra) => {
    const hi = page++;
    code.push(0x22, 0x30, 0x00);                                     /* MOV #0, n */
    const loop = code.length;
    code.push(0x23, 0x05, hi, 0x23, 0x54, 0x00);                     /* TRH = page, FPR = 0 */
    code.push(0x02, 0x30, 0x13, 0x04);                               /* LD n; ST TRL */
    code.push(0xd0, 0x02, 0x30);                                     /* RORC: CY = n & 1; LD n */
    code.push(...pre, ...op);
    code.push(0x51, 0x03, 0x01, 0x63, 0x54, 0x51);                   /* STF ACC; LD PSW; INC FPR; STF */
    if (extra) {
      const hi2 = page++;
      code.push(0x03, 0x02, 0x23, 0x05, hi2, 0x23, 0x54, 0x00, 0x51);    /* LD B; TRH = page2; STF */
      code.push(0x03, 0x03, 0x63, 0x54, 0x51);                            /* LD C; INC FPR; STF */
    }
    code.push(0x62, 0x30, 0x02, 0x30);                               /* INC n; LD n */
    const rel = loop - (code.length + 2);
    code.push(0x90, rel & 0xff);                                     /* BNZ loop */
    if (rel < -128) throw new Error("block too long");
  };
  for (const op of ops) block(op, []);
  for (const [op, b, c] of muldiv) block([op], [0x23, 0x02, b, 0x23, 0x03, c], true);
  /* then time the base timer's interrupts, the 0.5 s tick: the main loop
   * counts, and each tick writes the count it reached to flash */
  code.push(0x22, 0x32, 0x00, 0x22, 0x33, 0x00, 0x22, 0x34, 0x00, 0x23, 0x54, 0x00);
  code.push(0x23, 0x08, 0x80);                                       /* MOV #80, IE */
  code.push(0x62, 0x33, 0x02, 0x33, 0x90, 0xfa, 0x62, 0x34, 0x01, 0xf6);   /* 16-bit count, forever */
  const tick = code.length;
  code.push(0x61, 0x00, 0x61, 0x01);                                 /* PUSH ACC, PSW */
  code.push(0x02, 0x32, 0x13, 0x04, 0x23, 0x05, 0x30);               /* TRL = ticks, TRH = 30 */
  code.push(0x02, 0x33, 0x51, 0x02, 0x34, 0x63, 0x54, 0x51, 0x73, 0x54);   /* STF lo, hi in bank 1 */
  code.push(0x62, 0x32, 0x71, 0x01, 0x71, 0x00, 0xb0);               /* ticks++; POP; RETI */
  code.splice(0x1b, 3, 0x21, tick >> 8, tick & 0xff);                /* the tick's vector: JMPF */
  const out = new Uint8Array(Math.max(0x800, code.length));
  out.set(code);
  return out;
}

function emulator(VMU, VMS) {
  console.log("\n=== VMU emulator vs SoftVMS 1.10 ===");
  const err = buildSoftvms();
  ok("SoftVMS builds with the headless front end", !err, err);
  if (err) return false;

  /* LOGIC is the game on newvmu.DCM: the card as the page gives it */
  VMU.open(new Uint8Array(fs.readFileSync(path.join(SAMPLES, "newvmu.DCM"))), "newvmu.DCM");
  const card = VMU.exportCard(false);
  const logic = VMU.files().find(f => f.name === "LOGIC");
  let r = sameRun(VMS, card, "logic-card.bin", 3000, 10, keyScript(1, 3000, false));
  ok("LOGIC, from the whole card: same screen every 100 ms, flash and tones", !r.diff, r.diff);
  ok("  and the game runs: the screen changes", new Set(r.out.split("\n").filter(l => l[0] === "S").map(l => l.split(" ")[2])).size > 3);
  ok("  only the game's own blocks are writable", VMS.gamesize === logic.filesize * VMU.BLK);

  /* on its own the game gets a directory made up around it */
  r = sameRun(VMS, logic.data, "LOGIC.VMS", 3000, 10, keyScript(2, 3000, false));
  ok("LOGIC as a lone game file: the same", !r.diff, r.diff);
  ok("  the directory made up around it matches too", VMS.flash[253 * 512] === 0xcc && VMS.gamesize === logic.filesize * VMU.BLK);

  /* buttons that quit: both stop at the same point */
  let quits = 0, agree = 0;
  for (let seed = 3; seed < 13; seed++) {
    r = sameRun(VMS, card, "logic-quit.bin", 4000, 50, keyScript(seed, 4000, true));
    if (!r.diff) agree++;
    if (/^E exit/m.test(r.out)) quits++;
  }
  ok("with Mode and Sleep pressed too, 10 runs agree (" + quits + " of them quit the game)", agree === 10);

  /* games never show some of it: the half-carry flag, say, or exactly when
   * the base timer ticks. This program makes all of that land in flash. */
  r = sameRun(VMS, flagProgram(), "FLAGS.VMS", 1000, 100, "");
  ok("the test program: ALU flags over all 256 values, MUL/DIV, and base timer timing agree", !r.diff, r.diff);
  ok("  and it got to the end: the ticks were timed", VMS.flash[0x3001] !== 0 && VMS.flash[0x3004] !== 0);

  /* a card with no game has nothing to run from block 0: both stop the same */
  r = sameRun(VMS, new Uint8Array(fs.readFileSync(path.join(SAMPLES, "dcvmu.bin"))), "nogame.bin", 200, 10, "");
  ok("a card with no game on it: the same", !r.diff, r.diff);
  return true;
}

/* DC_SAVES: every mini-game in the collection, as the page runs it */
function emulatorCorpus(VMU, VMS, root) {
  console.log("\n=== every mini-game under " + root + " ===");
  let games = 0, runs = 0, agree = 0, quit = 0, wrote = 0;
  const bad = [];
  for (const vmi of vmiFiles(root)) {
    const d = VMU.vmiDecode(new Uint8Array(fs.readFileSync(vmi)));
    if (!d || d.ent.filetype !== VMU.GAME) continue;
    const dir = path.dirname(vmi);
    const vmsName = fs.readdirSync(dir).find(f => f.toLowerCase() === d.info.resource.toLowerCase() + ".vms");
    if (!vmsName) continue;
    const vms = new Uint8Array(fs.readFileSync(path.join(dir, vmsName)));
    VMU.create();
    try { VMU.writeFile(d.ent, vms.subarray(0, d.info.filesize)); } catch (e) { continue; }
    const card = VMU.exportCard(false);
    const game = VMU.files()[0].data;
    games++;
    for (const withMode of [false, true]) {
      const r = sameRun(VMS, card, "game.bin", 6000, 50, keyScript(games * 2 + withMode, 6000, withMode));
      runs++;
      if (!r.diff) agree++; else bad.push(path.basename(vmi) + (withMode ? " (mode)" : "") + ": " + r.diff);
      if (/^E exit/m.test(r.out)) quit++;
      if (!withMode && VMS.flash.subarray(0, game.length).some((v, i) => v !== game[i])) wrote++;
    }
    const r = sameRun(VMS, vms.subarray(0, d.info.filesize), "game.vms", 2000, 50, keyScript(games, 2000, false));
    runs++;
    if (!r.diff) agree++; else bad.push(path.basename(vmi) + " (lone file): " + r.diff);
  }
  ok(games + " mini-games, " + runs + " runs of up to a minute: all agree with SoftVMS (" + agree + "/" + runs + ")",
     agree === runs, bad.slice(0, 5).join("; "));
  console.log("    (" + quit + " runs quit the game, " + wrote + " games saved to their file)");
}

/* every .VMI under a directory */
function vmiFiles(root) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== ".git") walk(p);
      else if (/\.vmi$/i.test(e.name)) out.push(p);
    }
  })(root);
  return out;
}

function corpus(VMU, root) {
  console.log("\n=== every save under " + root + " ===");
  const pairs = vmiFiles(root);

  const n = { card: 0, dci: 0, gif: 0, crc: 0, refusedBoth: 0 }, bad = [];
  let tried = 0;
  for (const vmi of pairs) {
    const d = VMU.vmiDecode(new Uint8Array(fs.readFileSync(vmi)));
    if (!d) { bad.push(vmi + ": page can't read the VMI"); continue; }
    const dir = path.dirname(vmi);
    const vmsName = fs.readdirSync(dir).find(f => f.toLowerCase() === d.info.resource.toLowerCase() + ".vms");
    const vms = vmsName && new Uint8Array(fs.readFileSync(path.join(dir, vmsName)));
    tried++;

    cli(tmp("c.bin"), "--mc-create");
    let cliOk = true;
    try { cli(tmp("c.bin"), "--import", vmi); } catch (e) { cliOk = false; }

    VMU.create();
    let pageOk = !!vms && vms.length >= d.info.filesize;
    if (pageOk) {
      try { VMU.writeFile(d.ent, vms.subarray(0, d.info.filesize)); } catch (e) { pageOk = false; }
    }
    if (!cliOk || !pageOk) {
      if (cliOk === pageOk) n.refusedBoth++; else bad.push(vmi + ": imported by " + (cliOk ? "the CLI" : "the page") + " only");
      continue;
    }

    if (sameCard(VMU.exportCard(false), read("c.bin"))) n.card++; else bad.push(vmi + ": cards differ");
    const f = VMU.files()[0];
    cli(tmp("c.bin"), "--dci-export", f.name, "c.dci");
    if (same(VMU.dciEncode(f.idx), read("c.dci"))) n.dci++; else bad.push(vmi + ": .dci differs");
    try {
      cli(tmp("c.bin"), "--icon-gif", f.name, "c.gif");
      const g = f.isIcondata ? VMU.icondataGif(f.data) : VMU.iconGif(f.vms);
      if (g && same(g, read("c.gif"))) n.gif++; else bad.push(vmi + ": .gif differs");
    } catch (e) {
      if (!(f.isIcondata ? VMU.icondataGif(f.data) : f.vms && VMU.iconGif(f.vms))) n.gif++;   /* neither has one */
      else bad.push(vmi + ": the CLI found no icon");
    }
    const fi = cli(tmp("c.bin"), "--file-info", f.name);
    if (f.filetype === VMU.GAME || f.isIcondata || !f.vms || fi.includes(crcVerdict(f))) n.crc++;
    else bad.push(vmi + ": CRC verdict differs");
  }

  const done = tried - n.refusedBoth;
  ok(tried + " saves: " + n.refusedBoth + " refused by both, the rest import identically (" + n.card + "/" + done + ")", n.card === done, bad.slice(0, 5).join("; "));
  ok(".dci exports identical (" + n.dci + "/" + done + ")", n.dci === done);
  ok("icon GIFs identical (" + n.gif + "/" + done + ")", n.gif === done);
  ok("CRC verdicts agree (" + n.crc + "/" + done + ")", n.crc === done);
  ok("nothing imported by one and refused by the other", !bad.some(b => / only$/.test(b)), bad.filter(b => / only$/.test(b)).slice(0, 5).join("; "));
}

main();
