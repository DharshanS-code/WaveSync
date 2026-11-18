#!/usr/bin/env python3
"""Generate WaveSync's original logo, app icons, and social preview.

Usage: python3 -I scripts/generate-assets.py [project-root]
Uses only the Python standard library and writes only the named WaveSync assets.
"""

from __future__ import annotations

import binascii
import math
import struct
import sys
import zlib
from pathlib import Path

CORAL = (214, 95, 87, 255)
CORAL_DARK = (190, 70, 65, 255)
INK = (34, 30, 29, 255)
PAPER = (250, 247, 243, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)

# Two offset wave bars: synchronized motion without a musical-note cliché.
WAVES = (
    ((0.22, 0.38), (0.36, 0.28), (0.50, 0.38), (0.64, 0.48), (0.78, 0.38)),
    ((0.22, 0.62), (0.36, 0.52), (0.50, 0.62), (0.64, 0.72), (0.78, 0.62)),
)

GLYPHS = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "G": ("01111", "10000", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "N": ("10001", "11001", "11001", "10101", "10011", "10011", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    ".": ("00000", "00000", "00000", "00000", "00000", "00110", "00110"),
    " ": ("00000",) * 7,
}


def blend(dst: tuple[int, int, int, int], src: tuple[int, int, int, int], coverage: float) -> tuple[int, int, int, int]:
    alpha = src[3] / 255 * coverage
    dst_alpha = dst[3] / 255
    out_alpha = alpha + dst_alpha * (1 - alpha)
    if out_alpha == 0:
        return TRANSPARENT
    return tuple(
        round((src[i] * alpha + dst[i] * dst_alpha * (1 - alpha)) / out_alpha)
        for i in range(3)
    ) + (round(out_alpha * 255),)


class Canvas:
    def __init__(self, width: int, height: int, color: tuple[int, int, int, int]) -> None:
        self.width = width
        self.height = height
        self.pixels = bytearray(color * (width * height))

    def pixel(self, x: int, y: int) -> tuple[int, int, int, int]:
        offset = (y * self.width + x) * 4
        return tuple(self.pixels[offset:offset + 4])  # type: ignore[return-value]

    def put(self, x: int, y: int, color: tuple[int, int, int, int], coverage: float = 1) -> None:
        if 0 <= x < self.width and 0 <= y < self.height and coverage > 0:
            offset = (y * self.width + x) * 4
            self.pixels[offset:offset + 4] = bytes(blend(self.pixel(x, y), color, min(coverage, 1)))

    def rectangle(self, x: int, y: int, width: int, height: int, color: tuple[int, int, int, int]) -> None:
        row = bytes(color * width)
        for py in range(max(y, 0), min(y + height, self.height)):
            start = (py * self.width + max(x, 0)) * 4
            clipped = min(x + width, self.width) - max(x, 0)
            if clipped > 0:
                self.pixels[start:start + clipped * 4] = row[:clipped * 4]

    def rounded_rectangle(self, x: float, y: float, width: float, height: float, radius: float,
                          color: tuple[int, int, int, int]) -> None:
        samples = ((0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75))
        for py in range(max(0, math.floor(y)), min(self.height, math.ceil(y + height))):
            for px in range(max(0, math.floor(x)), min(self.width, math.ceil(x + width))):
                hits = 0
                for sx, sy in samples:
                    qx = max(x + radius, min(px + sx, x + width - radius))
                    qy = max(y + radius, min(py + sy, y + height - radius))
                    if (px + sx - qx) ** 2 + (py + sy - qy) ** 2 <= radius ** 2:
                        hits += 1
                if hits:
                    self.put(px, py, color, hits / len(samples))

    def line(self, start: tuple[float, float], end: tuple[float, float], width: float,
             color: tuple[int, int, int, int]) -> None:
        x1, y1 = start
        x2, y2 = end
        radius = width / 2
        min_x = max(0, math.floor(min(x1, x2) - radius - 1))
        max_x = min(self.width, math.ceil(max(x1, x2) + radius + 1))
        min_y = max(0, math.floor(min(y1, y2) - radius - 1))
        max_y = min(self.height, math.ceil(max(y1, y2) + radius + 1))
        dx, dy = x2 - x1, y2 - y1
        length_squared = dx * dx + dy * dy
        for py in range(min_y, max_y):
            for px in range(min_x, max_x):
                vx, vy = px + 0.5 - x1, py + 0.5 - y1
                t = max(0, min(1, (vx * dx + vy * dy) / length_squared))
                distance = math.hypot(px + 0.5 - (x1 + t * dx), py + 0.5 - (y1 + t * dy))
                coverage = max(0, min(1, radius + 0.5 - distance))
                self.put(px, py, color, coverage)

    def polyline(self, points: tuple[tuple[float, float], ...], width: float,
                 color: tuple[int, int, int, int]) -> None:
        for start, end in zip(points, points[1:]):
            self.line(start, end, width, color)

    def text(self, value: str, x: int, y: int, scale: int, color: tuple[int, int, int, int]) -> None:
        cursor = x
        for character in value.upper():
            glyph = GLYPHS[character]
            for row, pattern in enumerate(glyph):
                for column, enabled in enumerate(pattern):
                    if enabled == "1":
                        self.rectangle(cursor + column * scale, y + row * scale, scale, scale, color)
            cursor += 6 * scale

    def write_png(self, path: Path) -> None:
        raw = bytearray()
        stride = self.width * 4
        for y in range(self.height):
            raw.append(0)
            raw.extend(self.pixels[y * stride:(y + 1) * stride])

        def chunk(kind: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 6, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        png += chunk(b"IEND", b"")
        path.write_bytes(png)


def draw_mark(canvas: Canvas, x: float, y: float, size: float, *, rounded: bool, color=CORAL) -> None:
    radius = size * (0.16 if rounded else 0)
    canvas.rounded_rectangle(x, y, size, size, radius, color)
    for wave in WAVES:
        points = tuple((x + px * size, y + py * size) for px, py in wave)
        canvas.polyline(points, size * 0.075, WHITE)


def svg_mark(background: str, wave: str, *, mono: bool = False) -> str:
    wave_paths = "".join(
        '<path d="' + " ".join(("M" if index == 0 else "L") + f"{x * 64:g} {y * 64:g}" for index, (x, y) in enumerate(points)) + '"/>'
        for points in WAVES
    )
    if mono:
        return (f'<mask id="cut"><path fill="white" d="M10 0h44a10 10 0 0 1 10 10v44a10 10 0 0 1-10 10H10A10 10 0 0 1 0 54V10A10 10 0 0 1 10 0z"/>'
                f'<g fill="none" stroke="black" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">{wave_paths}</g></mask>'
                '<path fill="currentColor" mask="url(#cut)" d="M10 0h44a10 10 0 0 1 10 10v44a10 10 0 0 1-10 10H10A10 10 0 0 1 0 54V10A10 10 0 0 1 10 0z"/>')
    return (f'<path fill="{background}" d="M10 0h44a10 10 0 0 1 10 10v44a10 10 0 0 1-10 10H10A10 10 0 0 1 0 54V10A10 10 0 0 1 10 0z"/>'
            f'<g fill="none" stroke="{wave}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">{wave_paths}</g>')


def svg_document(body: str, view_box: str, title: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" role="img" aria-labelledby="title"><title id="title">{title}</title>{body}</svg>\n'


def lockup(mark: str, text_color: str) -> str:
    word = ('<text x="82" y="43" fill="' + text_color + '" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" '
            'font-size="30" font-weight="700" letter-spacing="2">WAVESYNC</text>')
    return svg_document(mark + word, "0 0 272 64", "WaveSync")


def generate(root: Path) -> list[Path]:
    assets = root / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    vectors = {
        "wavesync-mark-light.svg": svg_document(svg_mark("#D65F57", "#fff"), "0 0 64 64", "WaveSync mark"),
        "wavesync-mark-dark.svg": svg_document(svg_mark("#E8746C", "#fff"), "0 0 64 64", "WaveSync mark"),
        "wavesync-mark-mono.svg": svg_document(svg_mark("", "", mono=True), "0 0 64 64", "WaveSync mark"),
        "wavesync-lockup-light.svg": lockup(svg_mark("#D65F57", "#fff"), "#221E1D"),
        "wavesync-lockup-dark.svg": lockup(svg_mark("#E8746C", "#fff"), "#FAF7F3"),
        "wavesync-lockup-mono.svg": lockup(svg_mark("", "", mono=True), "currentColor"),
        "favicon.svg": svg_document(svg_mark("#D65F57", "#fff"), "0 0 64 64", "WaveSync"),
    }
    for name, content in vectors.items():
        path = assets / name
        path.write_text(content, encoding="utf-8")
        written.append(path)

    for name, size, maskable in (
        ("apple-touch-icon-180.png", 180, True),
        ("wavesync-icon-192.png", 192, False),
        ("wavesync-icon-512.png", 512, False),
        ("wavesync-maskable-192.png", 192, True),
        ("wavesync-maskable-512.png", 512, True),
    ):
        canvas = Canvas(size, size, CORAL if maskable else TRANSPARENT)
        if maskable:
            draw_mark(canvas, size * 0.18, size * 0.18, size * 0.64, rounded=False, color=CORAL_DARK)
        else:
            draw_mark(canvas, size * 0.08, size * 0.08, size * 0.84, rounded=True)
        path = assets / name
        canvas.write_png(path)
        written.append(path)

    share = Canvas(1200, 630, PAPER)
    share.rounded_rectangle(80, 95, 440, 440, 72, (238, 229, 222, 255))
    draw_mark(share, 150, 165, 300, rounded=True)
    share.text("WAVESYNC", 580, 215, 12, INK)
    share.text("LISTEN TOGETHER.", 584, 350, 5, CORAL_DARK)
    share.text("STAY IN SYNC.", 584, 410, 5, INK)
    share_path = assets / "wavesync-share-1200x630.png"
    share.write_png(share_path)
    written.append(share_path)

    share_svg = svg_document(
        '<path fill="#FAF7F3" d="M0 0h1200v630H0z"/>'
        '<rect x="80" y="95" width="440" height="440" rx="72" fill="#EEE5DE"/>'
        '<g transform="translate(150 165) scale(4.6875)">' + svg_mark("#D65F57", "#fff") + '</g>'
        '<text x="580" y="300" fill="#221E1D" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="78" font-weight="700" letter-spacing="5">WAVESYNC</text>'
        '<text x="584" y="382" fill="#BE4641" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="32" font-weight="650" letter-spacing="2">LISTEN TOGETHER.</text>'
        '<text x="584" y="430" fill="#221E1D" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="32" font-weight="650" letter-spacing="2">STAY IN SYNC.</text>',
        "0 0 1200 630", "WaveSync — Listen together. Stay in sync."
    )
    share_svg_path = assets / "wavesync-share.svg"
    share_svg_path.write_text(share_svg, encoding="utf-8")
    written.append(share_svg_path)
    return written


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent).resolve()
    written = generate(root)
    for path in written:
        print(path.relative_to(root))


if __name__ == "__main__":
    main()
