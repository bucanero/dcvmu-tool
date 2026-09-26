/*
 * gifenc.h - minimal animated GIF writer
 *
 * LZW encoder from GIFSAVE by Sverre H. Huseby, as used in vmu2gif by
 * Bucanero (https://github.com/bucanero/vmu2gif).
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

#ifndef GIFENC_H
#define GIFENC_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
	int w, h;
	const uint8_t *palette;     /* RGBA, ncolors entries */
	int ncolors;                /* 2 to 256 */
	const uint8_t *pixels;      /* nframes * w * h palette indices */
	int nframes;
	uint16_t delay;             /* per frame, in 1/100 s */
} gif_anim_t;

/*
 * Encode as a GIF89a. More than one frame loops forever. Palette entries with
 * alpha below 0x80 become the GIF's one transparent colour (GIF has no partial
 * transparency). *out is malloc'd. Returns 0, or -1 on bad input or no memory.
 */
int gif_encode(const gif_anim_t *anim, uint8_t **out, size_t *len);

#endif
