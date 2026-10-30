#!/usr/bin/env python3
"""Server-side turn Runner for Nusantara Bots (MVP).

Sam's problem: the agent loop runs in the phone app, so leaving the
app kills the turn ("Model API request failed (network error)").
This service runs ON THE PC, watches rooms on the live server for
trigger messages, runs the model+tool loop server-side, and posts
the finished assistant message back to the room — so Sam can send
a task, close the app, and find the answer waiting on return.

It is a PURE HTTP CLIENT of the live server (8780) and the model
router (3001). It never imports live server code, never touches
data/, characters/ or devices/, never restarts or modifies the live
server, and never calls take-control / release-control / login
(vault). Computer tools use actor="bot" and are refused by the
server itself (409) when the user holds control.

Trigger (no APK change): a user message starting with the trigger
prefix (default "RUNNER:") in a mode=chat room, AND the message must
come through the Chief bot (default chief "xm": the message's
character, or the room's first member as fallback, must equal the
chief). Triggers from any other bot's room are skipped, logged, and
marked skipped_not_chief — never run.

Auto mode (set once, no APK change): with RUNNER_AUTO=1 (or --auto),
every new user message in a Chief chat room is claimed as a task,
without the prefix. The prefix still works in auto mode (it is
stripped first). Chief-only gate, grace period, claimed dedup,
duplicate guard, and @delegation are unchanged — auto only removes
the per-task prefix, it does not remove any safety gate.

Delegation (Chief-only, 29 Okt 2026): a Chief trigger may start
with "@<sub-bot>" (sub-bot id or name, e.g. "@yt-analytics").
The turn still runs server-side, but the finished result is posted
to the sub-bot's room (as that bot's assistant message, headed
"Perintah dari Chief: ...") AND a forwarded copy is posted to the
Chief's room. Without "@<target>" the result stays in the Chief's
room. An unknown "@<target>" posts an error to the Chief's room
listing the valid sub-bots and never runs the model.

The runner waits out a grace period (so the app's own loop can
answer first if the app is still open), claims the job, runs it,
re-checks for a racing assistant reply, then posts. Claimed jobs
are never re-run, even after a runner restart.
a grace period (so the app's own loop can answer first if the app
is still open), claims the job, runs it, re-checks for a racing
assistant reply, then posts. Claimed jobs are never re-run, even
after a runner restart.

Model key: read at runtime from $SAMAI_API_KEY, else parsed from
an env file (default ~/.hermes/.env, like Hermes key_env). The key
value is NEVER logged, printed, or written anywhere.

Standard library only. See RUNNER-DIRECTIONS.md for the full design.
"""

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# ---------------------------------------------------------------- config

def _env(name, default):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def build_config(args):
    return {
        "server": args.server or _env("RUNNER_SERVER",
                                     "http://127.0.0.1:8780"),
        "server_token": args.server_token or _env("RUNNER_SERVER_TOKEN", ""),
        "model_base_url": args.model_base_url or _env(
            "RUNNER_MODEL_BASE_URL", "http://127.0.0.1:3001/v1"),
        "model": args.model or _env("RUNNER_MODEL", "auto"),
        "env_file": args.env_file or _env(
            "RUNNER_ENV_FILE", os.path.expanduser("~/.hermes/.env")),
        "status_host": args.status_host or _env("RUNNER_STATUS_HOST",
                                                "0.0.0.0"),
        "status_port": args.status_port or int(_env("RUNNER_STATUS_PORT",
                                                    "8791")),
        "poll_seconds": args.poll or float(_env("RUNNER_POLL_SECONDS",
                                                "15")),
        "grace_seconds": args.grace or float(_env("RUNNER_GRACE_SECONDS",
                                                  "90")),
        "trigger": args.trigger or _env("RUNNER_TRIGGER", "RUNNER:"),
        "auto": getattr(args, "auto", False) or _env(
            "RUNNER_AUTO", "0").lower() in ("1", "true", "yes"),
        "chief": args.chief or _env("RUNNER_CHIEF", "xm"),
        "scope": args.scope or _env("RUNNER_SCOPE", "team"),
        "max_rounds": args.max_rounds or int(_env("RUNNER_MAX_ROUNDS",
                                                  "8")),
        "claim_file": args.claim_file or _env("RUNNER_CLAIM_FILE",
                                              "./runner-claims.json"),
        "history_limit": int(_env("RUNNER_HISTORY_LIMIT", "12")),
    }


# ---------------------------------------------------------------- logging

def log(msg):
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print("[runner %s] %s" % (stamp, msg), flush=True)


def _preview(text, limit=120):
    text = (text or "").replace("\n", " ").strip()
    return text if len(text) <= limit else text[:limit] + "…"


# ---------------------------------------------------------------- secrets

def load_model_key(env_file):
    """Return the model API key WITHOUT ever logging its value.

    Order: $SAMAI_API_KEY, else parse the env file for a
    SAMAI_API_KEY= line. Returns "" when absent (the model call
    will then fail with the provider's auth error, which is
    reported, not worked around).
    """
    key = os.environ.get("SAMAI_API_KEY", "")
    if key:
        return key
    try:
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line.startswith("SAMAI_API_KEY="):
                    continue
                value = line.split("=", 1)[1].strip().strip("\"'")
                return value
    except OSError:
        pass
    return ""


# ---------------------------------------------------------------- HTTP

class ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def http_json(method, url, body=None, headers=None, timeout=15):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise ApiError("HTTP %s: %s" % (exc.code, _preview(detail, 300)),
                       status=exc.code)
    except Exception as exc:  # network error, timeout, DNS, ...
        raise ApiError("network error: %s" % exc)
    try:
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        raise ApiError("bad JSON response")


# ---------------------------------------------------------------- server client

class ServerClient:
    def __init__(self, base_url, token=""):
        self.base = base_url.rstrip("/")
        self.token = token

    def _headers(self):
        if self.token:
            return {"X-Grokbot-Token": self.token}
        return {}

    def get_rooms(self):
        return http_json("GET", self.base + "/api/rooms",
                         headers=self._headers(), timeout=15)

    def get_chat(self, room):
        from urllib.parse import quote
        return http_json("GET", self.base + "/api/chat?room=" + quote(room),
                         headers=self._headers(), timeout=15)

    def post_message(self, room, character, role, text):
        body = {"room": room, "character": character, "role": role,
                "text": text}
        return http_json("POST", self.base + "/api/messages", body=body,
                         headers=self._headers(), timeout=20)

    def get_characters(self):
        return http_json("GET", self.base + "/api/characters",
                         headers=self._headers(), timeout=15)

    def computer_status(self, scope):
        from urllib.parse import quote
        return http_json(
            "GET", self.base + "/api/computer/status?scope=" + quote(scope),
            headers=self._headers(), timeout=15)

    def computer_tool(self, path, body):
        return http_json("POST", self.base + path, body=body,
                         headers=self._headers(), timeout=30)


# ---------------------------------------------------------------- model client

class ModelClient:
    def __init__(self, base_url, model, key):
        self.base = base_url.rstrip("/")
        self.model = model
        self.key = key

    def chat(self, messages, tools, timeout=120):
        body = {"model": self.model, "messages": messages,
                "temperature": 0.2}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        headers = {}
        if self.key:
            headers["Authorization"] = "Bearer " + self.key
        data = http_json("POST", self.base + "/chat/completions",
                         body=body, headers=headers, timeout=timeout)
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            raise ApiError("model response had no choices")
        content = message.get("content") or ""
        calls = []
        for raw in message.get("tool_calls") or []:
            fn = raw.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {"_parse_error": fn.get("arguments", "")[:200]}
            calls.append({"id": raw.get("id", ""),
                          "name": fn.get("name", ""),
                          "args": args if isinstance(args, dict) else {}})
        return content, calls


# ---------------------------------------------------------------- tools

TOOLS = [
    {"type": "function", "function": {
        "name": "computer_status",
        "description": "Read the team computer status: who holds control, "
                       "whether the browser is open, and its URL.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "computer_open",
        "description": "Navigate the team browser straight to a URL.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"}},
            "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "computer_list_elements",
        "description": "List clickable elements of the active browser tab "
                       "(label, href, viewport x/y). Call this before "
                       "clicking anything; never guess coordinates.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "computer_click_viewport",
        "description": "Click viewport coordinates from list-elements.",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "number"}, "y": {"type": "number"}},
            "required": ["x", "y"]}}},
    {"type": "function", "function": {
        "name": "computer_type",
        "description": "Type text into the focused browser element. "
                       "Never use for passwords.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"}},
            "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "computer_scroll",
        "description": "Scroll the active browser page.",
        "parameters": {"type": "object", "properties": {
            "direction": {"type": "string", "enum": ["down", "up"]},
            "amount": {"type": "integer", "minimum": 1, "maximum": 10}},
            "required": ["direction"]}}},
]

SYSTEM_PROMPT = (
    "You are a server-side runner for Nusantara Bots. You run on the "
    "user's PC, not on their phone. You act ONLY on orders that came "
    "through the Chief bot — never on a sub-bot's own initiative. "
    "Answer in Indonesian, briefly. "
    "Rules: never ask for or use passwords; never guess browser "
    "coordinates — always call computer_list_elements first, then "
    "click with its viewport coordinates; prefer direct navigation "
    "with computer_open over sidebar clicks; if a computer tool "
    "fails because the user holds control, say so and answer from "
    "text instead of retrying tools. End with a short report of "
    "what you checked and found."
)


class ToolExecutor:
    """Executes model tool calls against the live server.

    The control gate is enforced twice: a status pre-check here,
    and the server's own 409 refusal as backstop. Tools are never
    attempted while the user holds control.
    """

    def __init__(self, server, scope, bot_id):
        self.server = server
        self.scope = scope
        self.bot_id = bot_id
        self.tools_disabled = False
        self.tools_disabled_reason = ""

    def _control_ok(self):
        if self.tools_disabled:
            return False
        try:
            status = self.server.computer_status(self.scope)
        except ApiError as exc:
            # Status unreadable: let the tool call itself decide
            # (server enforces 409); do not assume control either way.
            log("status check failed (%s); trying tool anyway" % exc)
            return True
        controlled_by = status.get("controlled_by")
        if controlled_by and controlled_by != "bot":
            self.tools_disabled = True
            self.tools_disabled_reason = (
                "computer control is held by '%s', not the bot"
                % controlled_by)
            return False
        return True

    def execute(self, name, args):
        if name not in ("computer_status", "computer_open",
                        "computer_list_elements", "computer_click_viewport",
                        "computer_type", "computer_scroll"):
            return {"error": "unknown tool: %s" % name}
        if name != "computer_status" and not self._control_ok():
            return {"error": self.tools_disabled_reason}
        body = {"scope": self.scope, "actor": "bot"}
        try:
            if name == "computer_status":
                return self.server.computer_status(self.scope)
            if name == "computer_open":
                body["url"] = args.get("url", "")
                body["bot_id"] = self.bot_id
                return self.server.computer_tool("/api/computer/open",
                                                 body)
            if name == "computer_list_elements":
                return self.server.computer_tool(
                    "/api/computer/list-elements", body)
            if name == "computer_click_viewport":
                body["x"] = float(args.get("x", 0))
                body["y"] = float(args.get("y", 0))
                return self.server.computer_tool(
                    "/api/computer/click-viewport", body)
            if name == "computer_type":
                body["text"] = args.get("text", "")
                return self.server.computer_tool("/api/computer/type",
                                                 body)
            if name == "computer_scroll":
                body["direction"] = args.get("direction", "down")
                body["amount"] = int(args.get("amount", 3))
                return self.server.computer_tool("/api/computer/scroll",
                                                 body)
        except ApiError as exc:
            if exc.status == 409:
                self.tools_disabled = True
                self.tools_disabled_reason = (
                    "server refused tool (409): control held by user")
            return {"error": str(exc)[:300]}
        return {"error": "unreachable tool branch"}


def _truncate_result(result, limit=3000):
    text = json.dumps(result, ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + "…(truncated)"


# ---------------------------------------------------------------- turn

def run_turn(server, model, room, character, task, history, cfg,
             role_note=""):
    """Run one model+tool loop. Returns (final_text, tool_call_count,
    error_or_None). Never raises for model/tool failures: they are
    reported as the turn result so Sam sees them in the room."""
    system = SYSTEM_PROMPT
    if role_note:
        system += " " + role_note
    messages = [{"role": "system", "content": system}]
    for msg in history:
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        messages.append({"role": role,
                         "content": (msg.get("text") or "")[:1000]})
    messages.append({"role": "user", "content": task})
    executor = ToolExecutor(server, cfg["scope"], character)
    tool_calls_total = 0
    try:
        for _round in range(cfg["max_rounds"]):
            content, calls = model.chat(messages, TOOLS)
            if not calls:
                final = content.strip() if content.strip() else (
                    "(Runner selesai tanpa jawaban teks.)")
                return final, tool_calls_total, None
            messages.append({"role": "assistant", "content": content or "",
                             "tool_calls": [
                                 {"id": c["id"], "type": "function",
                                  "function": {
                                      "name": c["name"],
                                      "arguments": json.dumps(c["args"])}}
                                 for c in calls]})
            for call in calls:
                tool_calls_total += 1
                log("tool %s (room %s)" % (call["name"], room))
                result = executor.execute(call["name"], call["args"])
                messages.append({"role": "tool",
                                 "tool_call_id": call["id"],
                                 "content": _truncate_result(result)})
        return ("(Runner berhenti setelah %d ronde tanpa jawaban final.)"
                % cfg["max_rounds"]), tool_calls_total, None
    except ApiError as exc:
        return "", tool_calls_total, "model/server error: %s" % exc
    except Exception as exc:  # defensive: never crash the poll loop
        return "", tool_calls_total, "unexpected error: %s" % exc


# ---------------------------------------------------------------- claims

def load_claims(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(
                data.get("claimed"), dict):
            return data["claimed"]
    except (OSError, ValueError):
        pass
    return {}


def save_claims(path, claimed):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"claimed": claimed}, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _parse_time(value):
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- runner

class Runner:
    def __init__(self, cfg):
        self.cfg = cfg
        self.server = ServerClient(cfg["server"], cfg["server_token"])
        key = load_model_key(cfg["env_file"])
        log("model key present: %s" % ("yes" if key else "NO"))
        self.model = ModelClient(cfg["model_base_url"], cfg["model"], key)
        self.claimed = load_claims(cfg["claim_file"])
        self.room_counts = {}
        self.first_seen = {}
        self.pending = set()
        self.jobs = []
        self.started_at = time.time()
        self._char_map = None

    # -- helpers ------------------------------------------------------

    def _record_job(self, room, task, status, detail=""):
        job = {"room": room, "task": _preview(task, 80), "status": status,
               "detail": _preview(detail, 200),
               "at": datetime.now(timezone.utc).isoformat(
                   timespec="seconds")}
        self.jobs.append(job)
        self.jobs = self.jobs[-20:]
        return job

    def _character_map(self):
        """{character id: display name}, cached. Empty on failure
        (callers then fail closed: nothing is known, nothing runs)."""
        if self._char_map is None:
            try:
                data = self.server.get_characters()
                chars = data if isinstance(data, list) else data.get(
                    "characters", [])
                self._char_map = {c.get("id"): c.get("name") or c.get("id")
                                  for c in chars if c.get("id")}
            except ApiError:
                self._char_map = {}
        return self._char_map

    def _known_character(self, char_id):
        return char_id in self._character_map()

    @staticmethod
    def _norm(text):
        return re.sub(r"[-_ ]", "", (text or "").lower())

    def _parse_delegation(self, task):
        """Split a Chief task into (target_id_or_None, clean_task,
        error_or_None). A leading "@<sub-bot>" delegates; anything
        else is a plain Chief job. An unknown "@<target>" is an
        error (never runs the model)."""
        match = re.match(r"^@(\S+)\s*(.*)$", task.strip(), re.DOTALL)
        if not match:
            return None, task, None
        token, rest = match.group(1), match.group(2).strip()
        if not rest:
            return None, task, (
                "Runner: perintah @%s tanpa tugas. Contoh: "
                "RUNNER: @yt-analytics <tugas>." % token)
        norm = self._norm(token)
        for cid, name in self._character_map().items():
            if norm in (self._norm(cid), self._norm(name)):
                if cid == self.cfg["chief"]:
                    return None, rest, None  # Chief target = plain job
                return cid, rest, None
        valid = ", ".join("@%s" % cid
                          for cid in sorted(self._character_map())
                          if cid != self.cfg["chief"])
        return None, task, (
            "Runner: target @%s tidak dikenal. Sub-bot yang bisa "
            "diperintah: %s. Contoh: RUNNER: @yt-analytics <tugas>."
            % (token, valid))

    def _find_room_for_character(self, char_id):
        """The bot's main room: id == character id, else a room
        whose members are exactly [character]. None when absent
        (the result then stays in the Chief's room only)."""
        try:
            data = self.server.get_rooms()
        except ApiError as exc:
            log("room lookup failed: %s" % exc)
            return None
        rooms = data.get("rooms", []) if isinstance(data, dict) else []
        for room in rooms:
            if room.get("id") == char_id:
                return room.get("id")
        for room in rooms:
            if (room.get("members") or []) == [char_id]:
                return room.get("id")
        return None

    def _app_replied(self, room_id, trigger_id):
        """True when an assistant message already follows the trigger
        in the room (the app answered first)."""
        try:
            fresh = self.server.get_chat(room_id)
        except ApiError as exc:
            log("pre-post recheck failed (%s); posting anyway" % exc)
            return False
        return self._assistant_replied_after(
            fresh.get("messages", []) or [], trigger_id)

    def _assistant_replied_after(self, messages, trigger_id):
        seen_trigger = False
        for msg in messages:
            if msg.get("id") == trigger_id:
                seen_trigger = True
                continue
            if seen_trigger and msg.get("role") == "assistant":
                return True
        return False

    # -- one poll -----------------------------------------------------

    def poll_once(self):
        try:
            data = self.server.get_rooms()
        except ApiError as exc:
            log("poll rooms failed: %s" % exc)
            return
        rooms = data.get("rooms", []) if isinstance(data, dict) else []
        live_ids = {r.get("id") for r in rooms}
        # Drop pending keys for rooms that no longer exist.
        self.pending = {k for k in self.pending
                        if k.split(":", 1)[0] in live_ids}
        for room in rooms:
            room_id = room.get("id")
            mode = room.get("mode")
            if not room_id or mode != "chat":
                continue
            count = room.get("message_count")
            has_pending = any(k.startswith(room_id + ":")
                              for k in self.pending)
            if (count is not None
                    and self.room_counts.get(room_id) == count
                    and not has_pending):
                continue
            self.room_counts[room_id] = count
            try:
                chat = self.server.get_chat(room_id)
            except ApiError as exc:
                log("poll chat %s failed: %s" % (room_id, exc))
                continue
            self._scan_room(room, chat.get("messages", []) or [])

    def _scan_room(self, room, messages):
        room_id = room.get("id")
        members = room.get("members") or []
        trigger = self.cfg["trigger"].lower()
        now = datetime.now(timezone.utc)
        for msg in messages:
            if msg.get("role") != "user":
                continue
            text = (msg.get("text") or "").strip()
            if text.lower().startswith(trigger):
                task = text[len(self.cfg["trigger"]):].strip()
            elif self.cfg.get("auto"):
                task = text
            else:
                continue
            msg_id = msg.get("id")
            key = "%s:%s" % (room_id, msg_id)
            if key in self.claimed or not task:
                continue
            if self._assistant_replied_after(messages, msg_id):
                self.pending.discard(key)
                continue
            # Chief-only: the order must come through the Chief bot.
            # Effective character = the message's character, else the
            # room's first member. Anything else is skipped at once
            # (no grace wait) and marked, so it is never retried.
            effective = msg.get("character") or (
                members[0] if members else None)
            if effective != self.cfg["chief"]:
                log("skip trigger %s: not chief (character %r)"
                    % (key, effective))
                self.claimed[key] = {"status": "skipped_not_chief",
                                     "room": room_id,
                                     "task": _preview(task, 120),
                                     "at": datetime.now(
                                         timezone.utc).isoformat(
                                             timespec="seconds")}
                try:
                    save_claims(self.cfg["claim_file"], self.claimed)
                except OSError as exc:
                    log("claim save failed: %s" % exc)
                continue
            created = _parse_time(msg.get("created_at"))
            if created is not None:
                age = (now - created).total_seconds()
            else:
                first = self.first_seen.get(key)
                if first is None:
                    self.first_seen[key] = time.time()
                    continue
                age = time.time() - first
            if age < self.cfg["grace_seconds"]:
                if key not in self.pending:
                    self.pending.add(key)
                    log("trigger %s seen, waiting grace "
                        "(age %.0fs < %.0fs)"
                        % (key, age, self.cfg["grace_seconds"]))
                continue
            self.pending.discard(key)
            self._run_job(room_id, members, msg, task, messages)

    def _run_job(self, room_id, members, trigger_msg, task, messages):
        msg_id = trigger_msg.get("id")
        key = "%s:%s" % (room_id, msg_id)
        character = trigger_msg.get("character") or (
            members[0] if members else None)
        if not character or not self._known_character(character):
            log("skip trigger %s: unknown character %r"
                % (key, character))
            self.claimed[key] = {"status": "skipped_unknown_character",
                                 "room": room_id,
                                 "task": _preview(task, 120),
                                 "at": datetime.now(timezone.utc).isoformat(
                                     timespec="seconds")}
            try:
                save_claims(self.cfg["claim_file"], self.claimed)
            except OSError as exc:
                log("claim save failed: %s" % exc)
            return
        self.claimed[key] = {"status": "running", "room": room_id,
                             "task": _preview(task, 120),
                             "at": datetime.now(timezone.utc).isoformat(
                                 timespec="seconds")}
        try:
            save_claims(self.cfg["claim_file"], self.claimed)
        except OSError as exc:
            log("claim save failed (%s); not running job %s" % (exc, key))
            del self.claimed[key]
            return
        log("claim %s in room %s: %s"
            % (key, room_id, _preview(task, 120)))
        target, clean_task, target_error = self._parse_delegation(task)
        target_name = self._character_map().get(target or "", target)
        if target_error:
            # Unknown @target: tell the Chief, never run the model.
            final, tool_count, error = "", 0, None
            chief_text = target_error
            status = "failed"
            delegated = False
        else:
            history = [m for m in messages
                       if m.get("id") != msg_id][-self.cfg["history_limit"]:]
            role_note = ""
            if target:
                role_note = ("You are acting as the %s specialist bot, "
                             "on the Chief's order." % target_name)
            final, tool_count, error = run_turn(
                self.server, self.model, room_id, character, clean_task,
                history, self.cfg, role_note)
            if error:
                chief_text = ("Runner gagal: %s (tool dipakai: %d)."
                              % (error, tool_count))
                status = "failed"
                delegated = False
            else:
                status = "done"
                delegated = bool(target)
                if not delegated:
                    chief_text = final
        # Last-moment duplicate guard: if the app answered meanwhile,
        # discard our result instead of double-posting.
        if self._app_replied(room_id, msg_id):
            self.claimed[key]["status"] = "skipped_duplicate"
            save_claims(self.cfg["claim_file"], self.claimed)
            self._record_job(room_id, task, "skipped_duplicate",
                             "app answered first")
            log("discard %s: app answered first" % key)
            return
        if delegated:
            # Result goes to the sub-bot's room AND a forwarded copy
            # to the Chief's room. A missing sub-bot room only drops
            # the sub-bot copy, never the Chief's.
            sub_room = self._find_room_for_character(target)
            if sub_room:
                try:
                    self.server.post_message(
                        sub_room, target, "assistant",
                        "Perintah dari Chief: %s\n\n%s"
                        % (clean_task, final))
                except ApiError as exc:
                    log("post sub-bot result failed: %s" % exc)
                    sub_room = None
            chief_text = ("Diteruskan ke %s%s.\n\n%s"
                          % (target_name,
                             (" — hasil lengkap juga ada di room %s"
                              % target_name) if sub_room else
                             (" — room %s belum ada, hasil hanya di sini"
                              % target_name),
                             final))
        try:
            self.server.post_message(room_id, character, "assistant",
                                     chief_text)
        except ApiError as exc:
            log("post result %s failed: %s" % (key, exc))
            status = "post_failed"
        self.claimed[key]["status"] = status
        try:
            save_claims(self.cfg["claim_file"], self.claimed)
        except OSError as exc:
            log("claim save failed: %s" % exc)
        self._record_job(room_id, task, status,
                         "tools: %d%s" % (tool_count,
                                          " delegated to %s" % target
                                          if delegated else ""))
        log("job %s -> %s (tools: %d%s)" % (key, status, tool_count,
                                            " delegated to %s" % target
                                            if delegated else ""))


# ---------------------------------------------------------------- status server

def make_status_handler(runner):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, payload, status=200):
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/health":
                self._send({
                    "status": "ok",
                    "uptime_seconds": int(time.time()
                                          - runner.started_at),
                    "server": runner.cfg["server"],
                    "model": runner.cfg["model"],
                    "model_base_url": runner.cfg["model_base_url"],
                    "poll_seconds": runner.cfg["poll_seconds"],
                    "grace_seconds": runner.cfg["grace_seconds"],
                    "trigger": runner.cfg["trigger"],
                    "chief_only": True,
                    "chief": runner.cfg["chief"],
                    "delegation": True,
                    "scope": runner.cfg["scope"],
                    "jobs_seen": len(runner.jobs)})
            elif self.path == "/jobs":
                self._send({"jobs": list(reversed(runner.jobs))})
            else:
                self._send({"error": "not found"}, status=404)

        def log_message(self, *args):
            pass

    return Handler


# ---------------------------------------------------------------- main

def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="")
    parser.add_argument("--server-token", default="")
    parser.add_argument("--model-base-url", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--env-file", default="")
    parser.add_argument("--status-host", default="")
    parser.add_argument("--status-port", type=int, default=0)
    parser.add_argument("--poll", type=float, default=0)
    parser.add_argument("--grace", type=float, default=0)
    parser.add_argument("--trigger", default="")
    parser.add_argument("--auto", action="store_true", default=False)
    parser.add_argument("--chief", default="")
    parser.add_argument("--scope", default="")
    parser.add_argument("--max-rounds", type=int, default=0)
    parser.add_argument("--claim-file", default="")
    return parser.parse_args(argv)


def main(argv):
    cfg = build_config(parse_args(argv))
    log("starting: server=%s model=%s status=%s:%d poll=%ss grace=%ss "
        "trigger=%r chief=%r scope=%s auto=%s"
        % (cfg["server"], cfg["model"], cfg["status_host"],
           cfg["status_port"], cfg["poll_seconds"], cfg["grace_seconds"],
           cfg["trigger"], cfg["chief"], cfg["scope"], cfg.get("auto")))
    runner = Runner(cfg)
    httpd = ThreadingHTTPServer(
        (cfg["status_host"], cfg["status_port"]),
        make_status_handler(runner))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    log("status server on %s:%d" % (cfg["status_host"],
                                    cfg["status_port"]))
    stop = {"flag": False}

    def _sig(_signum, _frame):
        stop["flag"] = True

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    try:
        while not stop["flag"]:
            try:
                runner.poll_once()
            except Exception as exc:  # never kill the loop on one error
                log("poll loop error: %s" % exc)
            for _ in range(int(cfg["poll_seconds"] * 10)):
                if stop["flag"]:
                    break
                time.sleep(0.1)
    finally:
        httpd.shutdown()
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
