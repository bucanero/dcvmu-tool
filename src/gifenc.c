/*
 * gifenc.c - minimal animated GIF writer
 *
 * The LZW encoder is GIFSAVE by Sverre H. Huseby (1992), by way of vmu2gif
 * by Bucanero (https://github.com/bucanero/vmu2gif), which used it to turn
 * Dreamcast VMS icons into animated GIFs. Its hashed string table is kept as
 * it was; the output goes to a memory buffer instead of a FILE.
 *
 * Two things differ from vmu2gif's writer. It announced every final data
 * sub-block one byte longer than it was and padded the frame with an extra
 * NUL to make up for it; sub-blocks here carry their real length. And it
 * ignored the palette's alpha, where this maps transparent entries to the
 * GIF's transparent colour, so icons keep their see-through background.
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
 */

#include <stdlib.h>
#include <string.h>

#include "gifenc.h"

#define RES_CODES       2           /* clear and end-of-information */
#define HASH_FREE       0xFFFF
#define NEXT_FIRST      0xFFFF
#define MAXBITS         12
#define MAXSTR          (1 << MAXBITS)
#define HASHSIZE        9973
#define HASHSTEP        2039
#define HASH(index, lastbyte) ((((lastbyte) << 8) ^ (index)) % HASHSIZE)

/* A growable output buffer; `fail` sticks once an allocation fails */
typedef struct {
	uint8_t *buf;
	size_t len, cap;
	int fail;
} out_t;

static void put(out_t *o, const void *src, size_t n)
{
	if (o->fail)
		return;

	if (o->len + n > o->cap) {
		size_t cap = o->cap ? o->cap : 1024;
		uint8_t *nb;

		while (cap < o->len + n)
			cap *= 2;

		if (!(nb = realloc(o->buf, cap))) {
			o->fail = 1;
			return;
		}
		o->buf = nb;
		o->cap = cap;
	}

	memcpy(o->buf + o->len, src, n);
	o->len += n;
}

static void put8(out_t *o, uint8_t v)
{
	put(o, &v, 1);
}

static void put16(out_t *o, uint16_t v)
{
	put8(o, v & 0xFF);
	put8(o, v >> 8);
}

/*
 * The image data: LZW codes packed least significant bit first, sent as
 * sub-blocks of up to 255 bytes each.
 */
typedef struct {
	out_t *out;
	uint8_t block[255];
	int n;                  /* bytes complete in block */
	uint32_t acc;           /* bits not yet a whole byte */
	int nacc;
} bits_t;

static void bits_byte(bits_t *b, uint8_t v)
{
	b->block[b->n++] = v;
	if (b->n == 255) {
		put8(b->out, 255);
		put(b->out, b->block, 255);
		b->n = 0;
	}
}

static void bits_put(bits_t *b, int code, int numbits)
{
	b->acc |= (uint32_t)code << b->nacc;
	b->nacc += numbits;

	while (b->nacc >= 8) {
		bits_byte(b, b->acc & 0xFF);
		b->acc >>= 8;
		b->nacc -= 8;
	}
}

static void bits_flush(bits_t *b)
{
	if (b->nacc)
		bits_byte(b, b->acc & 0xFF);

	if (b->n) {
		put8(b->out, b->n);
		put(b->out, b->block, b->n);
	}

	put8(b->out, 0);        /* block terminator */
}

/* The LZW string table, as GIFSAVE keeps it */
typedef struct {
	uint8_t  chr[MAXSTR];
	uint16_t nxt[MAXSTR];
	uint16_t hsh[HASHSIZE];
	uint16_t count;
} strtab_t;

static uint16_t add_string(strtab_t *t, uint16_t index, uint8_t b)
{
	uint16_t h;

	if (t->count >= MAXSTR)
		return 0xFFFF;

	h = HASH(index, b);
	while (t->hsh[h] != HASH_FREE)
		h = (h + HASHSTEP) % HASHSIZE;

	t->hsh[h] = t->count;
	t->chr[t->count] = b;
	t->nxt[t->count] = (index != 0xFFFF) ? index : NEXT_FIRST;

	return t->count++;
}

static uint16_t find_string(const strtab_t *t, uint16_t index, uint8_t b)
{
	uint16_t h, n;

	/* every one-character string is its own byte value */
	if (index == 0xFFFF)
		return b;

	h = HASH(index, b);
	while ((n = t->hsh[h]) != HASH_FREE) {
		if (t->nxt[n] == index && t->chr[n] == b)
			return n;
		h = (h + HASHSTEP) % HASHSIZE;
	}

	return 0xFFFF;
}

static void clear_table(strtab_t *t, int codesize)
{
	t->count = 0;
	for (int i = 0; i < HASHSIZE; i++)
		t->hsh[i] = HASH_FREE;

	for (int i = 0; i < (1 << codesize) + RES_CODES; i++)
		add_string(t, 0xFFFF, i);
}

static int lzw_compress(out_t *out, int codesize, const uint8_t *in, int len)
{
	strtab_t *t = malloc(sizeof(*t));
	bits_t b = { .out = out };
	int clearcode = 1 << codesize, endofinfo = clearcode + 1;
	int numbits = codesize + 1, limit = (1 << numbits) - 1;
	uint16_t prefix = 0xFFFF, index;

	if (!t)
		return -1;

	put8(out, codesize);
	clear_table(t, codesize);
	bits_put(&b, clearcode, numbits);

	for (int k = 0; k < len; k++) {
		uint8_t c = in[k];

		if ((index = find_string(t, prefix, c)) != 0xFFFF) {
			prefix = index;
			continue;
		}

		bits_put(&b, prefix, numbits);

		if (add_string(t, prefix, c) > limit) {
			if (++numbits > MAXBITS) {
				bits_put(&b, clearcode, numbits - 1);
				clear_table(t, codesize);
				numbits = codesize + 1;
			}
			limit = (1 << numbits) - 1;
		}

		prefix = c;
	}

	if (prefix != 0xFFFF)
		bits_put(&b, prefix, numbits);

	bits_put(&b, endofinfo, numbits);
	bits_flush(&b);

	free(t);
	return 0;
}

int gif_encode(const gif_anim_t *a, uint8_t **outp, size_t *lenp)
{
	static const uint8_t netscape[] = {
		0x21, 0xFF, 0x0B, 'N', 'E', 'T', 'S', 'C', 'A', 'P', 'E', '2', '.', '0',
		0x03, 0x01, 0x00, 0x00, 0x00    /* loop forever */
	};
	out_t o = { 0 };
	int npix = a->w * a->h;
	int sizebits = 0, trans = -1, codesize;
	uint8_t *frame;

	if (a->ncolors < 2 || a->ncolors > 256 || a->nframes < 1 || npix <= 0)
		return -1;

	/* the colour table holds 2^(sizebits+1) entries */
	while ((2 << sizebits) < a->ncolors)
		sizebits++;

	/* the first transparent entry stands for all of them */
	for (int i = 0; i < a->ncolors && trans < 0; i++)
		if (a->palette[i * 4 + 3] < 0x80)
			trans = i;

	if (!(frame = malloc(npix)))
		return -1;

	put(&o, "GIF89a", 6);
	put16(&o, a->w);
	put16(&o, a->h);
	put8(&o, 0x80 | (sizebits << 4) | sizebits);    /* global table */
	put8(&o, trans < 0 ? 0 : trans);                /* background */
	put8(&o, 0);                                    /* aspect */

	for (int i = 0; i < (2 << sizebits); i++) {
		if (i < a->ncolors)
			put(&o, a->palette + i * 4, 3);
		else
			put(&o, "\0\0\0", 3);
	}

	if (a->nframes > 1)
		put(&o, netscape, sizeof(netscape));

	/* GIF needs at least 2 bits per code */
	codesize = sizebits + 1 < 2 ? 2 : sizebits + 1;

	for (int f = 0; f < a->nframes; f++) {
		const uint8_t *src = a->pixels + (size_t)f * npix;

		for (int i = 0; i < npix; i++) {
			uint8_t p = src[i] < a->ncolors ? src[i] : 0;

			frame[i] = (trans >= 0 && a->palette[p * 4 + 3] < 0x80) ? trans : p;
		}

		if (a->nframes > 1 || trans >= 0) {
			/* Graphic Control Extension. A transparent frame has to
			 * clear the previous one, or the frames pile up. */
			put8(&o, 0x21); put8(&o, 0xF9); put8(&o, 4);
			put8(&o, trans >= 0 ? (2 << 2) | 1 : 0);
			put16(&o, a->nframes > 1 ? a->delay : 0);
			put8(&o, trans < 0 ? 0 : trans);
			put8(&o, 0);
		}

		put8(&o, 0x2C);
		put16(&o, 0); put16(&o, 0);
		put16(&o, a->w); put16(&o, a->h);
		put8(&o, 0);                                /* no local table */

		if (lzw_compress(&o, codesize, frame, npix) < 0)
			o.fail = 1;
	}

	put8(&o, 0x3B);
	free(frame);

	if (o.fail) {
		free(o.buf);
		return -1;
	}

	*outp = o.buf;
	*lenp = o.len;
	return 0;
}
