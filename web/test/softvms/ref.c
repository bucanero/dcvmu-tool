/*
 * ref.c - a headless front end for SoftVMS 1.10's cpu.c, used as the
 * reference for the page's JavaScript port of the emulator.
 *
 * cpu.c is SoftVMS's own file, unmodified. It talks to its front end
 * through a handful of functions (draw a pixel, redraw, wait, poll input,
 * set the tone); this file implements them without a display, pressing
 * buttons from a script and printing what is on the LCD every so often.
 *
 *     softvms-ref <flash> <slices> <every> [keys]
 *
 * <flash> is a whole card or a single game file, as SoftVMS takes. It runs
 * for <slices> 10 ms slices, printing the LCD every <every> slices, then
 * prints a hash of the flash and of the tones played. [keys] is a list of
 * slice:button:state, e.g. "100:4:1,110:4:0" presses and releases A.
 *
 * SoftVMS paces itself with the wall clock, but only to sleep between
 * slices: what runs in a slice depends on cycles alone, so with no sleeping
 * the run is repeatable. The one thing it takes from the clock is the date
 * it sets at reset, which time() below fixes; run it with TZ=UTC.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>

extern unsigned char flash[0x20000];
extern int do_vmsgame(char *filename, char *biosname);
extern void keypress(int i);
extern void keyrelease(int i);

/* 2001-02-03 04:05:06 UTC, a Saturn: every field is distinct */
#define FIXED_TIME 981173106

static unsigned char lcd[40][48];
static long slice, total, every;
static unsigned long tones = 2166136261u;
static struct { long at; int key, down; } keys[256];
static int nkeys;

/* Overrides libc's, for cpu.c's reset and fake directory dates */
time_t time(time_t *t)
{
	if (t)
		*t = FIXED_TIME;
	return FIXED_TIME;
}

static unsigned long fnv(const unsigned char *p, size_t n)
{
	unsigned long h = 2166136261u;
	while (n--)
		h = ((h ^ *p++) * 16777619u) & 0xffffffffu;
	return h;
}

static void print_lcd(const char *tag)
{
	int x, y;
	printf("%s %ld ", tag, slice);
	for (y = 0; y < 40; y++)
		for (x = 0; x < 48; x += 8) {
			int b = 0, i;
			for (i = 0; i < 8; i++)
				b = (b << 1) | lcd[y][x + i];
			printf("%02x", b);
		}
	printf("\n");
}

static void finish(const char *why)
{
	print_lcd("L");
	printf("E %s %ld\nF %08lx\nT %08lx\n", why, slice, fnv(flash, sizeof(flash)), tones);
	exit(0);
}

void vmputpixel(int x, int y, int p)
{
	if (x >= 0 && x < 48 && y >= 0 && y < 40)
		lcd[y][x] = p & 1;
}

void redrawlcd(void) {}
void waitforevents(struct timeval *t) { (void)t; }

/* cpu.c calls this once at the end of every 10 ms slice */
void checkevents(void)
{
	int i;
	slice++;
	for (i = 0; i < nkeys; i++)
		if (keys[i].at == slice) {
			if (keys[i].down)
				keypress(keys[i].key);
			else
				keyrelease(keys[i].key);
		}
	if (every && slice % every == 0)
		print_lcd("S");
	if (slice >= total)
		finish("done");
}

void sound(int freq)
{
	unsigned char ev[8];
	ev[0] = slice; ev[1] = slice >> 8; ev[2] = slice >> 16; ev[3] = slice >> 24;
	ev[4] = freq; ev[5] = freq >> 8; ev[6] = freq >> 16; ev[7] = freq >> 24;
	tones = ((tones ^ fnv(ev, 8)) * 16777619u) & 0xffffffffu;
}

void error_msg(char *fmt, ...) { (void)fmt; }

int main(int argc, char **argv)
{
	if (argc < 4) {
		fprintf(stderr, "usage: %s <flash> <slices> <every> [slice:key:state,...]\n", argv[0]);
		return 2;
	}
	total = atol(argv[2]);
	every = atol(argv[3]);
	if (argc > 4) {
		char *p = argv[4];
		while (*p && nkeys < 256) {
			long at; int key, down, n;
			if (sscanf(p, "%ld:%d:%d%n", &at, &key, &down, &n) != 3)
				break;
			keys[nkeys].at = at; keys[nkeys].key = key; keys[nkeys].down = down;
			nkeys++;
			p += n;
			if (*p == ',')
				p++;
		}
	}
	if (!do_vmsgame(argv[1], NULL))
		return 1;
	finish("exit");
	return 0;
}
