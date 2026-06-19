# ECHO — Voice & Text Assistant (Flask + Gemini)

A conversational assistant with a Flask backend that accepts both typed and
spoken input, and responds in both text and speech.

---

## Architecture — why the split is what it is

Speech-to-text and text-to-speech are **browser** capabilities (the
`SpeechRecognition` / `SpeechSynthesis` Web APIs) — there is no server-side
Python equivalent that can reach a user's microphone or speakers, so that
part stays client-side no matter what backend you use.

What Flask actually does:
- Receives the (typed or transcribed) message from the browser
- Calls the **Gemini API** server-side — your API key lives in `.env` on
  the server and is **never sent to the browser**
- Maintains conversation history per session
- Appends every turn, with a timestamp, to a `.txt` log file on disk
- Serves the transcript back as a downloadable file on request

```
 [mic] ──▶ SpeechRecognition (browser) ──▶ transcript ──┐
                                                          ├──▶ POST /api/chat ──▶ Gemini API ──▶ reply
 [keyboard] ──────────────────────────────────────────────┘                                        │
                                                                                                      ├──▶ logs/conversation_<session>.txt
                                                                                                      └──▶ SpeechSynthesis (browser, spoken aloud)
```

---

## Features

| Requirement | Implementation |
|---|---|
| Typed input | Textarea + send button, Enter-to-send |
| Spoken input | Mic button → browser `SpeechRecognition`, live transcription into the input box |
| Speech → text | Handled entirely client-side before the text ever reaches Flask |
| Text response | Returned as JSON from `/api/chat`, rendered in a console-style log with timestamps |
| Spoken response | Every reply is read aloud via `SpeechSynthesis` (toggle, rate, voice selector) |
| Conversation logging | Flask appends every turn to `logs/conversation_<session_id>.txt`; `/api/export` downloads it |

### Extra features
- **API key never leaves the server** — fixes the biggest security gap of a pure-client-side version; the key lives in `.env`, Flask attaches it to outbound Gemini calls only.
- **Per-session conversation memory** — Flask keeps the last 12 turns per browser session and sends them as context on every Gemini call, so Echo remembers earlier parts of the conversation.
- **Live waveform visualizer** while listening (Web Audio API `AnalyserNode`).
- **Settings panel** — switch Gemini model (flash/pro), set a custom system persona for the session, pick TTS voice/rate.
- **Clear conversation** route that wipes both server memory and the log file for that session.
- **Graceful error handling** — missing API key, network failures, and blocked/empty Gemini responses all surface as readable messages in the chat log instead of crashing.
- **Fully responsive** layout.

---

## Setup

```bash
git clone <this-repo>
cd <repo>
pip install -r requirements.txt

cp .env.example .env
# then edit .env and paste your key:
# GEMINI_API_KEY=your_real_key_here
```

Get a free Gemini API key at **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**.

Run it:
```bash
python3 app.py
```
Open **http://localhost:5000** in **Chrome or Edge** (voice input needs a Chromium-based browser — Firefox/Safari don't support `SpeechRecognition`).

---

## ⚠️ About the API key

`GEMINI_API_KEY` goes in `.env`, which is git-ignored — **never commit your
real key**. `.env.example` is the template that ships with the repo; copy
it to `.env` locally. The key is read once at server startup and attached
to outbound requests from Flask only — your browser never sees it.

---

## File structure

```
.
├── app.py                  # Flask routes, Gemini calls, logging
├── requirements.txt
├── .env.example            # copy to .env and fill in your key
├── .gitignore
├── templates/
│   └── index.html
├── static/
│   ├── style.css
│   └── app.js               # speech I/O + calls to Flask /api/* routes
└── logs/                    # .txt conversation logs, written at runtime
```

---

## Known limitations

- `SpeechRecognition` only works in Chromium-based browsers.
- This uses Flask's in-memory dict for conversation history — fine for a
  single-process demo, but it resets if you restart the server, and won't
  scale to multiple worker processes without moving to a real session
  store (e.g. Redis) for production use.
- Requires internet access (Gemini call) and mic permission (voice input).

## Demo video

Walkthrough should cover: typed input → text + spoken reply, voice input
with live transcription, settings (model/persona/voice), waveform while
listening, and exporting the `.txt` transcript.
