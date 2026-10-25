"""Admin backend. Caddy sends /admin* here; everything else stays a static site."""
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .images import MAX_UPLOAD, ImageError
from .portfolio import MAX_RESUME, Portfolio, ResumeError
from .store import Conflict, atomic_write
from .validation import ValidationError

ROOT = Path(__file__).resolve().parent.parent
SESSION_IDLE_SECONDS = 8 * 3600          # signed out after 8 hours with no activity
SESSION_MAX_SECONDS = 7 * 24 * 3600      # and always after 7 days
SESSION_WRITE_EVERY = 5 * 60             # how often activity is saved to disk, to avoid a write per request
FAILURE_WINDOW = 15 * 60
MAX_FAILURES_PER_IP = 5
MAX_FAILURES_TOTAL = 50

# Public, non-secret files the admin pages load. Anything else under /admin/static/ is a 404.
STATIC = {
    "editor.js": "admin/editor.js",
    "editor.css": "admin/editor.css",
    "site.css": "style.css",
    "js/project-card.js": "js/project-card.js",
    "js/project-utils.js": "js/project-utils.js",
}

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; "
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    # Not "no-referrer": that makes browsers send "Origin: null" on form posts, which the origin check rejects.
    "Referrer-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow",
}


class Config:
    def __init__(self, env=os.environ):
        self.port = int(env.get("PORTFOLIO_PORT", "8091"))
        self.state_dir = Path(env.get("PORTFOLIO_STATE_DIR", ROOT / ".dev/state"))
        self.site_dir = Path(env.get("PORTFOLIO_SITE_DIR", ROOT / ".dev/site"))
        self.template = Path(env.get("PORTFOLIO_TEMPLATE", ROOT / "index.html"))
        self.password_file = Path(env.get("PORTFOLIO_PASSWORD_FILE", "/etc/.mywebsite_password"))
        self.username = env.get("PORTFOLIO_USERNAME", "abc")
        default_origin = f"http://127.0.0.1:{self.port}"
        self.origins = {o.strip() for o in env.get("PORTFOLIO_ALLOWED_ORIGINS", default_origin).split(",") if o.strip()}
        self.secure_cookie = env.get("PORTFOLIO_SECURE_COOKIE", "1") == "1"
        # Local development only: also serve the generated public site at /.
        self.serve_site = env.get("PORTFOLIO_SERVE_SITE") == "1"


class Auth:
    def __init__(self, config):
        self.config = config
        # Sessions are kept on disk so a restart or deploy doesn't sign anyone out.
        # Only a hash of each token is stored, so the file alone can't be used to sign in.
        self.session_file = Path(config.state_dir) / "sessions.json"
        self.sessions = {}       # sha256(token) -> {"created": t, "seen": t}
        self.failures = {}       # ip -> [failure times]
        self.lock = threading.Lock()
        try:
            self.sessions = json.loads(self.session_file.read_text())
        except (OSError, ValueError):
            pass

    @staticmethod
    def _key(token):
        return hashlib.sha256((token or "").encode()).hexdigest()

    def _alive(self, session, now):
        # The slack covers activity not yet written to disk when the service restarts,
        # so the idle limit is never shorter than 8 hours.
        idle_limit = SESSION_IDLE_SECONDS + SESSION_WRITE_EVERY
        return now - session["seen"] < idle_limit and now - session["created"] < SESSION_MAX_SECONDS

    def _save(self):
        self.session_file.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(self.session_file, json.dumps(self.sessions), 0o600)

    def _recent(self, times, now):
        return [t for t in times if now - t < FAILURE_WINDOW]

    def locked_out(self, ip):
        now = time.time()
        with self.lock:
            self.failures = {k: v for k, v in ((k, self._recent(v, now)) for k, v in self.failures.items()) if v}
            total = sum(len(v) for v in self.failures.values())
            return len(self.failures.get(ip, [])) >= MAX_FAILURES_PER_IP or total >= MAX_FAILURES_TOTAL

    def check_password(self, ip, username, password):
        # The file is read on every attempt, so changing it takes effect without a restart.
        try:
            expected = self.config.password_file.read_text().strip()
        except OSError:
            expected = ""   # unreadable file: nobody can sign in, rather than a crash
        ok_user = hmac.compare_digest(username.encode(), self.config.username.encode())
        ok_pass = hmac.compare_digest(password.encode(), expected.encode())
        if ok_user and ok_pass and expected:
            return True
        with self.lock:
            self.failures.setdefault(ip, []).append(time.time())
        return False

    def new_session(self):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.lock:
            self.sessions = {k: v for k, v in self.sessions.items() if self._alive(v, now)}
            self.sessions[self._key(token)] = {"created": now, "seen": now}
            self._save()
        return token

    def valid(self, token):
        """True if the session is live. Any activity restarts the 8-hour idle clock."""
        key, now = self._key(token), time.time()
        with self.lock:
            session = self.sessions.get(key)
            if not session or not self._alive(session, now):
                if self.sessions.pop(key, None):
                    self._save()
                return False
            persisted = session.get("saved", session["seen"])
            session["seen"] = now
            if now - persisted > SESSION_WRITE_EVERY:
                session["saved"] = now
                self._save()
            return True

    def end(self, token):
        with self.lock:
            if self.sessions.pop(self._key(token), None):
                self._save()


class Handler(BaseHTTPRequestHandler):
    server_version = "portfolio-admin"
    sys_version = ""

    # ---- Helpers ----

    @property
    def app(self):
        return self.server.app

    def client_ip(self):
        # Caddy replaces X-Forwarded-For with the real client address.
        return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[-1].strip()

    def session_token(self):
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == "portfolio_session":
                return value
        return None

    def signed_in(self):
        return self.app.auth.valid(self.session_token())

    def same_origin(self):
        # Blocks other websites from submitting forms or requests on the admin's behalf.
        return self.headers.get("Origin") in self.app.config.origins

    def send(self, status, body=b"", content_type="text/plain; charset=utf-8", headers=None):
        self.send_response(status)
        for name, value in {**SECURITY_HEADERS, **(headers or {})}.items():
            self.send_header(name, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data):
        self.send(status, json.dumps(data).encode(), "application/json")

    def redirect(self, location, headers=None):
        self.send(HTTPStatus.SEE_OTHER, headers={"Location": location, **(headers or {})})

    def cookie(self, value, max_age):
        secure = "; Secure" if self.app.config.secure_cookie else ""
        return f"portfolio_session={value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"

    def read_body(self, limit):
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            raise ValueError("Missing Content-Length")
        if int(length) > limit:
            raise OverflowError
        return self.rfile.read(int(length))

    def read_json(self):
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            raise ValueError("Expected JSON")
        return json.loads(self.read_body(1024 * 1024))

    def send_file(self, path):
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        self.send(HTTPStatus.OK, path.read_bytes(), ctype)

    def page(self, name, replacements=None):
        text = (ROOT / "admin" / name).read_text()
        for marker, value in (replacements or {}).items():
            text = text.replace(marker, value)
        self.send(HTTPStatus.OK, text.encode(), "text/html; charset=utf-8")

    # ---- Routing ----

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path
        query = parse_qs(urlsplit(self.path).query)
        if path == "/admin":
            return self.redirect("/admin/")
        if path == "/admin/":
            return self.page("editor.html") if self.signed_in() else self.redirect("/admin/login")
        if path == "/admin/login":
            if self.signed_in():
                return self.redirect("/admin/")
            error = {
                "1": "Wrong username or password.",
                "locked": "Too many attempts. Try again in 15 minutes.",
                "expired": "You were signed out. Sign in again; your unsaved project is still in the form.",
            }
            message = error.get(query.get("error", [""])[0], "")
            return self.page("login.html", {"<!-- error -->": html.escape(message)})
        if path.startswith("/admin/static/") and path[len("/admin/static/"):] in STATIC:
            return self.send_file(ROOT / STATIC[path[len("/admin/static/"):]])
        if path.startswith("/admin/api/"):
            if not self.signed_in():
                return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Please sign in again."})
            if path == "/admin/api/state":
                return self.send_json(HTTPStatus.OK, self.app.portfolio.view())
            match = re.fullmatch(r"/admin/api/images/([^/]+)", path)
            image = match and self.app.portfolio.image_path(match.group(1))
            if image:
                return self.send(HTTPStatus.OK, image.read_bytes(), "image/webp", {"Cache-Control": "private, max-age=86400"})
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        if self.app.config.serve_site and not path.startswith("/admin"):
            return self.serve_site(path)
        self.send(HTTPStatus.NOT_FOUND, b"Not found")

    def serve_site(self, path):
        site = self.app.config.site_dir.resolve()
        target = (site / path.lstrip("/")).resolve()
        if target.is_dir():
            target = target / "index.html"
        if site not in target.parents or not target.is_file():
            return self.send(HTTPStatus.NOT_FOUND, b"Not found")
        self.send_file(target)

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self.same_origin():
            return self.send(HTTPStatus.FORBIDDEN, b"Cross-site request blocked")
        if path == "/admin/login":
            return self.login()
        if path == "/admin/logout":
            self.app.auth.end(self.session_token())
            return self.redirect("/admin/login", {"Set-Cookie": self.cookie("", 0)})
        self.api("POST", path)

    def do_PUT(self):
        if not self.same_origin():
            return self.send(HTTPStatus.FORBIDDEN, b"Cross-site request blocked")
        self.api("PUT", urlsplit(self.path).path)

    def login(self):
        ip = self.client_ip()
        if self.app.auth.locked_out(ip):
            return self.redirect("/admin/login?error=locked")
        try:
            form = parse_qs(self.read_body(4096).decode())
        except (ValueError, OverflowError, UnicodeDecodeError):
            return self.redirect("/admin/login?error=1")
        username = form.get("username", [""])[0]
        password = form.get("password", [""])[0]
        if not self.app.auth.check_password(ip, username, password):
            self.log_message("failed login from %s", ip)
            return self.redirect("/admin/login?error=1")
        token = self.app.auth.new_session()
        self.redirect("/admin/", {"Set-Cookie": self.cookie(token, SESSION_MAX_SECONDS)})

    def api(self, method, path):
        if not self.signed_in():
            return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Please sign in again."})
        portfolio = self.app.portfolio
        try:
            if (method, path) == ("PUT", "/admin/api/drafts"):
                body = self.read_json()
                return self.send_json(HTTPStatus.OK, portfolio.save_drafts(body.get("revision"), body.get("drafts")))
            if (method, path) == ("POST", "/admin/api/images"):
                return self.send_json(HTTPStatus.CREATED, {"file": portfolio.add_image(self.read_body(MAX_UPLOAD))})
            if (method, path) == ("POST", "/admin/api/publish"):
                return self.send_json(HTTPStatus.OK, portfolio.publish(self.read_json().get("revision")))
            if (method, path) == ("POST", "/admin/api/restore"):
                return self.send_json(HTTPStatus.OK, portfolio.restore_previous(self.read_json().get("revision")))
            if (method, path) == ("POST", "/admin/api/resume"):
                return self.send_json(HTTPStatus.OK, portfolio.replace_resume(self.read_body(MAX_RESUME)))
        except Conflict as err:
            return self.send_json(HTTPStatus.CONFLICT, {"error": str(err)})
        except OverflowError:
            return self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "That file is too large."})
        except (ValidationError, ImageError, ResumeError, ValueError) as err:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(err)})
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})


class App:
    def __init__(self, config):
        self.config = config
        self.auth = Auth(config)
        self.portfolio = Portfolio(config.state_dir, config.site_dir, config.template)


def make_server(config):
    server = ThreadingHTTPServer(("127.0.0.1", config.port), Handler)
    server.daemon_threads = True
    server.app = App(config)
    return server


if __name__ == "__main__":
    config = Config()
    server = make_server(config)
    print(f"portfolio-admin listening on http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
