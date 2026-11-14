"""Draws the Tessera mosaic mark as the app icon (PNG, 1024 and 256). Run: uv run --project model python app/assets/make_icon.py"""
import struct, zlib, pathlib
import numpy as np

NAVY, SAND, TERRA = (0x14, 0x21, 0x3D), (0xF4, 0xEF, 0xE6), (0xE0, 0x8A, 0x5C)
S = 2048  # drawn at twice the size, then halved, for smooth edges


def rect(mask, x0, y0, x1, y1):
    mask[int(y0):int(y1), int(x0):int(x1)] = True


def draw():
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64) + 0.5
    img = np.zeros((S, S, 4), np.float64)
    # macOS-style plate: a rounded square inset from the canvas edge
    inset, radius = 200.0, 370.0
    lo, hi = inset + radius, S - inset - radius
    dx = np.maximum(np.maximum(lo - xx, xx - hi), 0)
    dy = np.maximum(np.maximum(lo - yy, yy - hi), 0)
    plate = (dx * dx + dy * dy) <= radius * radius
    img[plate] = (*NAVY, 255)
    # the mosaic: a 64-unit grid scaled into the plate
    u = 17.0
    ox = oy = S / 2 - 32 * u
    def box(x, y, w, h):
        m = np.zeros((S, S), bool)
        rect(m, ox + x * u, oy + y * u, ox + (x + w) * u, oy + (y + h) * u)
        return m
    solid = box(6, 6, 24, 24)
    accent = box(34, 34, 24, 24)
    outline = (box(32, 4, 28, 28) & ~box(36, 8, 20, 20)) | (box(4, 32, 28, 28) & ~box(8, 36, 20, 20))
    img[solid | outline] = (*SAND, 255)
    img[accent] = (*TERRA, 255)
    return img


def halve(img):
    return img.reshape(img.shape[0] // 2, 2, img.shape[1] // 2, 2, 4).mean(axis=(1, 3))


def png(path, img):
    a = np.clip(np.rint(img), 0, 255).astype(np.uint8)
    h, w, _ = a.shape
    raw = b"".join(b"\x00" + a[r].tobytes() for r in range(h))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


here = pathlib.Path(__file__).parent
big = halve(draw())
png(here / "icon.png", big)
png(here / "icon-256.png", halve(halve(big)))
print("wrote", here / "icon.png", here / "icon-256.png")
