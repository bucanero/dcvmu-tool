/*
 * DCVMU Tool - Dreamcast VMU Virtual Memory Card Tool by Bucanero
 *
 * VMU filesystem based on FUSE-VMU by Ross Meikleham
 * https://github.com/RossMeikleham/FUSE-VMU
 *
 * DCI and VMI/VMS support based on dci4vmi by Bucanero
 * https://github.com/bucanero/dci4vmi
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <inttypes.h>

#include "dcvmu.h"
#include "dcsave.h"
#include "util.h"

/* svpng writes uncompressed PNGs with no dependencies: at 32x32 an icon is
 * about 4 KB that way, which is not worth a zlib dependency to shrink. */
#define SVPNG_LINKAGE static
#include "svpng.h"

#define PROGRAM_NAME    "DCVMU-TOOL"
#define PROGRAM_VER     "1.0.0"

#define ICONDATA_NAME   "ICONDATA_VMS"

/* A failure already explained to the user, outside the VMU layer's codes */
#define ERR_REPORTED    -1000

enum dcvmu_cmd {
	CMD_NONE = 0,
	CMD_MCINFO,
	CMD_MCFREE,
	CMD_LIST,
	CMD_FILEINFO,
	CMD_ICONS,
	CMD_ICON_GIF,
	CMD_RAW_IMG,
	CMD_DCM_IMG,
	CMD_EXTRACT,
	CMD_DCI_EXPORT,
	CMD_VMI_EXPORT,
	/* everything from here on changes the card */
	CMD_MCFORMAT,
	CMD_MCCREATE,
	CMD_INJECT,
	CMD_IMPORT,
	CMD_REMOVE,
	CMD_RENAME,
};

static const struct {
	const char *name;
	const char *alias;
	int nargs;
	int cmd;
} commands[] = {
	{ "--mc-info",      "-i",    0, CMD_MCINFO },
	{ "--mc-free",      "-f",    0, CMD_MCFREE },
	{ "--mc-format",    NULL,    0, CMD_MCFORMAT },
	{ "--mc-create",    "-new",  0, CMD_MCCREATE },
	{ "--list",         "-ls",   0, CMD_LIST },
	{ "--file-info",    "-fi",   1, CMD_FILEINFO },
	{ "--icons",        NULL,    1, CMD_ICONS },
	{ "--icon-gif",     "-gif",  1, CMD_ICON_GIF },
	{ "--raw-image",    "-raw",  1, CMD_RAW_IMG },
	{ "--dcm-image",    "-dcm",  1, CMD_DCM_IMG },
	{ "--extract-file", "-x",    2, CMD_EXTRACT },
	{ "--inject-file",  "-in",   2, CMD_INJECT },
	{ "--remove",       "-rm",   1, CMD_REMOVE },
	{ "--rename",       "-mv",   2, CMD_RENAME },
	{ "--import",       "-imp",  1, CMD_IMPORT },
	{ "--dci-export",   "-dci",  2, CMD_DCI_EXPORT },
	{ "--vmi-export",   "-vmi",  2, CMD_VMI_EXPORT },
};

static vmu_card_t card;
static int card_dcm;    /* the card was read in the Nexus byte order */


static void print_usage(char **argv)
{
	printf("Copyright (C) 2026 - by Bucanero\n");
	printf("based on FUSE-VMU by Ross Meikleham, dci4vmi and vmu2gif\n\n");
	printf("Usage:\n");
	printf("%s <VMU filepath> <command> [<arguments>]\n", argv[0]);
	printf("\n");
	printf("VMU images are raw 128 KB dumps (.bin, .vmu) or Nexus .dcm dumps; the\n");
	printf("byte order is detected, and kept when the card is saved.\n");
	printf("\n");
	printf("Available commands:\n");
	printf("\t --mc-info, -i\n");
	printf("\t --mc-free, -f\n");
	printf("\t --mc-format\n");
	printf("\t --mc-create, -new  (write a new empty card to <VMU filepath>)\n");
	printf("\t --list, -ls\n");
	printf("\t --file-info, -fi <vmu filename>\n");
	printf("\t --icons <vmu filename>  (icons and eyecatch as PNG)\n");
	printf("\t --icon-gif, -gif <vmu filename> [<output filepath>]  (animated icon)\n");
	printf("\t --raw-image, -raw <output filepath>\n");
	printf("\t --dcm-image, -dcm <output filepath>\n");
	printf("\t --extract-file, -x <vmu filename> <output filepath>\n");
	printf("\t --inject-file, -in <input filepath> <vmu filename>\n");
	printf("\t --remove, -rm <vmu filename>\n");
	printf("\t --rename, -mv <vmu filename> <new vmu filename>\n");
	printf("\t --import, -imp <save filepath>  (DCI or VMI/VMS)\n");
	printf("\t --dci-export, -dci <vmu filename> <output filepath>\n");
	printf("\t --vmi-export, -vmi <vmu filename> <output basename>  (writes .VMI and .VMS)\n");
	printf("\n");
}

/* Case-insensitive suffix test, without depending on strcasecmp */
static int has_ext(const char *path, const char *ext)
{
	size_t n = strlen(path), e = strlen(ext);

	if (n < e)
		return 0;

	for (path += n - e; *ext; path++, ext++)
		if (tolower((unsigned char)*path) != tolower((unsigned char)*ext))
			return 0;

	return 1;
}

static const char *base_name(const char *path)
{
	const char *b = path;

	for (const char *p = path; *p; p++)
		if (*p == '/'
#ifdef _WIN32
		    || *p == '\\'
#endif
		    )
			b = p + 1;

	return b;
}

/* A VMU file name, made safe to use as part of a host file name */
static void safe_name(char *dst, const char *name)
{
	for (; *name; name++)
		*dst++ = (isalnum((unsigned char)*name) || *name == '.' || *name == '-') ? *name : '_';
	*dst = 0;
}

/* Full-width punctuation (Shift-JIS row 0x81) that has a plain equivalent. */
static char sjis_punct(uint8_t lo)
{
	static const struct { uint8_t lo; char c; } map[] = {
		{ 0x40, ' ' }, { 0x41, ',' }, { 0x42, '.' }, { 0x43, ',' }, { 0x44, '.' },
		{ 0x45, '.' }, { 0x46, ':' }, { 0x47, ';' }, { 0x48, '?' }, { 0x49, '!' },
		{ 0x4D, '`' }, { 0x4F, '^' }, { 0x50, '~' }, { 0x51, '_' }, { 0x5B, '-' },
		{ 0x5C, '-' }, { 0x5D, '-' }, { 0x5E, '/' }, { 0x5F, '\\' }, { 0x60, '~' },
		{ 0x61, '|' }, { 0x62, '|' }, { 0x65, '\'' }, { 0x66, '\'' }, { 0x67, '"' },
		{ 0x68, '"' }, { 0x69, '(' }, { 0x6A, ')' }, { 0x6D, '[' }, { 0x6E, ']' },
		{ 0x6F, '{' }, { 0x70, '}' }, { 0x7B, '+' }, { 0x7C, '-' }, { 0x7E, 'x' },
		{ 0x81, '=' }, { 0x83, '<' }, { 0x84, '>' }, { 0x90, '$' }, { 0x93, '%' },
		{ 0x94, '#' }, { 0x95, '&' }, { 0x96, '*' }, { 0x97, '@' }
	};

	for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++)
		if (map[i].lo == lo)
			return map[i].c;

	return '?';
}

/*
 * Shift-JIS header text down to plain ASCII for the terminal. Full-width
 * letters, digits and punctuation have exact equivalents; kana and kanji
 * become '?', since there is nothing to map them to.
 *
 * The same conversion as sjis_to_ascii() in ps2vmc-tool (src/ps2save.c).
 * Lead bytes 0xE0-0xFC (the second kanji level) start a pair just as
 * 0x81-0x9F do, and half-width katakana (single bytes 0xA1-0xDF) become '?'
 * like other kana, so no raw high byte reaches the terminal.
 */
static size_t sjis_to_ascii(const char *src, size_t srclen, char *dst, size_t dstsz)
{
	size_t i = 0, o = 0;

	while (i < srclen && src[i] && o + 1 < dstsz) {
		uint8_t hi = (uint8_t)src[i];
		uint8_t lo = (i + 1 < srclen) ? (uint8_t)src[i + 1] : 0;

		if (hi == 0x81 && i + 1 < srclen) {
			dst[o++] = sjis_punct(lo);
			i += 2;
		}
		else if (hi == 0x82 && i + 1 < srclen && lo >= 0x4F && lo <= 0x58) {
			dst[o++] = (char)('0' + (lo - 0x4F));
			i += 2;
		}
		else if (hi == 0x82 && i + 1 < srclen && lo >= 0x60 && lo <= 0x79) {
			dst[o++] = (char)('A' + (lo - 0x60));
			i += 2;
		}
		else if (hi == 0x82 && i + 1 < srclen && lo >= 0x81 && lo <= 0x9A) {
			dst[o++] = (char)('a' + (lo - 0x81));
			i += 2;
		}
		else if (((hi >= 0x81 && hi <= 0x9F) || (hi >= 0xE0 && hi <= 0xFC)) && i + 1 < srclen) {
			dst[o++] = '?';           /* kana or kanji: no ASCII equivalent */
			i += 2;
		}
		else if (hi >= 0xA1 && hi <= 0xDF) {
			dst[o++] = '?';           /* half-width katakana */
			i++;
		}
		else {
			dst[o++] = src[i++];      /* already single-byte */
		}
	}

	dst[o] = '\0';
	return o;
}

/* Header text for the terminal: Shift-JIS brought down to ASCII, control
 * bytes as blanks. Works on a copy - the header's own
 * bytes are what a VMI export carries. */
static void print_text(const char *s)
{
	char buf[64];

	sjis_to_ascii(s, strlen(s), buf, sizeof(buf));

	for (char *p = buf; *p; p++)
		putchar((unsigned char)*p < 0x20 ? ' ' : *p);
}

static void print_date(const vmu_timestamp_t *ts)
{
	printf("%02x%02x-%02x-%02x %02x:%02x:%02x", ts->cent, ts->year, ts->month,
	       ts->day, ts->hour, ts->min, ts->sec);
}

/*
 * A .dcm holds the card with every 4-byte group reversed. The 0x55 signature
 * reads the same either way, so the byte order is settled by which one gives
 * a usable root block, trying the one the file name suggests first.
 */
static int load_card(const char *path)
{
	uint8_t *buf;
	size_t len;
	int r;

	if (read_buffer(path, &buf, &len) < 0) {
		fprintf(stderr, "Error: can't read '%s'\n", path);
		return ERR_REPORTED;
	}

	card_dcm = has_ext(path, ".dcm");
	if (card_dcm)
		vmu_swap32(buf, len);

	r = vmu_load(&card, buf, len);
	if (r == VMU_ERR_FORMAT) {
		vmu_swap32(buf, len);
		if (vmu_load(&card, buf, len) == VMU_OK) {
			card_dcm = !card_dcm;
			r = VMU_OK;
		} else {
			/* neither works: keep the order the name suggested */
			vmu_swap32(buf, len);
			vmu_load(&card, buf, len);
		}
	}

	free(buf);
	return r;
}

static int save_card(const char *path, int dcm)
{
	uint8_t *buf = malloc(VMU_SIZE);
	int r;

	if (!buf)
		return VMU_ERR_NOMEM;

	memcpy(buf, card.img, VMU_SIZE);
	if (dcm)
		vmu_swap32(buf, VMU_SIZE);

	r = write_buffer(path, buf, VMU_SIZE);
	free(buf);

	if (r < 0) {
		fprintf(stderr, "Error: can't write '%s'\n", path);
		return ERR_REPORTED;
	}

	return VMU_OK;
}

/* Look up a file by name, explaining a miss */
static int find_file(const char *name, vmu_dirent_t *ent)
{
	int idx = vmu_find(&card, name);

	if (idx < 0) {
		fprintf(stderr, "Error: '%s' not found on the memory card\n", name);
		return idx;
	}

	vmu_dir_get(&card, idx, ent);
	return idx;
}

static int cmd_mcinfo(void)
{
	const vmu_root_t *root = &card.root;
	int free = vmu_free_blocks(&card);
	int files = vmu_file_count(&card);

	printf("Dreamcast VMU Information\n");
	printf("MC size   : %d KB\n", VMU_SIZE / 1024);
	printf("Block size: %d bytes\n", VMU_BLOCK_SIZE);
	printf("Formatted : %s", root->formatted ? "yes, on " : "no signature");
	if (root->formatted)
		print_date(&root->timestamp);
	printf("\n");
	printf("Color     : ");
	if (root->custom_color)
		printf("custom, #%02X%02X%02X (alpha %02X)\n",
		       root->color[2], root->color[1], root->color[0], root->color[3]);
	else
		printf("standard\n");
	printf("Icon shape: %d\n", root->icon_shape);
	printf("Layout    : root 255, FAT %d (%d block), directory %d (%d blocks)\n",
	       root->fat_loc, root->fat_size, root->dir_loc, root->dir_size);
	printf("Blocks    : Used %d | Free %d | Total %d\n",
	       root->user_blocks - free, free, root->user_blocks);
	printf("Files     : %d (%d directory entries free)\n",
	       files, vmu_dir_count(&card) - files);

	return 0;
}

static int cmd_mcfree(void)
{
	printf("Dreamcast VMU free space\n");
	printf("Available space: %d Blocks\n", vmu_free_blocks(&card));
	return 0;
}

static int cmd_list(void)
{
	vmu_dirent_t ent;
	vms_header_t vms;
	uint8_t *data;
	size_t len;

	printf("  Filename    | Type  | Blocks | ------ Date ------- | Description\n");

	for (int i = 0; i < vmu_dir_count(&card); i++) {
		if (vmu_dir_get(&card, i, &ent) != 1)
			continue;

		printf(" %-12s | %s%c | %6d | ", ent.filename,
		       ent.filetype == VMU_FILE_GAME ? "GAME" : "DATA",
		       ent.copyprotect == VMU_COPY_PROTECTED ? '*' : ' ',
		       ent.filesize);
		print_date(&ent.timestamp);
		printf(" | ");

		if (strcmp(ent.filename, ICONDATA_NAME) == 0)
			printf("(card icon)");
		else if (vmu_read_file(&card, i, &data, &len) < 0)
			printf("(broken FAT chain)");
		else {
			if (vms_parse(data, len, vms_header_offset(&ent), &vms) == 0)
				print_text(vms.desc_dc);
			free(data);
		}
		printf("\n");
	}

	printf("\n* copy protected\n");
	return 0;
}

static int cmd_fileinfo(const char *name)
{
	vmu_dirent_t ent;
	vms_header_t vms;
	uint8_t *data;
	size_t len;
	int idx, r, crc;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	printf("Filename  : %s\n", ent.filename);
	printf("Type      : %s\n", ent.filetype == VMU_FILE_GAME ? "game" : "data");
	printf("Copy prot.: %s\n", ent.copyprotect == VMU_COPY_PROTECTED ? "yes" : "no");
	printf("Date      : ");
	print_date(&ent.timestamp);
	printf("\n");
	printf("Size      : %d blocks (%d bytes)\n", ent.filesize, ent.filesize * VMU_BLOCK_SIZE);
	printf("First blk : %d\n", ent.firstblk);
	printf("Header at : block %d\n", (int)(vms_header_offset(&ent) / VMU_BLOCK_SIZE));

	if ((r = vmu_read_file(&card, idx, &data, &len)) < 0)
		return r;

	if (strcmp(ent.filename, ICONDATA_NAME) == 0) {
		printf("Contents  : card icon (%s)\n", len >= 0x18 && read_le_uint32(data + 0x14) ?
		       "monochrome and colour" : "monochrome");
	}
	else if (vms_parse(data, len, vms_header_offset(&ent), &vms) < 0) {
		printf("VMS header: none found\n");
	}
	else {
		printf("VMU desc. : ");
		print_text(vms.desc_vms);
		printf("\nDC desc.  : ");
		print_text(vms.desc_dc);
		printf("\nCreated by: ");
		print_text(vms.app_id);
		printf("\n");
		printf("Icons     : %d (speed %d)\n", vms.icons, vms.anim_speed);
		printf("Eyecatch  : %s\n", (const char *[]){ "none", "true colour", "256 colours", "16 colours" }[vms.eyecatch]);
		printf("Data size : %u bytes\n", vms.payload);

		/* Games carry no CRC: the field is unused there */
		if (ent.filetype == VMU_FILE_GAME) {
			printf("CRC       : n/a (game file)\n");
		} else {
			/* Some games and cheat tools never fill the CRC in, and some
			 * put their own value in the data size too, so a stored 0
			 * reads as "not set" whatever the data size says. */
			crc = vms_calc_crc(&vms);
			if (vms.crc == 0 && crc != 0)
				printf("CRC       : 0000 (not set)\n");
			else if (crc < 0)
				printf("CRC       : %04X (can't check: the data size runs past the end of the file)\n", vms.crc);
			else
				printf("CRC       : %04X (%s)\n", vms.crc, crc == vms.crc ? "valid" : "does not match");
		}
	}

	free(data);
	return 0;
}

static int write_png(const char *filename, const uint8_t *rgba, int w, int h)
{
	FILE *fp = fopen(filename, "wb");
	int r;

	if (!fp) {
		fprintf(stderr, "Error: can't create '%s'\n", filename);
		return ERR_REPORTED;
	}

	/* svpng reports nothing itself, so check the stream once it is done */
	svpng(fp, w, h, rgba, 1);
	r = ferror(fp);
	if (fclose(fp) != 0)
		r = 1;

	if (r) {
		fprintf(stderr, "Error: can't write '%s'\n", filename);
		return ERR_REPORTED;
	}

	printf("Exported: %s\n", filename);
	return 0;
}

static int cmd_icons(const char *name)
{
	vmu_dirent_t ent;
	vms_header_t vms;
	uint8_t *data, *rgba;
	char safe[VMU_NAME_LEN * 2 + 1], filename[256];
	size_t len;
	int idx, r = 0, count = 0;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	if ((r = vmu_read_file(&card, idx, &data, &len)) < 0)
		return r;

	safe_name(safe, ent.filename);

	if (strcmp(ent.filename, ICONDATA_NAME) == 0) {
		for (int color = 0; color < 2 && r == 0; color++) {
			if (!(rgba = icondata_rgba(data, len, color)))
				continue;

			snprintf(filename, sizeof(filename), "%s_%s.png", safe, color ? "color" : "mono");
			r = write_png(filename, rgba, VMS_ICON_W, VMS_ICON_H);
			free(rgba);
			count++;
		}
	}
	else if (vms_parse(data, len, vms_header_offset(&ent), &vms) == 0) {
		for (int i = 0; i < vms.icons && r == 0; i++) {
			if (!(rgba = vms_icon_rgba(&vms, i)))
				continue;

			snprintf(filename, sizeof(filename), "%s_icon%d.png", safe, i);
			r = write_png(filename, rgba, VMS_ICON_W, VMS_ICON_H);
			free(rgba);
			count++;
		}

		if (r == 0 && (rgba = vms_eyecatch_rgba(&vms))) {
			snprintf(filename, sizeof(filename), "%s_eyecatch.png", safe);
			r = write_png(filename, rgba, VMS_EYECATCH_W, VMS_EYECATCH_H);
			free(rgba);
			count++;
		}
	}

	free(data);

	if (r < 0)
		return ERR_REPORTED;

	if (!count) {
		fprintf(stderr, "Error: '%s' has no icons\n", ent.filename);
		return ERR_REPORTED;
	}

	return 0;
}

/*
 * The icon as an animated GIF, as vmu2gif makes it. Dreamcast icons are
 * usually animations, which a set of PNG frames does not show.
 */
static int cmd_icon_gif(const char *name, const char *output)
{
	vmu_dirent_t ent;
	vms_header_t vms;
	uint8_t *data, *gif;
	char safe[VMU_NAME_LEN * 2 + 1], filename[256];
	size_t len, glen;
	int idx, r;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	if ((r = vmu_read_file(&card, idx, &data, &len)) < 0)
		return r;

	if (strcmp(ent.filename, ICONDATA_NAME) == 0)
		r = icondata_gif(data, len, &gif, &glen);
	else if (vms_parse(data, len, vms_header_offset(&ent), &vms) == 0)
		r = vms_icon_gif(&vms, &gif, &glen);
	else
		r = -1;

	free(data);

	if (r < 0) {
		fprintf(stderr, "Error: '%s' has no icons\n", ent.filename);
		return ERR_REPORTED;
	}

	if (!output) {
		safe_name(safe, ent.filename);
		snprintf(filename, sizeof(filename), "%s.gif", safe);
		output = filename;
	}

	r = write_buffer(output, gif, glen);
	free(gif);

	if (r < 0) {
		fprintf(stderr, "Error: can't write '%s'\n", output);
		return ERR_REPORTED;
	}

	printf("Exported: %s\n", output);
	return 0;
}

static int cmd_mcimg(const char *output, int dcm)
{
	int r = save_card(output, dcm);

	if (r == VMU_OK)
		printf("Exported %s memory card: %s\n", dcm ? "DCM" : "raw", output);

	return r;
}

static int cmd_mcformat(void)
{
	printf("Dreamcast VMU format\n");
	vmu_format(&card);
	printf("Memory card successfully formatted.\n");
	return 0;
}

static int cmd_extract(const char *name, const char *output)
{
	vmu_dirent_t ent;
	uint8_t *data;
	size_t len;
	int idx, r;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	if ((r = vmu_read_file(&card, idx, &data, &len)) < 0)
		return r;

	r = write_buffer(output, data, len);
	free(data);

	if (r < 0) {
		fprintf(stderr, "Error: can't write '%s'\n", output);
		return ERR_REPORTED;
	}

	printf("Extracted '%s' (%lu bytes) to '%s'\n", ent.filename, (unsigned long)len, output);
	return 0;
}

/* Write a file to the card, reporting what went in */
static int add_file(vmu_dirent_t *ent, const uint8_t *data, size_t len)
{
	int r = vmu_write_file(&card, ent, data, len);

	if (r == VMU_OK)
		printf("Added '%s' (%s, %d blocks)\n", ent->filename,
		       ent->filetype == VMU_FILE_GAME ? "game" : "data", ent->filesize);

	return r;
}

static int cmd_inject(const char *input, const char *name)
{
	vmu_dirent_t ent;
	uint8_t *data;
	size_t len;
	int r;

	if (read_buffer(input, &data, &len) < 0) {
		fprintf(stderr, "Error: can't read '%s'\n", input);
		return ERR_REPORTED;
	}

	memset(&ent, 0, sizeof(ent));
	strncpy(ent.filename, name, VMU_NAME_LEN);
	if (strlen(name) > VMU_NAME_LEN)
		ent.filename[0] = 0;            /* rejected as a bad name below */
	ent.filetype = VMU_FILE_DATA;
	ent.copyprotect = VMU_COPY_OK;
	vmu_timestamp_now(&ent.timestamp);

	r = add_file(&ent, data, len);
	free(data);
	return r;
}

static int import_dci(const char *input)
{
	vmu_dirent_t ent;
	uint8_t *buf, *data;
	size_t len, dlen;
	int r;

	if (read_buffer(input, &buf, &len) < 0) {
		fprintf(stderr, "Error: can't read '%s'\n", input);
		return ERR_REPORTED;
	}

	r = dci_decode(buf, len, &ent, &data, &dlen);
	free(buf);

	if (r < 0) {
		fprintf(stderr, "Error: '%s' is not a valid DCI file\n", input);
		return ERR_REPORTED;
	}

	/* Keep the header offset only where it points inside the file */
	ent.hdroff = vms_header_offset(&ent) / VMU_BLOCK_SIZE;

	r = add_file(&ent, data, dlen);
	free(data);
	return r;
}

/*
 * The .VMS a .VMI describes is named after its resource field, and lives next
 * to the .VMI. Browsers and file systems do not agree on the case of either,
 * so try the resource name both ways, then the .VMI's own base name.
 */
static int read_vms(const char *vmi_path, const char *resource, uint8_t **buf, size_t *len)
{
	char path[1024];
	const char *base = base_name(vmi_path);
	int dirlen = (int)(base - vmi_path);
	int stemlen = (int)strlen(base) - 4;           /* the name without ".VMI" */

	const char *tries[][2] = {
		{ resource, ".VMS" }, { resource, ".vms" },
		{ NULL, ".VMS" }, { NULL, ".vms" },
	};

	for (int i = 0; i < 4; i++) {
		if (tries[i][0])
			snprintf(path, sizeof(path), "%.*s%s%s", dirlen, vmi_path, tries[i][0], tries[i][1]);
		else
			snprintf(path, sizeof(path), "%.*s%s", dirlen + stemlen, vmi_path, tries[i][1]);

		if (read_buffer(path, buf, len) == 0) {
			printf("Reading %s\n", path);
			return 0;
		}
	}

	fprintf(stderr, "Error: can't find '%s.VMS' next to '%s'\n", resource, vmi_path);
	return ERR_REPORTED;
}

static int import_vmi(const char *input)
{
	vmu_dirent_t ent;
	vmi_info_t info;
	uint8_t *buf;
	size_t len;
	int r;

	if (read_buffer(input, &buf, &len) < 0) {
		fprintf(stderr, "Error: can't read '%s'\n", input);
		return ERR_REPORTED;
	}

	r = vmi_decode(buf, len, &ent, &info);
	free(buf);

	if (r < 0) {
		fprintf(stderr, "Error: '%s' is not a valid VMI file\n", input);
		return ERR_REPORTED;
	}

	if (!info.checksum_ok)
		printf("Warning: the VMI checksum does not match its resource name; importing anyway.\n");

	if (info.description[0])
		printf("Description: %s\n", info.description);

	if (read_vms(input, info.resource, &buf, &len) < 0)
		return ERR_REPORTED;

	if (len < info.filesize) {
		fprintf(stderr, "Error: the VMS holds %lu bytes, the VMI expects %u\n", (unsigned long)len, info.filesize);
		free(buf);
		return ERR_REPORTED;
	}

	r = add_file(&ent, buf, info.filesize);
	free(buf);
	return r;
}

static int cmd_import(const char *input)
{
	if (has_ext(input, ".dci"))
		return import_dci(input);

	if (has_ext(input, ".vmi"))
		return import_vmi(input);

	if (has_ext(input, ".vms"))
		fprintf(stderr, "Error: a .VMS has no header; import its .VMI, or use --inject-file\n");
	else
		fprintf(stderr, "Error: unrecognised save format: '%s' (expected .DCI or .VMI)\n", input);

	return ERR_REPORTED;
}

static int cmd_dci_export(const char *name, const char *output)
{
	vmu_dirent_t ent;
	uint8_t *data, *out;
	size_t len, olen;
	int idx, r;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	if ((r = vmu_read_file(&card, idx, &data, &len)) < 0)
		return r;

	r = dci_encode(&ent, data, len, &out, &olen);
	free(data);
	if (r < 0)
		return VMU_ERR_NOMEM;

	r = write_buffer(output, out, olen);
	free(out);

	if (r < 0) {
		fprintf(stderr, "Error: can't write '%s'\n", output);
		return ERR_REPORTED;
	}

	printf("Exported '%s' to '%s'\n", ent.filename, output);
	return 0;
}

/*
 * <output basename> names both files: "saves/SONIC" writes saves/SONIC.VMI and
 * saves/SONIC.VMS. The base name doubles as the resource name inside the VMI,
 * which has room for 8 characters, so a longer one is cut to fit - otherwise
 * the VMI would point at a VMS that does not exist.
 */
static int cmd_vmi_export(const char *name, const char *output)
{
	vmu_dirent_t ent;
	vms_header_t vms;
	uint8_t *data, vmi[VMI_SIZE];
	char resource[VMI_RESOURCE_LEN + 1], path[1024];
	const char *base = base_name(output);
	const char *desc = "";
	size_t len, reslen;
	int idx, r;

	reslen = strlen(base);
	if (has_ext(base, ".vmi") || has_ext(base, ".vms"))
		reslen -= 4;

	if (reslen == 0) {
		fprintf(stderr, "Error: '%s' has no base name\n", output);
		return ERR_REPORTED;
	}

	if (reslen > VMI_RESOURCE_LEN) {
		printf("Note: VMI resource names are 8 characters; using '%.8s'\n", base);
		reslen = VMI_RESOURCE_LEN;
	}

	snprintf(resource, sizeof(resource), "%.*s", (int)reslen, base);

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	if ((r = vmu_read_file(&card, idx, &data, &len)) < 0)
		return r;

	if (vms_parse(data, len, vms_header_offset(&ent), &vms) == 0)
		desc = vms.desc_dc;

	vmi_encode(&ent, resource, desc, PROGRAM_NAME " by Bucanero", (uint32_t)len, vmi);

	snprintf(path, sizeof(path), "%.*s%s.VMS", (int)(base - output), output, resource);
	r = write_buffer(path, data, len);
	free(data);

	if (r < 0) {
		fprintf(stderr, "Error: can't write '%s'\n", path);
		return ERR_REPORTED;
	}
	printf("Exported '%s' to '%s'\n", ent.filename, path);

	snprintf(path, sizeof(path), "%.*s%s.VMI", (int)(base - output), output, resource);
	if (write_buffer(path, vmi, VMI_SIZE) < 0) {
		fprintf(stderr, "Error: can't write '%s'\n", path);
		return ERR_REPORTED;
	}
	printf("Exported '%s' to '%s'\n", ent.filename, path);

	return 0;
}

static int cmd_remove(const char *name)
{
	vmu_dirent_t ent;
	int idx;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	printf("Removing file: '%s'...\n", ent.filename);
	return vmu_delete_file(&card, idx);
}

static int cmd_rename(const char *name, const char *newname)
{
	vmu_dirent_t ent;
	int idx;

	if ((idx = find_file(name, &ent)) < 0)
		return idx;

	if (strlen(newname) > VMU_NAME_LEN)
		return VMU_ERR_NAME;

	printf("Renaming '%s' to '%s'...\n", ent.filename, newname);
	return vmu_rename_file(&card, idx, newname);
}

static int cmd_mccreate(const char *output)
{
	vmu_format(&card);
	printf("Creating a new %d KB memory card...\n", VMU_SIZE / 1024);

	if (save_card(output, has_ext(output, ".dcm")) < 0)
		return ERR_REPORTED;

	printf("Memory card saved: %s\n", output);
	return 0;
}


int main(int argc, char **argv)
{
	int r, cmd = CMD_NONE;
	char **args = &argv[3];

	printf(PROGRAM_NAME " v" PROGRAM_VER "\n");

	if (argc >= 3) {
		for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
			if (strcmp(argv[2], commands[i].name) &&
			    !(commands[i].alias && !strcmp(argv[2], commands[i].alias)))
				continue;

			if (argc - 3 >= commands[i].nargs)
				cmd = commands[i].cmd;
			break;
		}
	}

	if (cmd == CMD_NONE) {
		print_usage(argv);
		return 1;
	}

	/* Creating a card is the one command with no card to open. */
	if (cmd == CMD_MCCREATE)
		return cmd_mccreate(argv[1]) < 0 ? 1 : 0;

	r = load_card(argv[1]);

	/* An unformatted card can still be formatted, and nothing else */
	if (r == VMU_ERR_FORMAT && cmd == CMD_MCFORMAT)
		r = VMU_OK;

	if (r == ERR_REPORTED)
		return 1;

	if (r < 0) {
		fprintf(stderr, "Error: no Dreamcast VMU detected... (%s: %s)\n", argv[1], vmu_strerror(r));
		return 1;
	}

	switch (cmd) {
	case CMD_MCINFO:     r = cmd_mcinfo(); break;
	case CMD_MCFREE:     r = cmd_mcfree(); break;
	case CMD_LIST:       r = cmd_list(); break;
	case CMD_FILEINFO:   r = cmd_fileinfo(args[0]); break;
	case CMD_ICONS:      r = cmd_icons(args[0]); break;
	/* the output path is optional: argv[argc] is NULL when it is left out */
	case CMD_ICON_GIF:   r = cmd_icon_gif(args[0], args[1]); break;
	case CMD_RAW_IMG:    r = cmd_mcimg(args[0], 0); break;
	case CMD_DCM_IMG:    r = cmd_mcimg(args[0], 1); break;
	case CMD_EXTRACT:    r = cmd_extract(args[0], args[1]); break;
	case CMD_DCI_EXPORT: r = cmd_dci_export(args[0], args[1]); break;
	case CMD_VMI_EXPORT: r = cmd_vmi_export(args[0], args[1]); break;
	case CMD_MCFORMAT:   r = cmd_mcformat(); break;
	case CMD_INJECT:     r = cmd_inject(args[0], args[1]); break;
	case CMD_IMPORT:     r = cmd_import(args[0]); break;
	case CMD_REMOVE:     r = cmd_remove(args[0]); break;
	case CMD_RENAME:     r = cmd_rename(args[0], args[1]); break;
	}

	/* The VMU layer's codes explain themselves; the rest were reported
	 * where they happened. */
	if (r < 0 && r >= VMU_ERR_ARG && r != VMU_ERR_NOENT)
		fprintf(stderr, "Error: %s\n", vmu_strerror(r));

	/* save changes, in the format the card was read in */
	if (cmd >= CMD_MCFORMAT && r == 0) {
		if (save_card(argv[1], card_dcm) < 0)
			return 1;
		printf("VMU file saved: %s\n", argv[1]);
	}

	return r < 0 ? 1 : 0;
}
