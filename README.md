# Interpreting Dreams: Debate

Two AI chatbots, a **Psychic Interpreter** and a **NeuroScientist**, argue about what dreams mean in a boxing ring. They speak with ElevenLabs voices, and you can butt in at any time by typing or using the mic.

## Run it

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and paste in your `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY`.
4. Run `npm start` and open **http://localhost:3000** in Chrome or Edge (the mic uses Chrome's built-in speech recognition).

No keys yet? It still runs. You'll get demo lines and the browser's built-in voice, so you can test the screens.

## How it works

| Screen | What happens |
|---|---|
| Opening | Click anywhere to begin. |
| Psychic setup | Optional: drop a PDF with a custom system prompt. Pick a voice (default **Matilda**). ▶ previews the voice. |
| NeuroScientist setup | Same thing (default voice **George**). |
| Introduction | The two heads slide in face to face, then the debate starts automatically (click to skip). |
| Ring | They take turns. The speaker's head glows red and their line shows in a speech bubble. |

- **Butting in:** type in the box and press Enter, or click the mic and speak. The current speaker gets cut off and answers you. If you name one of them ("Neuroscientist, …"), that one answers first. Then they go back to debating.
- **Gear icons:** open the setup popup for that bot mid-debate. The debate pauses while it's open, and changes apply from that bot's next turn.
- **After 16 lines** without you jumping in, they pause so they don't run up your API bill. Click "Let them keep going" or ask something. You can change the number with `MAX_AUTO_TURNS`.
- **End Session** stops everything and goes back to the opening page.

## Files

- `server.js`: a small Express server. It keeps your API keys secret and calls Claude (`/api/turn`), ElevenLabs text-to-speech (`/api/tts`) and the voice list (`/api/voices`), and reads text out of PDFs (`/api/prompt-file`).
- `prompts.js`: the default personalities and the debate rules. The rules (short spoken turns, answer the audience first) are added to every prompt, including ones from your PDFs.
- `public/`: the front end (`index.html`, `styles.css`, `app.js`). Everything is laid out on a 967×550 stage that matches the mockups and scales to fit the window.

To speed things up, while one bot is talking, the app already writes and voices the other bot's reply.
