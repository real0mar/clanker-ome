import type { VercelRequest, VercelResponse } from '@vercel/node';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_BASE = TELEGRAM_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}` : null;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const SPOTIFY_REGEX = /(https?:\/\/(?:[a-z]+\.)?spotify\.com\/[^\s]+|https?:\/\/spotify\.link\/[^\s]+)/gi;

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramChat {
  id: number | string;
  type: string;
}

interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  chat: TelegramChat;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
}

interface TelegramUpdate {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

type SpotifyEntityType = 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode';

interface SpotifyMetadata {
  type: SpotifyEntityType;
  title: string;
  subtitle: string;
  releaseYear?: string;
  imageUrl?: string;
  externalUrl: string;
}

interface SpotifyTokenCache {
  token: string;
  expiresAt: number;
}

let spotifyTokenCache: SpotifyTokenCache | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  if (!TELEGRAM_API_BASE) {
    res.status(500).json({ ok: false, error: 'Bot token missing' });
    return;
  }

  const update = req.body as TelegramUpdate;
  const message = update.message ?? update.channel_post;

  if (!message) {
    res.status(200).json({ ok: true });
    return;
  }

  if (message.from?.is_bot) {
    res.status(200).json({ ok: true });
    return;
  }

  const detectedLinks = new Set<string>();
  collectSpotifyLinks(message.text, message.entities, detectedLinks);
  collectSpotifyLinks(message.caption, message.caption_entities, detectedLinks);

  if (detectedLinks.size === 0) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  const replyToMessageId = message.message_id;
  const announcer = formatSenderName(message.from);

  for (const rawLink of detectedLinks) {
    try {
      const normalizedUrl = await normalizeSpotifyUrl(rawLink);
      if (!normalizedUrl) {
        continue;
      }

      const entity = parseSpotifyEntity(normalizedUrl);
      if (!entity) {
        continue;
      }

      const metadata = await fetchSpotifyMetadata(entity.type, entity.id);
      if (!metadata) {
        await sendTelegramMessage(chatId, `${announcer} shared a Spotify link but I could not load its details.`, replyToMessageId);
        continue;
      }

      const caption = formatCaption(metadata, announcer);

      if (metadata.imageUrl) {
        await sendTelegramPhoto(chatId, metadata.imageUrl, caption, replyToMessageId);
      } else {
        await sendTelegramMessage(chatId, `${caption}\n${metadata.externalUrl}`, replyToMessageId);
      }
    } catch (error) {
      console.error('Failed to handle Spotify link', rawLink, error);
      await sendTelegramMessage(chatId, `${announcer} shared a Spotify link but something went wrong while expanding it.`, replyToMessageId);
    }
  }

  res.status(200).json({ ok: true });
}

function collectSpotifyLinks(text: string | undefined, entities: TelegramMessageEntity[] | undefined, accumulator: Set<string>) {
  if (!text) {
    return;
  }

  let match: RegExpExecArray | null;
  while ((match = SPOTIFY_REGEX.exec(text)) !== null) {
    const candidate = sanitizeUrlCandidate(match[0]);
    if (candidate) {
      accumulator.add(candidate);
    }
  }

  if (!entities) {
    return;
  }

  for (const entity of entities) {
    if (entity.type === 'text_link' && entity.url && isSpotifyDomain(entity.url)) {
      accumulator.add(entity.url);
    }

    if (entity.type === 'url') {
      const segment = text.substring(entity.offset, entity.offset + entity.length);
      const candidate = sanitizeUrlCandidate(segment);
      if (candidate && isSpotifyDomain(candidate)) {
        accumulator.add(candidate);
      }
    }
  }
}

function sanitizeUrlCandidate(raw: string): string | null {
  const trimmed = raw.trim().replace(/[>)\].,!?]+$/g, '');
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function isSpotifyDomain(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.endsWith('spotify.com') || parsed.hostname === 'spotify.link';
  } catch (error) {
    return false;
  }
}

async function normalizeSpotifyUrl(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return null;
  }

  if (parsed.hostname === 'spotify.link') {
    const resolved = await resolveShortSpotifyLink(parsed);
    return resolved ?? parsed.href;
  }

  return parsed.href;
}

async function resolveShortSpotifyLink(url: URL): Promise<string | null> {
  try {
    const headResponse = await fetch(url.href, {
      method: 'HEAD',
      redirect: 'manual',
    });

    const location = headResponse.headers.get('location');
    if (location) {
      const resolved = resolveRedirectUrl(url, location);
      if (resolved) {
        return resolved;
      }
    }

    if (headResponse.status >= 200 && headResponse.status < 300) {
      return headResponse.url || url.href;
    }

    // Fall back to GET if HEAD did not return a redirect header.
    const getResponse = await fetch(url.href, {
      method: 'GET',
      redirect: 'follow',
    });
    return getResponse.url || url.href;
  } catch (error) {
    console.warn('Failed to resolve spotify.link redirect', error);
    return null;
  }
}

function resolveRedirectUrl(base: URL, location: string): string | null {
  try {
    const resolved = new URL(location, base);
    return resolved.href;
  } catch (_error) {
    return null;
  }
}

function parseSpotifyEntity(url: string): { type: SpotifyEntityType; id: string } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('spotify.com')) {
      return null;
    }

    const segments = parsed.pathname
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length < 2) {
      return null;
    }

    if (segments[0].startsWith('intl-') && segments.length >= 3) {
      segments.shift();
    }

    if (segments[0] === 'embed') {
      segments.shift();
    }

    let typeSegment = segments[0];
    let idSegment = segments[1];

    if (typeSegment === 'user' && segments[2] === 'playlist' && segments[3]) {
      typeSegment = 'playlist';
      idSegment = segments[3];
    }

    if (!idSegment) {
      return null;
    }

    const normalizedType = normalizeSpotifyType(typeSegment);
    if (!normalizedType) {
      return null;
    }

    const id = idSegment.split('?')[0];
    return { type: normalizedType, id };
  } catch (_error) {
    return null;
  }
}

function normalizeSpotifyType(segment: string): SpotifyEntityType | null {
  switch (segment) {
    case 'track':
      return 'track';
    case 'album':
      return 'album';
    case 'playlist':
      return 'playlist';
    case 'artist':
      return 'artist';
    case 'show':
      return 'show';
    case 'episode':
      return 'episode';
    default:
      return null;
  }
}

async function fetchSpotifyMetadata(type: SpotifyEntityType, id: string): Promise<SpotifyMetadata | null> {
  const token = await getSpotifyAccessToken();
  if (!token) {
    console.warn('Spotify credentials missing');
    return null;
  }

  const endpoint = spotifyEndpointFor(type, id);
  if (!endpoint) {
    return null;
  }

  let response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    spotifyTokenCache = null;
    const retryToken = await getSpotifyAccessToken();
    if (!retryToken) {
      return null;
    }

    response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${retryToken}`,
      },
    });
  }

  if (!response.ok) {
    console.warn('Spotify API request failed', response.status, await response.text());
    return null;
  }

  const data = await response.json();
  return mapSpotifyResponse(type, data, id);
}

function spotifyEndpointFor(type: SpotifyEntityType, id: string): string | null {
  const base = 'https://api.spotify.com/v1';
  switch (type) {
    case 'track':
      return `${base}/tracks/${id}`;
    case 'album':
      return `${base}/albums/${id}`;
    case 'playlist':
      return `${base}/playlists/${id}`;
    case 'artist':
      return `${base}/artists/${id}`;
    case 'show':
      return `${base}/shows/${id}`;
    case 'episode':
      return `${base}/episodes/${id}`;
    default:
      return null;
  }
}

function mapSpotifyResponse(type: SpotifyEntityType, data: any, idFallback: string): SpotifyMetadata | null {
  switch (type) {
    case 'track': {
      const title: string = data.name;
      const artists: string = (data.artists ?? []).map((artist: any) => artist.name).join(', ');
      const year = deriveReleaseYear(data.album?.release_date);
      const image = data.album?.images?.[0]?.url;
      const externalUrl: string = data.external_urls?.spotify ?? `https://open.spotify.com/track/${idFallback}`;
      return {
        type,
        title,
        subtitle: artists,
        releaseYear: year,
        imageUrl: image,
        externalUrl,
      };
    }
    case 'album': {
      const title: string = data.name;
      const artists: string = (data.artists ?? []).map((artist: any) => artist.name).join(', ');
      const year = deriveReleaseYear(data.release_date);
      const image = data.images?.[0]?.url;
      const externalUrl: string = data.external_urls?.spotify ?? `https://open.spotify.com/album/${idFallback}`;
      return {
        type,
        title,
        subtitle: artists,
        releaseYear: year,
        imageUrl: image,
        externalUrl,
      };
    }
    case 'playlist': {
      const title: string = data.name;
      const owner: string = data.owner?.display_name ?? data.owner?.id ?? 'unknown curator';
      const image = data.images?.[0]?.url;
      const externalUrl: string = data.external_urls?.spotify ?? `https://open.spotify.com/playlist/${idFallback}`;
      return {
        type,
        title,
        subtitle: owner,
        imageUrl: image,
        externalUrl,
      };
    }
    case 'artist': {
      const title: string = data.name;
      const genres: string = Array.isArray(data.genres) && data.genres.length > 0 ? data.genres.slice(0, 3).join(', ') : 'artist';
      const image = data.images?.[0]?.url;
      const externalUrl: string = data.external_urls?.spotify ?? `https://open.spotify.com/artist/${idFallback}`;
      return {
        type,
        title,
        subtitle: genres,
        imageUrl: image,
        externalUrl,
      };
    }
    case 'show': {
      const title: string = data.name;
      const publisher: string = data.publisher ?? 'unknown publisher';
      const image = data.images?.[0]?.url;
      const externalUrl: string = data.external_urls?.spotify ?? `https://open.spotify.com/show/${idFallback}`;
      return {
        type,
        title,
        subtitle: publisher,
        imageUrl: image,
        externalUrl,
      };
    }
    case 'episode': {
      const title: string = data.name;
      const showName: string = data.show?.name ?? 'podcast';
      const year = deriveReleaseYear(data.release_date ?? data.release_date_time);
      const image = data.images?.[0]?.url ?? data.show?.images?.[0]?.url;
      const externalUrl: string = data.external_urls?.spotify ?? `https://open.spotify.com/episode/${idFallback}`;
      return {
        type,
        title,
        subtitle: showName,
        releaseYear: year,
        imageUrl: image,
        externalUrl,
      };
    }
    default:
      return null;
  }
}

function deriveReleaseYear(releaseDate: string | undefined): string | undefined {
  if (!releaseDate) {
    return undefined;
  }
  const yearMatch = releaseDate.match(/^(\d{4})/);
  return yearMatch ? yearMatch[1] : undefined;
}

async function getSpotifyAccessToken(): Promise<string | null> {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return null;
  }

  const now = Date.now();
  if (spotifyTokenCache && spotifyTokenCache.expiresAt > now + 10_000) {
    return spotifyTokenCache.token;
  }

  const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    console.error('Failed to obtain Spotify token', response.status, await response.text());
    return null;
  }

  const payload = await response.json();
  const expiresIn: number = payload.expires_in ?? 3600;
  spotifyTokenCache = {
    token: payload.access_token,
    expiresAt: now + expiresIn * 1000,
  };

  return spotifyTokenCache.token;
}

async function sendTelegramPhoto(chatId: number | string, photoUrl: string, caption: string, replyToMessageId: number) {
  await callTelegramApi('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    reply_parameters: { message_id: replyToMessageId },
  });
}

async function sendTelegramMessage(chatId: number | string, text: string, replyToMessageId: number) {
  await callTelegramApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_parameters: { message_id: replyToMessageId },
    disable_web_page_preview: true,
  });
}

async function callTelegramApi<T extends Record<string, unknown>>(method: string, body: T) {
  if (!TELEGRAM_API_BASE) {
    throw new Error('Telegram API base missing');
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API ${method} failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function formatSenderName(user?: TelegramUser): string {
  if (!user) {
    return 'Someone';
  }

  if (user.username) {
    return user.username.startsWith('@') ? user.username : `@${user.username}`;
  }

  const firstName = user.first_name ?? '';
  const lastName = user.last_name ?? '';
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || 'Someone';
}

function formatCaption(metadata: SpotifyMetadata, announcer: string): string {
  const who = announcer || 'Someone';
  switch (metadata.type) {
    case 'track':
    case 'album': {
      const yearSuffix = metadata.releaseYear ? ` (${metadata.releaseYear})` : '';
      return `${who} wants you to listen to ${metadata.title} by ${metadata.subtitle}${yearSuffix}!`;
    }
    case 'playlist':
      return `${who} wants you to explore the playlist ${metadata.title} by ${metadata.subtitle}!`;
    case 'artist':
      return `${who} wants you to check out ${metadata.title}${metadata.subtitle ? ` (${metadata.subtitle})` : ''}!`;
    case 'show':
      return `${who} wants you to listen to the podcast ${metadata.title} by ${metadata.subtitle}!`;
    case 'episode': {
      const yearSuffix = metadata.releaseYear ? ` (${metadata.releaseYear})` : '';
      return `${who} wants you to hear the episode ${metadata.title} from ${metadata.subtitle}${yearSuffix}!`;
    }
    default:
      return `${who} wants you to open ${metadata.title}!`;
  }
}
