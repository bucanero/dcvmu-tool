#
# DCVMU Tool - Dreamcast VMU virtual memory card tool
#

# GCC on Windows appends .exe, so name the target accordingly or make would
# relink on every invocation.
ifeq ($(OS),Windows_NT)
EXE	=	.exe
endif

TOOL	=	dcvmu-tool$(EXE)

CC	=	gcc
CFLAGS	=	-g -O3 -W -I./include -D_GNU_SOURCE

# The VMU filesystem, the VMS/DCI/VMI formats, the GIF writer for animated
# icons, and the byte helpers. PNGs come from the header-only svpng.h. There
# are no external dependencies.
SRC	=	src/dcmain.c src/dcvmu.c src/dcsave.c src/gifenc.c src/util.c

OBJ	=	$(SRC:.c=.o)
DEPS	=	$(OBJ:.o=.d)

all: $(TOOL)

$(TOOL): $(OBJ)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

# -MMD -MP records which headers each object used, so editing a header
# rebuilds whatever depends on it instead of leaving a stale object behind.
%.o: %.c Makefile
	$(CC) $(CFLAGS) -MMD -MP -c -o $@ $<

-include $(DEPS)

# The web page's engine, checked against this CLI byte for byte
test: $(TOOL)
	node web/test/dctest.js

clean:
	-rm -f $(OBJ) $(DEPS) $(TOOL)

.PHONY: all test clean
