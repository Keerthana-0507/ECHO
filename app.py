"""
ECHO — Voice & Text Assistant (Flask + Gemini)

Architecture:
- Browser handles speech-to-text and text-to-speech via the native
  Web Speech API (there is no server-side equivalent that runs in
  the user's browser, so this stays client-side regardless of stack).
- Flask receives the (typed or transcribed) text, calls the Gemini
  API server-side — keeping the API key off the client entirely —
  and returns the reply as JSON.
- Flask also owns conversation logging: every turn is appended to a
  timestamped .txt file on disk, and an export route lets the user
  download the full transcript on demand.
"""

import os
import re
import uuid
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, render_template, session, send_file, abort

load_dotenv()

APP_DIR = Path(__file__).parent
LOG_DIR = APP_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL_TMPL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")

# In-memory store of conversation history per session id.
# (Fine for a single-process demo app; would move to a real DB/session
# store for anything multi-worker or production-bound.)
CONVERSATIONS = {}


def get_session_id():
    if "sid" not in session:
        session["sid"] = uuid.uuid4().hex
    return session["sid"]


def get_log_path(sid):
    return LOG_DIR / f"conversation_{sid}.txt"


def append_to_log(sid, role, text):
    path = get_log_path(sid)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    who = "USER" if role == "user" else "ECHO"
    with path.open("a", encoding="utf-8") as f:
        f.write(f"[{stamp}] {who}: {text}\n")


def call_gemini(history, user_text, persona, model):
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "No Gemini API key configured on the server. "
            "Add GEMINI_API_KEY to your .env file and restart Flask."
        )

    contents = []
    for turn in history[-12:]:
        contents.append({
            "role": "user" if turn["role"] == "user" else "model",
            "parts": [{"text": turn["text"]}],
        })
    contents.append({"role": "user", "parts": [{"text": user_text}]})

    body = {
        "contents": contents,
        "generationConfig": {"temperature": 0.8, "maxOutputTokens": 800},
    }
    if persona:
        body["systemInstruction"] = {"parts": [{"text": persona}]}

    url = GEMINI_URL_TMPL.format(model=model or DEFAULT_MODEL)
    resp = requests.post(
        url,
        params={"key": GEMINI_API_KEY},
        json=body,
        timeout=30,
    )

    if not resp.ok:
        try:
            err = resp.json().get("error", {}).get("message", resp.text)
        except Exception:
            err = resp.text
        raise RuntimeError(f"Gemini API error ({resp.status_code}): {err}")

    data = resp.json()
    candidates = data.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini returned no candidates (response may have been blocked).")

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text


@app.route("/")
def index():
    sid = get_session_id()
    CONVERSATIONS.setdefault(sid, [])
    return render_template(
        "index.html",
        api_key_configured=bool(GEMINI_API_KEY),
        default_model=DEFAULT_MODEL,
    )


@app.route("/api/chat", methods=["POST"])
def chat():
    sid = get_session_id()
    history = CONVERSATIONS.setdefault(sid, [])

    payload = request.get_json(silent=True) or {}
    user_text = (payload.get("message") or "").strip()
    persona = (payload.get("persona") or "").strip()
    model = (payload.get("model") or DEFAULT_MODEL).strip()

    if not user_text:
        return jsonify({"error": "Empty message."}), 400

    history.append({"role": "user", "text": user_text, "ts": datetime.now().isoformat()})
    append_to_log(sid, "user", user_text)

    try:
        reply = call_gemini(history, user_text, persona, model)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Network error reaching Gemini: {e}"}), 502

    history.append({"role": "model", "text": reply, "ts": datetime.now().isoformat()})
    append_to_log(sid, "model", reply)

    return jsonify({"reply": reply, "exchanges": len([h for h in history if h["role"] == "user"])})


@app.route("/api/clear", methods=["POST"])
def clear():
    sid = get_session_id()
    CONVERSATIONS[sid] = []
    path = get_log_path(sid)
    if path.exists():
        path.unlink()
    return jsonify({"ok": True})


@app.route("/api/export")
def export():
    sid = get_session_id()
    path = get_log_path(sid)
    if not path.exists():
        return jsonify({"error": "No conversation to export yet."}), 404

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    download_name = f"echo-conversation_{stamp}.txt"
    return send_file(path, as_attachment=True, download_name=download_name, mimetype="text/plain")


@app.route("/api/status")
def status():
    return jsonify({"api_key_configured": bool(GEMINI_API_KEY), "model": DEFAULT_MODEL})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
