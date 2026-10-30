# Smart Pillbox Web Application

Web application for medication tracking and management.

## Quick Start

### 1. Server Setup

```bash
cd server
npm install
cp .env.example .env  # Edit with your settings
npm run prisma:push
npm run dev
```

### 2. Client Setup

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

## Deploy to Railway

The app deploys as **one Node service** (serving the Express API *and* the built
React client) plus **one PostgreSQL database**.

### 1. Create the project

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Add a **PostgreSQL** database service to the project
   (**New → Database → PostgreSQL**).

### 2. Set environment variables

On the Node service, go to **Variables** and set (see `.env.example`):

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the Postgres service) |
| `JWT_SECRET` | a long random string (`openssl rand -hex 32`) |
| `JWT_REFRESH_SECRET` | a different long random string |
| `NODE_ENV` | `production` |
| `OCR_PROVIDER` | `auto` (Groq Qwen, then NVIDIA, then OpenAI) or a fixed provider name |
| `GROQ_API_KEY` / `NVIDIA_API_KEY` / `OPENAI_API_KEY` | Configure at least one provider key for medication OCR |

Optional variables include `CLIENT_ORIGIN`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (for web
push), and AI API keys such as `ELEVENLABS_API_KEY` or `NVIDIA_API_KEY`. Medication OCR uses a vision-capable provider and returns structured fields with confidence warnings. The scanner preprocesses camera/gallery images, preserves the raw transcription, and always sends the result to an editable review screen before saving. Configure `GROQ_OCR_MODEL` (default `qwen/qwen3.6-27b`), `NVIDIA_OCR_MODEL`, or `OPENAI_OCR_MODEL` only when you need to override the documented defaults. Never commit provider keys to Git; the test utilities require their keys through environment variables.

### 3. Deploy

Railway runs `railway.json` automatically:

- **Build** — installs dependencies, builds the client (`vite build` →
  `client/dist`), and runs `prisma generate`.
- **Start** — applies the PostgreSQL schema (`prisma db push`) and boots the
  server via `tsx`. Health is checked on `/api/health`.

The server serves the client at its root URL, so the web app is available at
the Railway-generated domain once the deploy turns green.

## File Structure

```
pillbox-web/
├── server/
│   ├── src/
│   │   ├── index.ts                   # Express server
│   │   └── ...
│   └── package.json
├── client/
│   ├── src/
│   │   ├── lib/
│   │   ├── components/
│   │   └── ...
│   └── package.json
├── docs/
│   └── ENVIRONMENT_TESTING.md         # Setup & testing guide
└── README.md
```

## Features

- **Medication tracking** with dosage schedules
- **Prescription label scanning** with OCR
- **Voice reminders** with local TTS and ElevenLabs integration
- **Push notifications** for medication reminders
- **Dark/light theme** support

## Tech Stack

- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Backend:** Express, TypeScript, Prisma ORM
- **Database:** PostgreSQL (local dev can use SQLite with a `provider = "sqlite"` schema)

## License

MIT
