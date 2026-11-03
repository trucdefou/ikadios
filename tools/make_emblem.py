# Generates the minimized overlay emblem (icons/emblem.png): a 16-bit style pixel
# art planet centred on South America, skewered by a sword. Drawn at 40x40 and
# shown at 2x with image-rendering: pixelated. Also writes the extension icons
# (icons/icon48.png at 1x, icons/icon128.png at 3x) on a white circle; the sword tips
# break out of the circle.
#
# Usage: python3 tools/make_emblem.py [--preview out.png]
import math
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIZE = 40
CX, CY, R = 18.0, 21.0, 14.0
# Projection centre (lon, lat): South America sits in the middle of the disk
LON0, LAT0 = math.radians(-60), math.radians(-18)
LIGHT = (-0.55, -0.6, 0.58)

OUTLINE = (26, 16, 40)
OCEAN = [(18, 34, 96), (29, 58, 138), (47, 107, 209), (90, 162, 240), (168, 220, 255)]
LAND = [(30, 74, 34), (46, 107, 42), (76, 154, 53), (134, 201, 74)]
ANDES = [(74, 52, 32), (122, 90, 50), (168, 132, 78)]
ICE = [(150, 180, 214), (204, 224, 244), (240, 248, 255)]
BLADE = [(79, 88, 115), (141, 153, 173), (212, 219, 230), (255, 255, 255)]
GOLD = [(122, 74, 22), (214, 150, 40), (255, 222, 110)]
GRIP = [(58, 26, 14), (110, 52, 24)]
GEM = [(140, 20, 30), (230, 50, 50), (255, 160, 160)]

BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

SOUTH_AMERICA = [
    (-77, 8.5), (-75.5, 10.5), (-72, 12), (-68, 10.6), (-63, 10.7), (-60, 8.5), (-57, 6), (-52, 5),
    (-50, 1.5), (-48, -1), (-44, -2.5), (-40, -3), (-35, -5.5), (-35, -9), (-38.5, -13), (-39, -17.5),
    (-41, -22), (-44, -23), (-48, -26), (-48.5, -28.5), (-51, -31), (-53, -34), (-57, -35), (-57.5, -38),
    (-62, -39), (-65, -41), (-65, -45), (-67.5, -46.5), (-66, -48), (-68.5, -50.5), (-68.5, -53),
    (-71, -54), (-74.5, -52), (-75.5, -47), (-73.5, -42), (-73.5, -37), (-71.5, -32), (-71.5, -28),
    (-70.5, -23), (-70.3, -18.5), (-75, -15.5), (-76.5, -13), (-79, -8), (-81, -5), (-80, -2), (-80, 1),
    (-78.5, 2.5), (-77.5, 4), (-77.5, 7),
]
NORTH_AMERICA = [
    (-77.5, 8.8), (-80, 9.3), (-83.5, 10.5), (-83.5, 12), (-84, 15.8), (-88, 15.8), (-88.5, 17),
    (-87, 21.5), (-90.5, 21.2), (-90.5, 19.5), (-94, 18.3), (-96, 19), (-97.5, 22), (-97.5, 27.5),
    (-94, 29.5), (-89, 30.2), (-83, 29.8), (-82, 26.5), (-80.5, 25.2), (-80, 27), (-81, 31.5),
    (-75.5, 35.3), (-76, 37), (-74, 40.5), (-70, 41.5), (-67, 44.5), (-70, 45), (-82, 45), (-95, 49),
    (-124, 48), (-124, 40), (-120, 35), (-117, 32.5), (-115, 32), (-112, 29), (-110, 24), (-105.5, 23),
    (-105, 19.5), (-97, 16), (-94.5, 16), (-91, 13.8), (-87.5, 13), (-85.5, 10.5), (-83, 8.5),
    (-80, 7.5), (-77.5, 7.5),
]
AFRICA = [
    (-17, 21), (-17.5, 14.7), (-16.8, 12.4), (-13.5, 9.5), (-11, 6.8), (-7.5, 4.4), (-2, 4.8), (4, 6.4),
    (8.5, 4.5), (9.8, 2.5), (9, -1), (12, -5), (13.3, -8.5), (12, -17), (15, -27), (18.5, -34.5),
    (25, -34), (32, -28), (35.5, -24), (35, -20), (40, -15), (40.5, -10), (39, -5), (41, -1), (44, 1),
    (51, 11.8), (43, 11.5), (39, 15.5), (33, 28), (32, 31), (20, 32), (10.5, 37), (-1, 35.5),
    (-6, 35.8), (-10, 30), (-13, 27.5),
]


def inside(poly, lon, lat):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def terrain(lon, lat):
    if lat < -66:
        return 'ice'
    if inside(SOUTH_AMERICA, lon, lat):
        # Andes: a strip along the Pacific coast
        if not inside(SOUTH_AMERICA, lon - 2.5, lat) and -42 < lat < 9:
            return 'andes'
        return 'land'
    if inside(NORTH_AMERICA, lon, lat) or inside(AFRICA, lon, lat):
        return 'land'
    return 'ocean'


def unproject(nx, ny, nz):
    # Orthographic inverse: screen normal to (lon, lat)
    lat = math.asin(-ny * math.cos(LAT0) + nz * math.sin(LAT0))
    lon = LON0 + math.atan2(nx, nz * math.cos(LAT0) + ny * math.sin(LAT0))
    return math.degrees(lon), math.degrees(lat)


def shade(palette, light, x, y, bias=0.0):
    # Light level to palette index with 4x4 ordered dithering between bands
    level = (light + bias) * (len(palette) - 1) + (BAYER[y % 4][x % 4] / 16 - 0.5)
    return palette[max(0, min(len(palette) - 1, round(level)))]


def globe_pixel(x, y):
    px, py = (x + 0.5 - CX) / R, (y + 0.5 - CY) / R
    d2 = px * px + py * py
    if d2 > 1:
        return None
    nz = math.sqrt(1 - d2)
    lum = max(0.0, px * LIGHT[0] + py * LIGHT[1] + nz * LIGHT[2])
    lum = min(1.0, 0.08 + lum * 0.85)
    kind = terrain(*unproject(px, py, nz))
    if kind == 'ocean':
        # Specular glint on the lit side
        if lum > 0.9 and d2 < 0.6:
            return OCEAN[4]
        return shade(OCEAN[:4], lum, x, y)
    if kind == 'ice':
        return shade(ICE, lum, x, y)
    if kind == 'andes':
        return shade(ANDES, lum, x, y)
    return shade(LAND, lum, x, y, -0.05)


def draw():
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    px = img.load()

    def put(x, y, c):
        if 0 <= x < SIZE and 0 <= y < SIZE:
            px[x, y] = c + (255,) if len(c) == 3 else c

    def in_globe(x, y):
        return ((x + 0.5 - CX) ** 2 + (y + 0.5 - CY) ** 2) <= R * R

    # Globe with a 1 px outline
    for y in range(SIZE):
        for x in range(SIZE):
            c = globe_pixel(x, y)
            if c:
                put(x, y, c)
    for y in range(SIZE):
        for x in range(SIZE):
            if not in_globe(x, y) and (x + 0.5 - CX) ** 2 + (y + 0.5 - CY) ** 2 <= (R + 1) ** 2:
                put(x, y, OUTLINE)

    # Sword along the anti-diagonal x + y = 39 (hilt top right, tip bottom left).
    # s = x - y runs along the sword, w = x + y - 39 across it; s + w is always odd,
    # so every test below uses ranges, never a single value.
    def sword(s, w):
        aw = abs(w)
        if 31 <= s <= 36:  # pommel with a gem
            if aw > 3 or (s >= 35 and aw > 1):
                return None
            if aw == 3 or s >= 35 or (s <= 32 and aw >= 2):
                return OUTLINE
            if s <= 32:
                return GOLD[0]
            return GEM[2] if w <= -1 and s <= 33 else GEM[1] if w <= 0 else GEM[0]
        if 24 <= s <= 30:  # leather grip
            if aw > 2:
                return None
            if aw == 2:
                return OUTLINE
            return GRIP[1] if ((s - w) // 2) % 2 == 0 else GRIP[0]
        if 20 <= s <= 23:  # crossguard
            if aw > 8:
                return None
            if aw >= 7 or s == 20 or s == 23:
                return OUTLINE
            return GOLD[2] if w < -1 else GOLD[1] if w < 3 else GOLD[0]
        if -38 <= s <= 19:  # blade, tapering to the tip
            half = 3 if s > -31 else 2 if s > -35 else 1
            if aw > half:
                return None
            if aw == half:
                return OUTLINE
            if half == 1:
                return BLADE[2]
            if half == 2:
                return BLADE[3] if w < 0 else BLADE[1]
            return {-2: BLADE[3], -1: BLADE[2], 0: BLADE[2], 1: BLADE[1], 2: BLADE[0]}[w]
        return None

    for y in range(SIZE):
        for x in range(SIZE):
            s, w = x - y, x + y - 39
            c = sword(s, w)
            if c is None:
                continue
            # The blade is hidden inside the globe: it enters and exits
            if s <= 19 and in_globe(x, y):
                continue
            put(x, y, c)

    return img


def main():
    img = draw()
    out = ROOT / 'icons' / 'emblem.png'
    img.save(out)
    print('wrote', out)
    for size, scale in ((48, 1), (128, 3)):
        icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        disc = icon.load()
        big = img.resize((SIZE * scale, SIZE * scale), Image.NEAREST)
        off = (size - big.width) // 2
        # Hard-edged white disc centred on the globe, as large as the canvas allows,
        # with a 1 px light grey rim so it reads on white pages
        gx, gy = off + CX * scale, off + CY * scale
        r = min(gx, gy, size - gx, size - gy)
        for y in range(size):
            for x in range(size):
                d = ((x + 0.5 - gx) ** 2 + (y + 0.5 - gy) ** 2) ** 0.5
                if d <= r - 1:
                    disc[x, y] = (255, 255, 255, 255)
                elif d <= r:
                    disc[x, y] = (205, 205, 210, 255)
        icon.alpha_composite(big, (off, off))
        path = ROOT / 'icons' / f'icon{size}.png'
        icon.save(path)
        print('wrote', path)
    if '--preview' in sys.argv:
        path = sys.argv[sys.argv.index('--preview') + 1]
        bg = Image.new('RGBA', (SIZE, SIZE), (200, 170, 120, 255))
        bg.alpha_composite(img)
        bg.resize((SIZE * 10, SIZE * 10), Image.NEAREST).save(path)
        print('wrote', path)


if __name__ == '__main__':
    main()
