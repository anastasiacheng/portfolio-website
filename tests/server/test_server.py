import http.client
import json
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from server import images, render
from unittest import mock

from server.app import MAX_FAILURES_PER_IP, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS, Auth, Config, make_server
from server.portfolio import Portfolio, ResumeError
from server.store import Conflict
from server.validation import ValidationError, validate_drafts

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = (ROOT / "index.html").read_text()


def tiny_png(width=4, height=3):
    return subprocess.run(["convert", "-size", f"{width}x{height}", "xc:red", "png:-"], capture_output=True, check=True).stdout


def project(pid="p1", **overrides):
    base = {"id": pid, "title": "Ledger", "description": "A game.", "tags": ["JS"], "image": None,
            "docsUrl": "", "siteUrl": "", "hidden": False}
    return {**base, **overrides}


class RenderTests(unittest.TestCase):
    def test_coming_soon_when_nothing_is_published(self):
        page = render.render_page(TEMPLATE, [])
        self.assertIn('class="coming-soon"', page)
        self.assertNotIn('class="project"', page)

    def test_cards_escape_text_and_only_show_given_buttons(self):
        page = render.render_page(TEMPLATE, [project(title='<script>x</script>', siteUrl="https://a.com/?q=\"x\"")])
        self.assertIn("&lt;script&gt;x&lt;/script&gt;", page)
        self.assertNotIn("<script>x", page)
        self.assertIn('href="https://a.com/?q=&quot;x&quot;">View Website', page)
        self.assertNotIn("Documentation", page)
        self.assertNotIn("coming-soon", page)

    def test_no_tags_and_no_links_leave_out_their_containers(self):
        page = render.render_page(TEMPLATE, [project(tags=[])])
        self.assertNotIn('class="project-tags"', page)
        self.assertNotIn('<div class="buttons">\n', page.split("Featured Projects")[1])

    def test_resume_version_is_replaced(self):
        self.assertEqual(render.parse_resume_version(TEMPLATE), 2)
        self.assertIn("AnastasiaChengResume.pdf?v=7", render.render_page(TEMPLATE, [], 7))

    def test_stylesheet_link_gets_a_version(self):
        self.assertIn('href="style.css?v=abc123"', render.render_page(TEMPLATE, [], style_version="abc123"))
        self.assertIn('href="style.css"', render.render_page(TEMPLATE, []))

    def test_template_needs_markers(self):
        with self.assertRaises(ValueError):
            render.render_page("<html></html>", [])


class ValidationTests(unittest.TestCase):
    def test_normalizes_and_orders_fields(self):
        [p] = validate_drafts([{**project(), "title": "  Ledger  ", "extra": "dropped"}], lambda _: True)
        self.assertEqual(p, project())
        self.assertEqual(list(p), list(project()))

    def test_rejects_bad_input(self):
        cases = [
            [project(docsUrl="javascript:alert(1)")],
            [project(siteUrl="github.com/me")],
            [project(title=" ")],
            [project(title="x" * 81)],
            [project(tags=["t"] * 11)],
            [project(id="../etc")],
            [project(image={"file": "../../secret.webp", "alt": "x"})],
            [project(image={"file": "a" * 32 + ".webp", "alt": ""})],
            [project(), project()],
            "not a list",
        ]
        for drafts in cases:
            with self.subTest(drafts=str(drafts)[:80]), self.assertRaises(ValidationError):
                validate_drafts(drafts, lambda _: True)

    def test_image_must_have_been_uploaded(self):
        with self.assertRaises(ValidationError):
            validate_drafts([project(image={"file": "a" * 32 + ".webp", "alt": "x"})], lambda _: False)


class ImageTests(unittest.TestCase):
    def test_converts_to_webp_and_shrinks_large_images(self):
        out = images.to_webp(tiny_png(2400, 1600))
        self.assertEqual(images.sniff(out), "webp")
        size = subprocess.run(["identify", "-format", "%wx%h", "webp:-"], input=out, capture_output=True, check=True).stdout
        self.assertEqual(size, b"1200x800")

    def test_small_images_are_not_enlarged(self):
        size = subprocess.run(["identify", "-format", "%wx%h", "webp:-"], input=images.to_webp(tiny_png(40, 30)),
                              capture_output=True, check=True).stdout
        self.assertEqual(size, b"40x30")

    def test_rejects_non_images(self):
        for data in [b"<svg onload=alert(1)>", b"%PDF-1.4", b""]:
            with self.assertRaises(images.ImageError):
                images.to_webp(data)


class PortfolioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "site/assets").mkdir(parents=True)
        self.p = Portfolio(self.tmp / "state", self.tmp / "site", ROOT / "index.html")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def index(self):
        return (self.tmp / "site/index.html").read_text()

    def test_publish_flow(self):
        image = self.p.add_image(tiny_png())
        view = self.p.save_drafts(0, [project("a", image={"file": image, "alt": "Shot"}), project("b", hidden=True)])
        self.assertEqual(view["status"], {"a": "new", "b": "hidden"})
        self.assertTrue(view["pending"])

        view = self.p.publish(view["revision"])
        self.assertFalse(view["pending"])
        self.assertEqual(view["status"], {"a": "live", "b": "hidden"})
        self.assertIn("<h3>Ledger</h3>", self.index())
        self.assertEqual(self.index().count('class="project"'), 1, "hidden project is not published")
        self.assertTrue((self.tmp / "site/assets/projects" / image).is_file())
        self.assertEqual(oct((self.tmp / "site/index.html").stat().st_mode & 0o777), "0o644")

        view = self.p.save_drafts(view["revision"], [project("a", title="Ledger 2"), project("b", hidden=True)])
        self.assertEqual(view["status"]["a"], "changed")
        self.assertIn("<h3>Ledger</h3>", self.index(), "drafts don't touch the live page")

        view = self.p.publish(view["revision"])
        self.assertIn("<h3>Ledger 2</h3>", self.index())
        self.assertFalse((self.tmp / "site/assets/projects" / image).exists(), "unused images are removed")

        view = self.p.restore_previous(view["revision"])
        self.assertIn("<h3>Ledger</h3>", self.index())
        self.assertTrue((self.tmp / "site/assets/projects" / image).is_file())
        view = self.p.restore_previous(view["revision"])
        self.assertIn("<h3>Ledger 2</h3>", self.index(), "restoring twice swaps back")

    def test_stylesheet_version_follows_its_content(self):
        css = self.tmp / "site/style.css"
        css.write_text("a{}")
        self.p.render_site()
        first = re.search(r'style\.css\?v=(\w+)', self.index()).group(1)
        css.write_text("b{}")
        self.p.render_site()
        self.assertNotEqual(re.search(r'style\.css\?v=(\w+)', self.index()).group(1), first)

    def test_stale_revision_is_rejected(self):
        self.p.save_drafts(0, [project()])
        with self.assertRaises(Conflict):
            self.p.save_drafts(0, [])

    def test_unpublishing_everything_shows_coming_soon(self):
        view = self.p.publish(self.p.save_drafts(0, [project()])["revision"])
        view = self.p.publish(self.p.save_drafts(view["revision"], [project(hidden=True)])["revision"])
        self.assertIn("coming-soon", self.index())

    def test_resume_replacement(self):
        resume = self.tmp / "site/assets/AnastasiaChengResume.pdf"
        resume.write_bytes(b"%PDF-1.4 old %%EOF")
        view = self.p.replace_resume(b"%PDF-1.7 new %%EOF\n")
        self.assertEqual(view["resumeVersion"], 3)
        self.assertEqual(resume.read_bytes(), b"%PDF-1.7 new %%EOF\n")
        self.assertIn("AnastasiaChengResume.pdf?v=3", self.index())
        self.assertEqual([f.read_bytes() for f in (self.tmp / "state/resume-history").iterdir()], [b"%PDF-1.4 old %%EOF"])
        with self.assertRaises(ResumeError):
            self.p.replace_resume(b"<html>not a pdf</html>")


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.config = Config({"PORTFOLIO_STATE_DIR": str(self.tmp)})
        self.now = 1_000_000.0
        patcher = mock.patch("server.app.time.time", lambda: self.now)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_sessions_survive_a_restart_and_only_hashes_are_stored(self):
        token = Auth(self.config).new_session()
        self.assertTrue(Auth(self.config).valid(token), "a new Auth (a restarted service) still knows the session")
        self.assertNotIn(token, (self.tmp / "sessions.json").read_text())
        self.assertEqual(oct((self.tmp / "sessions.json").stat().st_mode & 0o777), "0o600")

    def test_at_least_eight_idle_hours(self):
        auth = Auth(self.config)
        token = auth.new_session()
        self.now += SESSION_IDLE_SECONDS - 1
        self.assertTrue(Auth(self.config).valid(token), "still signed in just under 8 idle hours, even after a restart")

    def test_activity_keeps_the_session_alive(self):
        auth = Auth(self.config)
        token = auth.new_session()
        for _ in range(3):
            self.now += 7 * 3600
            self.assertTrue(auth.valid(token))
        self.now += SESSION_IDLE_SECONDS + 3600
        self.assertFalse(auth.valid(token), "signed out after more than 8 idle hours")

    def test_seven_day_cap(self):
        auth = Auth(self.config)
        token = auth.new_session()
        while self.now < 1_000_000 + SESSION_MAX_SECONDS - 3600:
            self.now += 3600
            self.assertTrue(auth.valid(token))
        self.now += 7200
        self.assertFalse(auth.valid(token))

    def test_logout_is_remembered_after_restart(self):
        auth = Auth(self.config)
        token = auth.new_session()
        auth.end(token)
        self.assertFalse(Auth(self.config).valid(token))


class HttpTests(unittest.TestCase):
    """Runs the real server on a random port against temp folders."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "site/assets").mkdir(parents=True)
        (self.tmp / "password").write_text("correct horse\n")
        config = Config({
            "PORTFOLIO_PORT": "0", "PORTFOLIO_STATE_DIR": str(self.tmp / "state"),
            "PORTFOLIO_SITE_DIR": str(self.tmp / "site"), "PORTFOLIO_PASSWORD_FILE": str(self.tmp / "password"),
            "PORTFOLIO_ALLOWED_ORIGINS": "https://example.test", "PORTFOLIO_SERVE_SITE": "1",
        })
        self.server = make_server(config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmp)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1])
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response, response.read()

    def login(self, password="correct horse", origin="https://example.test", ip="1.2.3.4"):
        body = f"username=abc&password={password.replace(' ', '+')}"
        return self.request("POST", "/admin/login", body, {
            "Origin": origin, "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip})[0]

    def cookie(self):
        response = self.login()
        self.assertEqual(response.getheader("Location"), "/admin/")
        set_cookie = response.getheader("Set-Cookie")
        for attr in ["HttpOnly", "SameSite=Strict", "Secure", "Path=/admin"]:
            self.assertIn(attr, set_cookie)
        return set_cookie.split(";")[0]

    def test_editor_and_api_need_sign_in(self):
        response, _ = self.request("GET", "/admin/")
        self.assertEqual((response.status, response.getheader("Location")), (303, "/admin/login"))
        self.assertEqual(self.request("GET", "/admin/api/state")[0].status, 401)
        self.assertEqual(self.request("GET", "/admin/api/state", headers={"Cookie": "portfolio_session=guess"})[0].status, 401)

    def test_sign_in_then_use_api(self):
        cookie = self.cookie()
        response, body = self.request("GET", "/admin/", headers={"Cookie": cookie})
        self.assertEqual(response.status, 200)
        self.assertIn("frame-ancestors 'none'", response.getheader("Content-Security-Policy"))
        state = json.loads(self.request("GET", "/admin/api/state", headers={"Cookie": cookie})[1])
        self.assertEqual(state["drafts"], [])

        headers = {"Cookie": cookie, "Origin": "https://example.test", "Content-Type": "application/json"}
        response, body = self.request("PUT", "/admin/api/drafts", json.dumps({"revision": 0, "drafts": [project()]}), headers)
        self.assertEqual(response.status, 200, body)
        response, body = self.request("PUT", "/admin/api/drafts", json.dumps({"revision": 0, "drafts": []}), headers)
        self.assertEqual(response.status, 409)
        response, body = self.request("POST", "/admin/api/publish", json.dumps({"revision": 1}), headers)
        self.assertEqual(response.status, 200, body)
        self.assertIn(b"<h3>Ledger</h3>", self.request("GET", "/")[1])

        response, body = self.request("POST", "/admin/api/images", b"not an image", {**headers, "Content-Type": "image/png"})
        self.assertEqual(response.status, 400)
        response, body = self.request("POST", "/admin/api/images", tiny_png(), {**headers, "Content-Type": "image/png"})
        name = json.loads(body)["file"]
        response, body = self.request("GET", f"/admin/api/images/{name}", headers={"Cookie": cookie})
        self.assertEqual((response.status, images.sniff(body)), (200, "webp"))

        response, _ = self.request("POST", "/admin/logout", headers={"Cookie": cookie, "Origin": "https://example.test"})
        self.assertIn("Max-Age=0", response.getheader("Set-Cookie"))
        self.assertEqual(self.request("GET", "/admin/api/state", headers={"Cookie": cookie})[0].status, 401)

    def test_wrong_password_and_lockout(self):
        for _ in range(MAX_FAILURES_PER_IP):
            self.assertEqual(self.login("wrong").getheader("Location"), "/admin/login?error=1")
        self.assertEqual(self.login().getheader("Location"), "/admin/login?error=locked", "right password is refused while locked")
        self.assertEqual(self.login(ip="5.6.7.8").getheader("Location"), "/admin/", "other addresses aren't locked out")

    def test_cross_site_requests_are_blocked(self):
        self.assertEqual(self.login(origin="https://evil.test").status, 403)
        cookie = self.cookie()
        response, _ = self.request("PUT", "/admin/api/drafts", "{}", {"Cookie": cookie, "Content-Type": "application/json"})
        self.assertEqual(response.status, 403, "missing Origin is blocked too")

    def test_only_listed_files_are_served(self):
        self.assertEqual(self.request("GET", "/admin/static/editor.js")[0].status, 200)
        for path in ["/admin/static/../server/app.py", "/admin/static/%2e%2e/server/app.py", "/admin/static/app.py",
                     "/admin/api/images/..%2fstate.json", "/../../etc/passwd", "/%2e%2e/state/state.json"]:
            cookie = self.cookie() if "api" in path else ""
            self.assertEqual(self.request("GET", path, headers={"Cookie": cookie})[0].status, 404, path)

    def test_error_message_on_login_page_is_escaped(self):
        _, body = self.request("GET", "/admin/login?error=<script>")
        self.assertNotIn(b"<script>", body)


if __name__ == "__main__":
    unittest.main()
