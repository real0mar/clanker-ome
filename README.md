# Telegram Spotify Preview Bot

Serverless Telegram webhook that expands `spotify.com` and `spotify.link` URLs with rich metadata and cover art. It is designed to run on Vercel's free tier.

## Features
- Detects Spotify links in chat text, captions, and `text_link` entities.
- Expands `spotify.link` short URLs before resolving metadata.
- Pulls track, album, playlist, artist, show, and episode details from the Spotify Web API.
- Replies with album art (when available) plus a friendly caption: `"{username} wants you to listen to {title} by {artist} ({year})!"`.
- Avoids re-posting when the original message came from a bot.

## Prerequisites
1. A Telegram bot token (`TELEGRAM_BOT_TOKEN`). Create a bot with [@BotFather](https://core.telegram.org/bots#botfather) if you do not have one yet.
2. Spotify API credentials (`SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`). Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/applications) and enable the Client Credentials flow.
3. A Vercel account with a project connected to this repository.

## Local Type Check
```bash
npm install
npx tsc --noEmit
```

## Deploying on Vercel
1. Push this repository to your Git provider and import it into Vercel.
2. In the Vercel project settings, add the environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
3. Trigger a deploy. The default endpoint will be `https://<your-project>.vercel.app/api/telegram`.
4. Point Telegram to that endpoint:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
     --data-urlencode "url=https://<your-project>.vercel.app/api/telegram"
   ```
5. Send a Spotify link in a chat with your bot to confirm the preview message.

## Testing the Webhook Manually
Capture an update payload from Telegram (see [Webhook docs](https://core.telegram.org/bots/api#setwebhook)) and replay it locally:
```bash
curl -X POST http://localhost:3000/api/telegram \
  -H "Content-Type: application/json" \
  -d @sample-update.json
```
When running locally with `vercel dev`, set environment variables in a `.env.local` file:
```
TELEGRAM_BOT_TOKEN=<token>
SPOTIFY_CLIENT_ID=<client_id>
SPOTIFY_CLIENT_SECRET=<client_secret>
```

## Implementation Notes
- Spotify access tokens are cached in-memory inside the serverless instance until expiry.
- If Spotify credentials are missing or a lookup fails, the bot sends a fallback message.
- Telegram responses use `reply_parameters` so the preview threads directly under the original message.
- Album art is sent via `sendPhoto`; for entities without imagery, the bot falls back to `sendMessage`.

## Next Steps
- Add persistence (e.g., Upstash Redis) to rate-limit responses per user or chat.
- Extend formatting for additional Spotify entity types (e.g., audiobooks).
- Create automated integration tests that mock Telegram and Spotify responses.
