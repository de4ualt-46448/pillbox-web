# Environment & Testing Guide

## Environment Variables

### Server (.env)

```bash
# Server Configuration
PORT=4000
HOST=0.0.0.0
CLIENT_ORIGIN=http://localhost:5173

# Authentication
JWT_SECRET=your-super-secret-jwt-key-here
JWT_REFRESH_SECRET=your-refresh-secret-key-here

# Database
DATABASE_URL=file:./dev.db

# Voice Services (optional)
ELEVENLABS_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=

# Vision/AI Services (optional)
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_OCR_MODEL=meta/llama-3.2-90b-vision-instruct
```

### Client (.env or vite.config.ts)

```bash
# No additional client environment variables required
```

---

## Testing Guide

### 1. Local Development

#### Start the Server

```bash
cd server
npm install
npm run dev
```

This starts:
- HTTP server on http://localhost:4000

#### Start the Client

```bash
cd client
npm install
npm run dev
```

Opens http://localhost:5173

### 2. Features to Test

1. **Authentication**: Sign up and sign in
2. **Medication Management**: Add, edit, delete medications
3. **Prescription Scanning**: Use the scanner to extract medication info from labels
4. **Voice Reminders**: Test local TTS and ElevenLabs voice profiles
5. **Push Notifications**: Enable push reminders and test scheduling
6. **Theme Toggle**: Switch between light and dark modes

### 3. Debugging

#### Common Issues

| Symptom | Cause | Solution |
|---------|-------|----------|
| Server won't start | Missing env vars | Check .env file has JWT_SECRET and DATABASE_URL |
| Database errors | Migration needed | Run `npm run prisma:push` |
| OCR not working | Missing API key | Add GROQ_API_KEY or NVIDIA_API_KEY to .env |
| Push notifications fail | VAPID keys missing | Generate with `npx web-push generate-vapid-keys` |

### 4. API Testing

You can test the API endpoints using tools like Postman or curl:

```bash
# Health check
curl http://localhost:4000/api/health

# Sign in
curl -X POST http://localhost:4000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Get medications (requires auth cookie)
curl http://localhost:4000/api/medications \
  -b cookies.txt
```
