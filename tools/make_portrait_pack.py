# Builds an advisor pack from custom portraits placed inside the game's own advisor
# frame (90x108: columns, arch, name plate). One script for every portrait pack: each
# entry in SETS gives the source, crop boxes, GrabCut hints and pack metadata. For every state the original game image
# provides the frame (premium = golden columns); the portrait goes into the arch window.
# Two looks: "normal" keeps the painted scene behind the figure; the notification states
# (active, alert and their premium variants) replace that scene with a gold background.
# The figure is cut out with OpenCV GrabCut, guided by the hint boxes in FIGURE/SCENE.
#
# Usage:
#   python3 tools/make_portrait_pack.py greek SHEET.png [--world s72-es] [--sheet preview.png]
#   python3 tools/make_portrait_pack.py egypt [--world s72-es] [--sheet preview.png]
#   python3 tools/make_portrait_pack.py action [--world s72-es] [--sheet preview.png]
#   python3 tools/make_portrait_pack.py fantasy [--world s72-es] [--sheet preview.png]
# greek: one 512x512 sheet with the 4 portraits (2x2), not kept in the repo.
# egypt, action, fantasy: one image per advisor in tools/sources/<pack>/<advisor>.png.
# Crop boxes (x0, y0, x1, y1) are in source pixels, hint boxes in crop pixels.
import base64
import io
import json
import pathlib
import sys
import urllib.request

import cv2
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Arch window of the 90x108 game frame: between the columns, above the name plate
WINDOW = (8, 0, 84, 84)

SETS = {
    'greek': {
        'id': 'builtin_greek_portraits',
        'out': 'packs/greek-portraits.json',
        'name': {'es': 'Retratos griegos', 'en': 'Greek portraits'},
        'description': {
            'es': 'Retratos pixel art de ciudadano, hoplita, sabio y diplomático en el marco original.',
            'en': 'Pixel art portraits of citizen, hoplite, scholar and diplomat in the original frame.',
        },
        # Boxes keep the window ratio (76:84) and frame head and torso of each figure
        'crops': {
            'cities': (50, 30, 207, 204),
            'military': (306, 22, 463, 196),
            'research': (57, 278, 214, 452),
            'diplomacy': (302, 285, 459, 459),
        },
        # GrabCut hints: sure figure / sure background
        'figure': {
            'cities': [(55, 20, 95, 70), (30, 85, 125, 165)],
            'military': [(88, 8, 100, 50), (65, 30, 95, 85), (45, 95, 125, 170), (110, 120, 150, 174)],
            'research': [(48, 22, 90, 80), (20, 100, 130, 174), (40, 85, 110, 100)],
            'diplomacy': [(55, 15, 95, 70), (20, 80, 135, 170), (128, 72, 136, 92)],
        },
        'scene': {
            'research': [(6, 8, 42, 80), (100, 15, 152, 72), (128, 72, 152, 92)],
            'diplomacy': [(118, 0, 152, 30), (14, 70, 30, 105)],
        },
    },
    'egypt': {
        'id': 'builtin_egyptian_court',
        'out': 'packs/egyptian-court.json',
        'sources': 'tools/sources/egyptian-court',
        'name': {'es': 'Corte egipcia', 'en': 'Egyptian court'},
        'description': {
            'es': 'Retratos de faraón, general, sacerdote y reina en el marco original.',
            'en': 'Portraits of pharaoh, general, priest and queen in the original frame.',
        },
        'crops': {
            'cities': (0, 0, 161, 178),
            'military': (0, 2, 161, 180),
            'research': (0, 8, 161, 186),
            'diplomacy': (0, 0, 161, 178),
        },
        'figure': {
            'cities': [(70, 8, 90, 40), (50, 25, 110, 45), (55, 40, 105, 95), (35, 40, 55, 130), (105, 40, 125, 130),
                       (70, 90, 90, 130), (10, 130, 150, 176), (110, 95, 135, 140)],
            'military': [(65, 10, 100, 45), (65, 45, 100, 95), (40, 110, 120, 176), (100, 120, 155, 176),
                         (15, 115, 45, 150)],
            'research': [(60, 10, 100, 90), (5, 95, 155, 176)],
            'diplomacy': [(40, 8, 110, 40), (55, 40, 100, 95), (45, 75, 55, 95), (100, 75, 110, 95),
                          (15, 120, 150, 176), (25, 105, 50, 150)],
        },
        'scene': {
            'cities': [(0, 0, 40, 35), (120, 0, 161, 35), (0, 0, 66, 7), (94, 0, 161, 7), (0, 40, 25, 110), (142, 40, 161, 90)],
            'military': [(0, 0, 22, 95), (100, 40, 161, 90), (110, 0, 161, 40), (52, 0, 62, 30), (50, 45, 60, 95)],
            'research': [(0, 0, 45, 85), (110, 0, 161, 85), (0, 0, 161, 7), (135, 80, 161, 92), (0, 80, 20, 95)],
            'diplomacy': [(0, 0, 35, 115), (0, 0, 38, 40), (114, 0, 161, 110), (36, 45, 46, 70), (0, 115, 18, 128), (140, 110, 161, 128)],
        },
    },
    'action': {
        'id': 'builtin_action_heroes',
        'out': 'packs/action-heroes.json',
        'sources': 'tools/sources/action-heroes',
        'name': {'es': 'Héroes de acción', 'en': 'Action heroes'},
        'description': {
            'es': 'Policía duro, cíborg, kickboxer y boxeador soviético al estilo de los 80, en el marco original.',
            'en': 'Tough cop, cyborg, kickboxer and Soviet boxer in 80s action style, in the original frame.',
        },
        'crops': {
            'cities': (0, 5, 161, 183),
            'military': (0, 5, 161, 183),
            'research': (0, 10, 161, 188),
            'diplomacy': (0, 5, 161, 183),
        },
        'figure': {
            'cities': [(45, 10, 105, 35), (45, 35, 100, 105), (20, 115, 150, 176), (17, 40, 28, 105), (20, 125, 55, 165)],
            'military': [(60, 10, 105, 40), (55, 40, 105, 95), (10, 110, 150, 176), (60, 100, 130, 150)],
            'research': [(45, 10, 100, 40), (55, 40, 95, 90), (25, 70, 55, 100), (75, 105, 105, 135),
                         (10, 110, 150, 176), (95, 45, 110, 70)],
            'diplomacy': [(55, 10, 105, 35), (55, 35, 105, 95), (15, 105, 145, 176)],
        },
        'scene': {
            'cities': [(112, 0, 161, 95), (0, 0, 8, 110), (110, 0, 161, 30)],
            'military': [(0, 0, 45, 95), (125, 0, 161, 90), (0, 0, 161, 4)],
            'research': [(0, 0, 30, 80), (120, 0, 161, 90), (0, 0, 161, 5)],
            'diplomacy': [(0, 0, 40, 90), (122, 0, 161, 90), (0, 0, 161, 4)],
        },
    },
    'fantasy': {
        'id': 'builtin_fantasy_war',
        'out': 'packs/fantasy-war.json',
        'sources': 'tools/sources/fantasy-war',
        'name': {'es': 'Guerra de fantasía', 'en': 'Fantasy war'},
        'description': {
            'es': 'Príncipe caído, cazador de demonios, hechicera de hielo y caudillo orco al estilo de la estrategia de fantasía, en el marco original.',
            'en': 'Fallen prince, demon hunter, frost sorceress and orc warchief in fantasy strategy style, in the original frame.',
        },
        'crops': {
            'cities': (0, 8, 161, 186),
            'military': (10, 12, 150, 167),
            'research': (0, 8, 161, 186),
            'diplomacy': (0, 5, 161, 183),
        },
        'figure': {
            # Fallen prince: hair, face, upright runeblade, armour
            'cities': [(60, 10, 90, 40), (65, 40, 95, 80), (47, 42, 58, 112), (106, 24, 118, 87), (10, 82, 150, 178)],
            # Demon hunter: head, horns, torso and blades; wings stay in the scene so the glow shows
            'military': [(62, 30, 90, 80), (50, 35, 90, 100), (20, 88, 130, 155), (0, 73, 12, 130),
                         (124, 80, 138, 130), (40, 10, 48, 28), (102, 10, 110, 28)],
            # Frost sorceress: hair, face, staff with crystal, robes
            'research': [(60, 15, 95, 30), (60, 35, 100, 80), (40, 40, 52, 100), (105, 32, 130, 100),
                         (20, 100, 150, 178), (5, 2, 30, 45), (28, 45, 36, 178)],
            # Red orc warchief: hair, face, axe blade and haft, shoulder, chest
            'diplomacy': [(75, 22, 105, 35), (65, 40, 120, 105), (20, 5, 55, 45), (40, 55, 55, 110),
                          (125, 80, 161, 135), (10, 110, 161, 178)],
        },
        'scene': {
            'cities': [(0, 0, 40, 55), (125, 0, 161, 50), (40, 0, 105, 5)],
            'military': [(55, 0, 85, 23), (0, 0, 34, 65), (114, 0, 140, 65), (0, 138, 15, 155), (130, 138, 140, 155)],
            'research': [(140, 0, 161, 55), (105, 0, 161, 25), (40, 0, 110, 8), (32, 0, 50, 35)],
            'diplomacy': [(75, 0, 161, 18), (125, 10, 161, 70), (0, 60, 25, 110)],
        },
    },
}

ADVISORS = {'cities': 'mayor', 'military': 'general', 'research': 'scientist', 'diplomacy': 'diplomat'}
STATES = {
    'normal': '',
    'active': '_active',
    'alert': '_alert',
    'premium': '_premium',
    'premiumActive': '_premium_active',
    'premiumAlert': '_premium_alert',
}

GOLD_STATES = {'active', 'alert', 'premiumActive', 'premiumAlert'}
# Gold background: light centre to dark rim, in bands with ordered dithering
GOLD = [(122, 78, 18), (176, 118, 26), (222, 164, 44), (248, 206, 92), (255, 236, 160)]
OUTLINE = (58, 34, 8)
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def fetch(world, name):
    url = f'https://{world}.ikariam.gameforge.com/cdn/all/both/layout/advisors/{name}.png'
    try:
        with urllib.request.urlopen(url, timeout=20) as res:
            return Image.open(io.BytesIO(res.read())).convert('RGBA')
    except Exception:
        return None


def window_size():
    return WINDOW[2] - WINDOW[0], WINDOW[3] - WINDOW[1]


def portrait(source, box):
    return source.crop(box).resize(window_size(), Image.LANCZOS).convert('RGBA')


def figure_mask(source, key, cfg):
    # GrabCut on the crop at source resolution, then scaled to the window (hard edge)
    img = cv2.cvtColor(np.array(source.crop(cfg['crops'][key])), cv2.COLOR_RGB2BGR)
    h, w = img.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    mask[:, int(w * 0.1):int(w * 0.9)] = cv2.GC_PR_FGD
    mask[:, :4] = mask[:, -4:] = mask[:3, :] = cv2.GC_BGD
    for x0, y0, x1, y1 in cfg.get('scene', {}).get(key, []):
        mask[y0:y1, x0:x1] = cv2.GC_BGD
    for x0, y0, x1, y1 in cfg['figure'][key]:
        mask[y0:y1, x0:x1] = cv2.GC_FGD
    cv2.grabCut(img, mask, None, np.zeros((1, 65)), np.zeros((1, 65)), 10, cv2.GC_INIT_WITH_MASK)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    small = Image.fromarray(fg).resize(window_size(), Image.LANCZOS)
    return small.point(lambda v: 255 if v >= 128 else 0)


def gold_background():
    w, h = window_size()
    img = Image.new('RGBA', (w, h))
    px = img.load()
    cx, cy = w / 2, h * 0.38
    rmax = ((w / 2) ** 2 + (h * 0.62) ** 2) ** 0.5
    for y in range(h):
        for x in range(w):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5 / rmax
            level = (1 - d) * (len(GOLD) - 1) + 0.6 + BAYER[y % 4][x % 4] / 16 - 0.5
            px[x, y] = GOLD[max(0, min(len(GOLD) - 1, int(level)))] + (255,)
    return img


def gold_portrait(face, mask):
    # Figure over the gold background, with a 1 px dark outline around it
    out = gold_background()
    out.paste(face, (0, 0), mask)
    m = mask.load()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            if m[x, y]:
                continue
            if any(0 <= x + dx < w and 0 <= y + dy < h and m[x + dx, y + dy] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                px[x, y] = OUTLINE + (255,)
    return out


def compose(frame, face):
    out = frame.copy()
    out.paste(face, WINDOW[:2])
    # Columns and name plate of the original stay on top of the portrait
    out.paste(frame.crop((0, 0, WINDOW[0], frame.height)), (0, 0))
    out.paste(frame.crop((WINDOW[2], 0, frame.width, frame.height)), (WINDOW[2], 0))
    out.paste(frame.crop((0, WINDOW[3], frame.width, frame.height)), (0, WINDOW[3]))
    return out


def data_url(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    cfg = SETS[sys.argv[1]]
    world = arg('--world', 's72-es')
    out_path = ROOT / cfg['out']
    if 'sources' in cfg:
        sources = {key: Image.open(ROOT / cfg['sources'] / f'{key}.png').convert('RGB') for key in ADVISORS}
    else:
        sheet = Image.open(sys.argv[2]).convert('RGB')
        sources = {key: sheet for key in ADVISORS}

    rendered = {}
    for key, base in ADVISORS.items():
        face = portrait(sources[key], cfg['crops'][key])
        gold = gold_portrait(face, figure_mask(sources[key], key, cfg))
        rendered[key] = {}
        for state, suffix in STATES.items():
            frame = fetch(world, base + suffix)
            if frame is not None:
                rendered[key][state] = compose(frame, gold if state in GOLD_STATES else face)
        print(f'{key}: {", ".join(rendered[key])}')

    pack = {
        'format': 'ikadios-advisor-pack',
        'version': 1,
        'id': cfg['id'],
        'name': cfg['name'],
        'author': 'IkaDios',
        'description': cfg['description'],
        'pixelated': True,
        'fit': 'fill',
        'advisors': {key: {state: data_url(img) for state, img in states.items()} for key, states in rendered.items()},
    }
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(pack, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{out_path.relative_to(ROOT)}: {out_path.stat().st_size // 1024} KB')

    sheet_path = arg('--sheet', None)
    if sheet_path:
        scale = 2
        cell_w, cell_h = 90 * scale + 10, 108 * scale + 10
        sheet = Image.new('RGBA', (cell_w * len(STATES), cell_h * len(ADVISORS)), (58, 109, 140, 255))
        for row, key in enumerate(ADVISORS):
            for col, state in enumerate(STATES):
                img = rendered[key].get(state)
                if img:
                    big = img.resize((90 * scale, 108 * scale), Image.NEAREST)
                    sheet.paste(big, (col * cell_w + 5, row * cell_h + 5), big)
        sheet.save(sheet_path)


if __name__ == '__main__':
    main()
