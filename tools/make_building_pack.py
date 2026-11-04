#!/usr/bin/env python3
"""Adds city view building skins to an advisor pack.

Sources are tools/sources/<set>/<buildingType>.png: one isometric building on a
flat magenta (#FF00FF) background, seen from the front-left like the game's
<type>_l.png images (generated with Canva). Each one is cut out with a chroma key,
cropped to the building, scaled to fit the game's image box for that type and
anchored at the bottom center, then stored as pack.buildings[type] (PNG data URL).
Only the "buildings" section of the pack file is replaced.

Usage: python3 tools/make_building_pack.py egypt
"""
import base64
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# Size of div.buildingimg per type in the city view (read from the game: most
# types use 172x140, see CLAUDE.md)
BOX = {
    'port': (209, 148),
    'shipyard': (191, 126),
    'wall': (201, 111),
    'pirateFortress': (340, 250),
}
DEFAULT_BOX = (172, 140)
# Share of the box the game's own art covers (measured on academy, warehouse and
# town hall: about 140 of 172 px wide, 120 of 140 px tall, 12 px free below)
CONTENT_W, CONTENT_H, BOTTOM_GAP = 0.85, 0.87, 12 / 140
# Types whose game art fills more of its box (measured the same way)
CONTENT = {
    'wall': (0.99, 0.97, 2 / 111),
    'port': (0.96, 0.91, 12 / 150),
    'shipyard': (0.89, 0.96, 5 / 126),
    'pirateFortress': (0.88, 0.87, 18 / 250),
}

SETS = {
    'egypt': {
        'sources': 'tools/sources/egyptian-buildings',
        'out': 'packs/egyptian-court.json',
    },
}

KEY = np.array([255, 0, 255], dtype=np.float32)
# Distance to the key color: below LOW fully transparent, above HIGH fully opaque
LOW, HIGH = 90.0, 190.0


def near_background(alpha, radius=2):
    # True within `radius` px of a (mostly) transparent pixel
    clear = alpha < 0.5
    near = clear.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            near |= np.roll(np.roll(clear, dy, axis=0), dx, axis=1)
    return near


def cut_out(img):
    rgb = np.asarray(img.convert('RGB'), dtype=np.float32)
    dist = np.linalg.norm(rgb - KEY, axis=2)
    alpha = np.clip((dist - LOW) / (HIGH - LOW), 0, 1)
    # Opaque-looking edge pixels that still carry a magenta tint (red and blue
    # well above green) or the blue-violet of water blended with the key (blue
    # well above green) are mostly background
    tint = np.maximum(np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1], rgb[..., 2] - rgb[..., 1] - 20)
    edge = near_background(alpha) & (tint > 40)
    alpha = np.where(edge, alpha * np.clip(1 - (tint - 40) / 80, 0.15, 1), alpha)
    # Unmix the edge: an edge pixel is alpha * color + (1 - alpha) * key, so the
    # key's share is removed instead of leaving a magenta or violet fringe
    a = alpha[..., None]
    out = np.where(a > 0.05, (rgb - (1 - a) * KEY) / np.maximum(a, 0.05), rgb)
    # Whatever magenta remains (red and blue both above green) is pulled down
    spill = np.minimum(out[..., 0], out[..., 2]) - out[..., 1]
    excess = np.where((spill > 0) & (alpha < 1), spill, 0)
    out[..., 0] -= excess
    out[..., 2] -= excess
    rgba = np.dstack([np.clip(out, 0, 255), alpha * 255]).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA')


def fit(img, box, kind):
    content_w, content_h, bottom_gap = CONTENT.get(kind, (CONTENT_W, CONTENT_H, BOTTOM_GAP))
    bbox = img.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox()
    img = img.crop(bbox)
    scale = min(box[0] * content_w / img.width, box[1] * content_h / img.height)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    img = img.resize(size, Image.LANCZOS)
    canvas = Image.new('RGBA', box, (0, 0, 0, 0))
    gap = round(box[1] * bottom_gap)
    canvas.alpha_composite(img, ((box[0] - size[0]) // 2, box[1] - gap - size[1]))
    return canvas


def data_url(img):
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def main():
    cfg = SETS[sys.argv[1]]
    sources = sorted((ROOT / cfg['sources']).glob('*.png'))
    out_path = ROOT / cfg['out']
    pack = json.loads(out_path.read_text(encoding='utf-8'))
    buildings = {}
    for src in sources:
        kind = src.stem
        box = BOX.get(kind, DEFAULT_BOX)
        buildings[kind] = data_url(fit(cut_out(Image.open(src)), box, kind))
        print(f'{kind}: {box[0]}x{box[1]}, {len(buildings[kind]) // 1024} KB')
    pack['buildings'] = buildings
    out_path.write_text(json.dumps(pack, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{out_path.relative_to(ROOT)}: {out_path.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
