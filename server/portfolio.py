"""What the admin can do: save drafts, upload images and the resume, publish, roll back."""
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from . import images, render
from .store import Store, atomic_write
from .validation import IMAGE_RE, validate_drafts

RESUME_NAME = "AnastasiaChengResume.pdf"
MAX_RESUME = 10 * 1024 * 1024


class ResumeError(ValueError):
    pass


def _public(project):
    """The published copy of a draft: everything except the editor-only hidden flag."""
    return {k: v for k, v in project.items() if k != "hidden"}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Portfolio:
    def __init__(self, state_dir, site_dir, template_path):
        self.store = Store(state_dir)
        self.uploads = Path(state_dir) / "uploads"
        self.resume_history = Path(state_dir) / "resume-history"
        self.site = Path(site_dir)
        self.template_path = Path(template_path)
        self.uploads.mkdir(parents=True, exist_ok=True)
        self.resume_history.mkdir(parents=True, exist_ok=True)

    # ---- Reading ----

    def view(self, state=None):
        """State plus what the editor needs to show: per-project status and whether a publish is pending."""
        state = state or self.store.load()
        live = {p["id"]: p for p in state["published"]}
        status = {}
        for d in state["drafts"]:
            if d["id"] not in live:
                status[d["id"]] = "hidden" if d["hidden"] else "new"
            elif d["hidden"]:
                status[d["id"]] = "hiding"
            else:
                status[d["id"]] = "live" if _public(d) == live[d["id"]] else "changed"
        pending = [_public(d) for d in state["drafts"] if not d["hidden"]] != state["published"]
        return {
            "revision": state["revision"],
            "drafts": state["drafts"],
            "status": status,
            "pending": pending,
            "publishedAt": state["publishedAt"],
            "canRestore": state["previous"] is not None,
            "resumeVersion": state["resumeVersion"] or render.parse_resume_version(self._template()),
        }

    def image_path(self, name):
        path = self.uploads / name
        return path if IMAGE_RE.match(name) and path.is_file() else None

    # ---- Changing ----

    def save_drafts(self, revision, raw):
        drafts = validate_drafts(raw, lambda name: self.image_path(name) is not None)
        return self.view(self.store.update(lambda s: s.update(drafts=drafts), revision))

    def add_image(self, data):
        name = images.new_name()
        atomic_write(self.uploads / name, images.to_webp(data))
        return name

    def publish(self, revision):
        def change(state):
            state["previous"] = {"published": state["published"], "publishedAt": state["publishedAt"]}
            state["published"] = [_public(d) for d in state["drafts"] if not d["hidden"]]
            state["publishedAt"] = _now()
            self._write_site(state)
        return self.view(self.store.update(change, revision))

    def restore_previous(self, revision):
        """Swap the live site with the version before it. Doing it twice swaps back."""
        def change(state):
            if state["previous"] is None:
                raise ValueError("There is no earlier version to restore")
            current = {"published": state["published"], "publishedAt": state["publishedAt"]}
            state["published"] = state["previous"]["published"]
            state["publishedAt"] = state["previous"]["publishedAt"]
            state["previous"] = current
            self._write_site(state)
        return self.view(self.store.update(change, revision))

    def replace_resume(self, data):
        if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-2048:]:
            raise ResumeError("That file isn't a PDF")
        if len(data) > MAX_RESUME:
            raise ResumeError("The resume must be under 10 MB")

        def change(state):
            target = self.site / "assets" / RESUME_NAME
            if target.exists():
                shutil.copy2(target, self.resume_history / f"{time.strftime('%Y%m%d-%H%M%S')}-{RESUME_NAME}")
            atomic_write(target, data)
            current = state["resumeVersion"] or render.parse_resume_version(self._template()) or 0
            state["resumeVersion"] = current + 1   # new ?v= so browsers don't show a cached copy
            self._write_site(state)
        return self.view(self.store.update(change))

    def render_site(self):
        """Rebuild index.html from the current template, e.g. after a deploy."""
        self._write_site(self.store.load())

    # ---- Writing the public site ----

    def _template(self):
        return self.template_path.read_text()

    def _write_site(self, state):
        page = render.render_page(self._template(), state["published"], state["resumeVersion"])
        project_dir = self.site / "assets" / "projects"
        project_dir.mkdir(parents=True, exist_ok=True)
        needed = {p["image"]["file"] for p in state["published"] if p["image"]}
        # Images first, then the page that points at them, then clean up old images.
        for name in needed:
            if not (project_dir / name).exists():
                atomic_write(project_dir / name, (self.uploads / name).read_bytes())
        atomic_write(self.site / "index.html", page)
        for old in project_dir.glob("*.webp"):
            if old.name not in needed:
                old.unlink()
