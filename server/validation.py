"""Server-side checks for project drafts. Mirrors js/project-utils.js; never trust the browser."""
import re
from urllib.parse import urlsplit

LIMITS = {"title": 80, "description": 400, "tag": 30, "tags": 10, "alt": 150, "url": 500, "projects": 50}
ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
IMAGE_RE = re.compile(r"^[0-9a-f]{32}\.webp$")


class ValidationError(ValueError):
    pass


def _text(value, name, limit, required=False):
    if not isinstance(value, str):
        raise ValidationError(f"{name} must be text")
    value = value.strip()
    if required and not value:
        raise ValidationError(f"{name} is required")
    if len(value) > limit:
        raise ValidationError(f"{name} is longer than {limit} characters")
    return value


def _url(value, name):
    value = _text(value, name, LIMITS["url"])
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValidationError(f"{name} must start with http:// or https://")
    return value


def _project(raw, image_exists):
    if not isinstance(raw, dict):
        raise ValidationError("must be an object")
    if not isinstance(raw.get("id"), str) or not ID_RE.match(raw["id"]):
        raise ValidationError("has an invalid id")
    tags = raw.get("tags", [])
    if not isinstance(tags, list) or len(tags) > LIMITS["tags"]:
        raise ValidationError(f"can have at most {LIMITS['tags']} tags")
    tags = [_text(tag, "Tag", LIMITS["tag"]) for tag in tags]

    image = raw.get("image")
    if image is not None:
        if not isinstance(image, dict) or not IMAGE_RE.match(str(image.get("file", ""))):
            raise ValidationError("has an invalid image")
        if not image_exists(image["file"]):
            raise ValidationError("refers to an image that was never uploaded")
        image = {"file": image["file"], "alt": _text(image.get("alt", ""), "Image description", LIMITS["alt"], True)}

    # Fixed key order, so published and draft copies compare equal when unchanged.
    return {
        "id": raw["id"],
        "title": _text(raw.get("title", ""), "Title", LIMITS["title"], True),
        "description": _text(raw.get("description", ""), "Description", LIMITS["description"], True),
        "tags": [tag for tag in tags if tag],
        "image": image,
        "docsUrl": _url(raw.get("docsUrl", ""), "Documentation link"),
        "siteUrl": _url(raw.get("siteUrl", ""), "Website link"),
        "hidden": raw.get("hidden") is True,
    }


def validate_drafts(raw, image_exists):
    if not isinstance(raw, list) or len(raw) > LIMITS["projects"]:
        raise ValidationError(f"Drafts must be a list of at most {LIMITS['projects']} projects")
    drafts = []
    for i, item in enumerate(raw, 1):
        try:
            drafts.append(_project(item, image_exists))
        except ValidationError as err:
            raise ValidationError(f"Project {i}: {err}") from None
    if len({d["id"] for d in drafts}) != len(drafts):
        raise ValidationError("Two projects share the same id")
    return drafts
