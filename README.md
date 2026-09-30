# J.A.R.V.I.S.

An Iron Man–style voice assistant that runs in your browser. Say **"Hey Jarvis"**, ask a question, and Jarvis searches Google and reads you the answer. While it listens and talks, an arc-reactor HUD shows a live sound wave.

- **Wake word**: "Hey Jarvis" (or just "Jarvis"). You can say the question in the same breath ("Hey Jarvis, who directed Iron Man?") or pause and ask after the chime.
- **Google answers**: answer boxes, knowledge-graph facts and top-result snippets are read aloud. The source and the top links appear on screen, with an "Open in Google" button.
- **Sound-wave HUD**: the wave follows your microphone while Jarvis listens and animates with Jarvis's voice while it talks. The rings turn amber while it searches.
- **Hands-free interrupt**: say "Hey Jarvis, stop", tap the reactor, or press <kbd>Esc</kbd>.
- **Typing works too**: use the command bar when you can't talk.

## Quick start

Requirements: **Node.js 18.17+**, a microphone, and **Google Chrome or Microsoft Edge**. Voice recognition uses the browser's Web Speech API, which Firefox doesn't have.

```bash
git clone https://github.com/salvagefrank-cmd/Jarvis.git
cd Jarvis
cp .env.example .env      # then add your SERPER_API_KEY (see below)
npm start
```

Open **http://localhost:3000** in Chrome or Edge, tap the reactor and allow microphone access. Then say:

> "Hey Jarvis, how tall is the Eiffel Tower?"

There are no dependencies to install. The server uses only Node's standard library.

## Connecting Google search

Browsers can't query Google directly, so the local server does the searching and keeps your API key out of the page.

| Provider | `.env` settings | Notes |
| --- | --- | --- |
| **Serper.dev** (recommended) | `SERPER_API_KEY` | Live Google results, including answer boxes and knowledge-graph facts. Sign up at [serper.dev](https://serper.dev); there's a free tier. |
| Google Custom Search JSON API | `GOOGLE_API_KEY`, `GOOGLE_CSE_ID` | Existing keys only. Google no longer accepts new sign-ups and is shutting the API down on **1 January 2027**. |
| Keyless fallback | *(none)* | Used when neither option above is set. Answers come from DuckDuckGo Instant Answers and Wikipedia instead of Google. |

The **Systems → Search** readout in the HUD shows which provider is active. The server also prints it at startup.

Optional: `SEARCH_COUNTRY` (for example `us` or `gb`) and `SEARCH_LANGUAGE` (for example `en`) localize Serper results.

## Things you can say

| Say | Jarvis |
| --- | --- |
| "Hey Jarvis, *any question*" | Searches Google and reads the answer |
| "Hey Jarvis, search for / google / look up *topic*" | Searches for just that topic |
| "Hey Jarvis, what time is it?" / "what's the date?" | Answers from your computer's clock |
| "Hey Jarvis, stop" / "never mind" | Stops talking or cancels the search |
| "Hey Jarvis, what can you do?" | Explains itself |
| "Hey Jarvis, thank you" | Always a pleasure |

In **Settings** (the gear button) you can pick Jarvis's voice and speaking rate, and change how it addresses you ("sir" by default; leave the field blank for no title). A British male voice is chosen automatically when your system has one, such as "Google UK English Male" in Chrome or "Microsoft Ryan" in Edge.

## Troubleshooting

- **"Hey Jarvis" doesn't trigger.** Watch the faint text under the status line: it shows what the recognizer heard. If it keeps hearing a different name, try "Hey Jarvis" with a short pause, or tap the reactor to talk without the wake word.
- **No microphone prompt, or mic blocked.** Browsers only allow the microphone on `localhost` or HTTPS. Open the page at `http://localhost:3000` (not by double-clicking `index.html`), and check the microphone permission in the address bar.
- **"Speech recognition needs an internet connection."** Chrome and Edge send audio to their cloud speech service for transcription, so voice commands need a connection.
- **Answers come from Wikipedia instead of Google.** No Google key is configured. Add `SERPER_API_KEY` to `.env` and restart `npm start`.
- **Jarvis hears itself.** Use headphones, or turn the speaker volume down. Jarvis ignores its own words while it talks, but loud speakers can still get through.

## Privacy

Speech recognition is done by your browser vendor (Google for Chrome, Microsoft for Edge) while the microphone is on. Use the mic button to turn listening off. Your questions go from your computer to the search provider you configured. Nothing is stored by this app except your settings, which stay in your browser's local storage.

## Project layout

```
server.js              Static file server + /api/search and /api/status
lib/search.js          Serper / Google CSE / keyless providers → one spoken answer
lib/env.js             Tiny .env loader
public/index.html      HUD layout
public/styles.css      Iron Man HUD styling
public/js/app.js       State machine: standby → listening → searching → speaking
public/js/voice.js     Wake-word recognizer (auto-restarting), speech synthesis, talking envelope
public/js/visualizer.js  Canvas arc reactor + sound wave
public/js/audio.js     Microphone level/spectrum and interface chimes
public/js/skills.js    Wake-word matching and built-in commands
test/                  Unit tests (npm test)
```

## Development

```bash
npm run dev   # restarts the server on changes
npm test      # unit tests for search parsing, wake word and commands
```
