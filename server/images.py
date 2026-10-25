"""Turns an uploaded image into a resized WebP with metadata (including GPS) stripped."""
import secrets
import subprocess

MAX_UPLOAD = 15 * 1024 * 1024
MAX_SIDE = 1200


class ImageError(ValueError):
    pass


# Decide the format from the file's first bytes, not its name or the browser's claim.
def sniff(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def to_webp(data):
    fmt = sniff(data)
    if not fmt:
        raise ImageError("Only PNG, JPEG, WebP, or GIF images are allowed")
    cmd = [
        "convert", "-limit", "memory", "256MiB", "-limit", "width", "16000", "-limit", "height", "16000",
        f"{fmt}:-[0]",                            # first frame only, read from stdin
        "-auto-orient", "-strip",                 # rotate phone photos upright, drop EXIF/GPS
        "-resize", f"{MAX_SIDE}x{MAX_SIDE}>",     # shrink only, never enlarge
        "-quality", "82", "webp:-",
    ]
    try:
        out = subprocess.run(cmd, input=data, capture_output=True, timeout=60, check=True).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise ImageError("That image couldn't be processed") from None
    if sniff(out) != "webp":
        raise ImageError("That image couldn't be processed")
    return out


def new_name():
    return secrets.token_hex(16) + ".webp"
