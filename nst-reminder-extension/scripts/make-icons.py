import os
import struct
import zlib


def write_png(path, size, rgb):
    def chunk(typ, data):
        out = struct.pack(">I", len(data)) + typ + data
        return out + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


os.makedirs("icons", exist_ok=True)
for s in (16, 32, 48, 128):
    write_png(f"icons/icon{s}.png", s, (79, 70, 229))
print("wrote icons/icon{16,32,48,128}.png")
