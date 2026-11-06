"""Access-token auth tests — stdlib unittest, no real tokens.

The token strings below are obvious test sentinels, not real
credentials for any account. The server never logs, stores, or
prints a token: tests assert on HTTP statuses only, never on a
token value appearing in a file or response body.
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[2]
APP_DIR = REPO / "app"
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(APP_DIR))

from app.auth import (TOKEN_HEADER, is_loopback, load_token,  # noqa: E402
                      open_lan_enabled, remote_bind_warning, resolve_bind,
                      token_ok)
from app.server import create_server  # noqa: E402

SENTINEL_TOKEN = "TEST-TOKEN-SENTINEL-not-a-real-token"

CHAR_MD = """---
name: Test Chief
role: Test leadership
skills: []
tools: []
memory_scope: team
---

You are a test chief.
"""


def _req(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers=dict(
                                     {"Content-Type": "application/json"},
                                     **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")}


class AuthUnitTest(unittest.TestCase):
    def test_loopback_detection(self):
        for h in ("127.0.0.1", "::1", "localhost", "LOCALHOST"):
            self.assertTrue(is_loopback(h), h)
        for h in ("0.0.0.0", "192.168.1.100", "example.com", ""):
            self.assertFalse(is_loopback(h), h)

    def test_load_token_from_env_and_file(self):
        self.assertIsNone(load_token({}))
        self.assertIsNone(load_token({"GROKBOT_APP_TOKEN": "  "}))
        self.assertEqual(load_token({"GROKBOT_APP_TOKEN": "abc"}), "abc")
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write(SENTINEL_TOKEN + "\n")
            fname = f.name
        try:
            self.assertEqual(load_token({"GROKBOT_APP_TOKEN_FILE": fname}),
                             SENTINEL_TOKEN)
            # File wins over env var.
            self.assertEqual(load_token({
                "GROKBOT_APP_TOKEN_FILE": fname,
                "GROKBOT_APP_TOKEN": "other"}), SENTINEL_TOKEN)
        finally:
            Path(fname).unlink()
        # Configured-but-unreadable or empty file is loud, never silent-open.
        self.assertRaises(ValueError, load_token,
                          {"GROKBOT_APP_TOKEN_FILE": "/nonexistent/nope.token"})
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("   \n")
            fname = f.name
        try:
            self.assertRaises(ValueError, load_token,
                              {"GROKBOT_APP_TOKEN_FILE": fname})
        finally:
            Path(fname).unlink()

    def test_resolve_bind_fails_closed(self):
        self.assertEqual(resolve_bind("127.0.0.1", None),
                         ("127.0.0.1", None))
        self.assertEqual(resolve_bind("127.0.0.1", "x"), ("127.0.0.1", "x"))
        self.assertEqual(resolve_bind("0.0.0.0", "x"), ("0.0.0.0", "x"))
        self.assertRaises(ValueError, resolve_bind, "0.0.0.0", None)
        self.assertRaises(ValueError, resolve_bind, "192.168.1.100", None)

    def test_open_lan_opt_in_permits_lan_without_token(self):
        env = {"GROKBOT_APP_OPEN_LAN": "1"}
        self.assertTrue(open_lan_enabled(env))
        self.assertEqual(resolve_bind("0.0.0.0", None, env),
                         ("0.0.0.0", None))
        self.assertEqual(resolve_bind("192.168.1.100", None, env),
                         ("192.168.1.100", None))

    def test_open_lan_other_values_stay_closed(self):
        for value in ("0", "yes", "true", ""):
            with self.subTest(value=value):
                self.assertFalse(
                    open_lan_enabled({"GROKBOT_APP_OPEN_LAN": value}))
                self.assertRaises(ValueError, resolve_bind, "0.0.0.0",
                                  None, {"GROKBOT_APP_OPEN_LAN": value})

    def test_remote_bind_warning_only_for_open_lan(self):
        # Remote bind with a token is the supported remote setup:
        # no warning. Loopback never warns, even with OPEN_LAN.
        self.assertIsNone(remote_bind_warning("127.0.0.1", None))
        self.assertIsNone(remote_bind_warning("0.0.0.0", "x"))
        self.assertIsNone(remote_bind_warning(
            "127.0.0.1", None, {"GROKBOT_APP_OPEN_LAN": "1"}))
        # Non-loopback + OPEN_LAN (token disabled) must warn, loudly.
        warning = remote_bind_warning(
            "0.0.0.0", None, {"GROKBOT_APP_OPEN_LAN": "1"})
        self.assertIsNotNone(warning)
        self.assertIn("PERINGATAN", warning)
        self.assertIn("OPEN_LAN", warning)

    def test_open_lan_create_server_builds_without_token(self):
        tmp = tempfile.TemporaryDirectory()
        chars = Path(tmp.name) / "characters"
        chars.mkdir()
        (chars / "test-chief.md").write_text(CHAR_MD)
        old = os.environ.get("GROKBOT_APP_OPEN_LAN")
        os.environ["GROKBOT_APP_OPEN_LAN"] = "1"
        try:
            httpd = create_server(0,
                                  characters_dir=str(chars),
                                  chat_file=str(Path(tmp.name) / "chat.json"),
                                  memory_db=str(Path(tmp.name) / "memory.db"),
                                  host="0.0.0.0", token=None)
            try:
                self.assertIsNone(httpd.app_state.token)
            finally:
                httpd.server_close()
        finally:
            if old is None:
                del os.environ["GROKBOT_APP_OPEN_LAN"]
            else:
                os.environ["GROKBOT_APP_OPEN_LAN"] = old
            tmp.cleanup()

    def test_token_ok(self):
        self.assertTrue(token_ok(None, None))
        self.assertTrue(token_ok("anything", None))
        self.assertFalse(token_ok(None, SENTINEL_TOKEN))
        self.assertFalse(token_ok("wrong", SENTINEL_TOKEN))
        self.assertTrue(token_ok(SENTINEL_TOKEN, SENTINEL_TOKEN))


class AuthServerTest(unittest.TestCase):
    def _serve(self, token):
        tmp = tempfile.TemporaryDirectory()
        chars = Path(tmp.name) / "characters"
        chars.mkdir()
        (chars / "test-chief.md").write_text(CHAR_MD)
        httpd = create_server(0, characters_dir=str(chars),
                              chat_file=str(Path(tmp.name) / "chat.json"),
                              memory_db=str(Path(tmp.name) / "memory.db"),
                              token=token)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(tmp.cleanup)
        return "http://127.0.0.1:%d" % port

    def test_loopback_without_token_stays_open(self):
        base = self._serve(None)
        status, _ = _req(base, "GET", "/api/characters")
        self.assertEqual(status, 200)

    def test_token_bound_server_gates_every_api(self):
        base = self._serve(SENTINEL_TOKEN)
        # Static shell stays public (UI only, no data).
        with urllib.request.urlopen(base + "/", timeout=10) as resp:
            self.assertEqual(resp.status, 200)
        # Every /api/* route: 401 without the header, 200 with it.
        status, data = _req(base, "GET", "/api/characters")
        self.assertEqual(status, 401)
        self.assertEqual(data.get("error"), "token required")
        status, _ = _req(base, "GET", "/api/characters",
                         headers={TOKEN_HEADER: SENTINEL_TOKEN})
        self.assertEqual(status, 200)
        status, _ = _req(base, "GET", "/api/characters",
                         headers={TOKEN_HEADER: "wrong"})
        self.assertEqual(status, 401)
        status, _ = _req(base, "POST", "/api/chat",
                         {"room": "general", "character": "test-chief",
                          "text": "hi"})
        self.assertEqual(status, 401)
        status, data = _req(base, "POST", "/api/chat",
                            {"room": "general", "character": "test-chief",
                             "text": "hi"},
                            headers={TOKEN_HEADER: SENTINEL_TOKEN})
        self.assertEqual(status, 200)
        # A token smuggled in a JSON body is still rejected (400),
        # never accepted as auth.
        status, _ = _req(base, "POST", "/api/chat",
                         {"room": "general", "character": "test-chief",
                          "text": "hi", "token": SENTINEL_TOKEN},
                         headers={TOKEN_HEADER: SENTINEL_TOKEN})
        self.assertEqual(status, 400)

    def test_lan_bind_without_token_refused_before_listen(self):
        tmp = tempfile.TemporaryDirectory()
        chars = Path(tmp.name) / "characters"
        chars.mkdir()
        (chars / "test-chief.md").write_text(CHAR_MD)
        try:
            self.assertRaises(ValueError, create_server, 0,
                              characters_dir=str(chars),
                              chat_file=str(Path(tmp.name) / "chat.json"),
                              memory_db=str(Path(tmp.name) / "memory.db"),
                              host="0.0.0.0", token=None)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
