"""State file on disk: drafts, the published snapshot, and the one before it."""
import json
import os
import tempfile
import threading
from pathlib import Path

HISTORY_KEEP = 50


def atomic_write(path, data, mode=0o644):
    """Write to a temp file in the same folder, then rename, so readers never see half a file."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode())
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)   # mkstemp creates 0600; Caddy needs to read public files
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Conflict(Exception):
    pass


class Store:
    def __init__(self, state_dir):
        self.dir = Path(state_dir)
        self.path = self.dir / "state.json"
        self.history = self.dir / "history"
        self.lock = threading.Lock()
        self.history.mkdir(parents=True, exist_ok=True)

    def load(self):
        if not self.path.exists():
            return {"revision": 0, "drafts": [], "published": [], "publishedAt": None,
                    "previous": None, "resumeVersion": None}
        return json.loads(self.path.read_text())

    def update(self, change, expected_revision=None):
        """Apply change(state) under the lock. A stale revision means another tab saved first."""
        with self.lock:
            state = self.load()
            if expected_revision is not None and expected_revision != state["revision"]:
                raise Conflict("The projects were changed somewhere else. Reload to get the latest.")
            change(state)
            state["revision"] += 1
            data = json.dumps(state, indent=2)
            atomic_write(self.path, data, 0o600)
            atomic_write(self.history / f"state-{state['revision']:06d}.json", data, 0o600)
            for old in sorted(self.history.glob("state-*.json"))[:-HISTORY_KEEP]:
                old.unlink()
            return state
