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
 * With DC_SAVES pointing at a directory of .VMI/.VMS saves, every one of them
 * is also run through both, e.g. a checkout of bucanero/dreamcast-saves:
 *
 *     DC_SAVES=../dreamcast-saves node web/test/dctest.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");   /* Node's own, to read the PNGs back */
const { execFileSync } = require("child_process");

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
  fs.writeFileSync(tmp, core + "\nmodule.exports = { VMU };\n");
  return require(tmp).VMU;
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
  const VMU = loadCore();
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

  /* ---------- optional: a whole collection of saves ---------- */
  /* DC_SAVES=<dir> runs every .VMI/.VMS pair under it through both the page
   * and the CLI: the same import, the same card, the same exports. */
  if (process.env.DC_SAVES) corpus(VMU, process.env.DC_SAVES);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

function corpus(VMU, root) {
  console.log("\n=== every save under " + root + " ===");
  const pairs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== ".git") walk(p);
      else if (/\.vmi$/i.test(e.name)) pairs.push(p);
    }
  })(root);

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
