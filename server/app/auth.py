"""Access-token auth for the app server (Phase 5 upgrade).

Rules (hard, see server.py for enforcement)
------------------------------------------
* Loopback binds need no token. A non-loopback bind WITHOUT a
  token is refused at startup — fail closed, loud, before any
  socket is opened.
* The token lives OUTSIDE the repo: a file (chmod 600) named by
  ``GROKBOT_APP_TOKEN_FILE``, or the ``GROKBOT_APP_TOKEN`` env
  var. It is never printed, logged, stored, or embedded in code,
  tests, reports, or the repo. The server compares it
  (constant-time) against the ``X-Grokbot-Token`` header on every
  ``/api/*`` request and does nothing else with it.
* A token is NEVER sent in a JSON body: the server rejects any
  body field named ``token`` outright (see REJECTED_FIELDS in
  server.py). Header only.
* The static page (``/``) stays public: it is only a UI shell.
  All data flows through ``/api/*``, which is where the gate
  lives. The browser keeps its copy in localStorage
  (``grokbot_auth``) — the same pattern as the BYO-API
  credential: the server never sees it except as a header to
  compare.
* ``GROKBOT_APP_OPEN_LAN=1`` is the owner's explicit opt-in to
  a LAN-open server: a non-loopback bind is permitted with NO
  token and every ``/api/*`` route answers without a header.
  Default (flag absent or anything but "1" after stripping)
  stays fail-closed. The flag exists because the owner chose
  phone convenience over the gate (2026-10-24); anyone on the
  LAN can then open the deck and drive devices.

This module has no network code and no logging: it only resolves
and compares strings.
"""

import hmac
import os
from pathlib import Path

TOKEN_HEADER = "X-Grokbot-Token"
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def is_loopback(host):
    """True for loopback-only bind addresses."""
    return (host or "").strip().lower() in LOOPBACK_HOSTS


def load_token(env=None):
    """Resolve the configured token, or None if none is set.

    File wins over env var. A configured-but-unreadable or empty
    file is a loud ValueError (never a silent open server).
    Returns None only when nothing is configured at all.
    """
    env = os.environ if env is None else env
    path = env.get("GROKBOT_APP_TOKEN_FILE")
    if path:
        try:
            value = Path(path).read_text(encoding="utf-8").strip()
        except OSError as e:
            raise ValueError(
                "GROKBOT_APP_TOKEN_FILE is set but unreadable: %s" % e)
        if not value:
            raise ValueError("GROKBOT_APP_TOKEN_FILE is empty")
        return value
    value = env.get("GROKBOT_APP_TOKEN")
    value = value.strip() if value else ""
    return value or None


def open_lan_enabled(env=None):
    """True only when the owner explicitly opts into a LAN-open
    server (GROKBOT_APP_OPEN_LAN=1, nothing else after
    stripping)."""
    env = os.environ if env is None else env
    return (env.get("GROKBOT_APP_OPEN_LAN") or "").strip() == "1"


def resolve_bind(host, token, env=None):
    """Fail closed by default: a non-loopback bind needs a token.

    The single exception is the owner's explicit opt-in
    (GROKBOT_APP_OPEN_LAN=1), which permits a LAN bind with no
    token. Returns (host, token) unchanged on success. Raises
    ValueError before any socket is opened when the bind would
    be exposed without a token and without the opt-in.
    """
    if not is_loopback(host) and not token and not open_lan_enabled(env):
        raise ValueError(
            "refusing non-loopback bind %r without a token: set "
            "GROKBOT_APP_TOKEN_FILE (chmod 600) or GROKBOT_APP_TOKEN"
            % (host,))
    return host, token


def remote_bind_warning(host, token, env=None):
    """Warning text for a risky non-loopback bind, or None.

    Only the OPEN_LAN case warns: a non-loopback bind with a token
    is the supported remote setup (token gate stays on), and a
    loopback bind needs no warning. A non-loopback bind without a
    token and without the opt-in never reaches this — resolve_bind
    already refused it before any socket is opened.
    """
    if is_loopback(host):
        return None
    if open_lan_enabled(env):
        return (
            "PERINGATAN: server non-loopback tanpa token "
            "(GROKBOT_APP_OPEN_LAN=1) — semua /api/* terbuka untuk "
            "siapa saja yang bisa menjangkau port ini. Jangan pakai "
            "mode ini di internet publik (mis. URL publik Instabox); "
            "pakai token (GROKBOT_APP_TOKEN_FILE) dan https:// "
            "reverse proxy, atau Tailscale."
        )
    return None


def token_ok(presented, expected):
    """Header check: open when no token is configured, constant-
    time comparison otherwise. Never logs either value."""
    if expected is None:
        return True
    if presented is None:
        return False
    return hmac.compare_digest(presented, expected)
