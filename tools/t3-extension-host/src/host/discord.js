'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const PRESENCE_IMAGES = require('./presence-images');

const VSCODE_CLIENT_ID = '383226320970055681';
const HANDSHAKE = 0;
const FRAME = 1;
const ASSET_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const TEXT_LIMIT = 128;
// Discord accepts about 5 activity updates per 20 seconds; the extension's own updates come first.
const SETTLE_MS = 4000;

const LANGUAGE_NAMES = {
  csharp: 'C#', cpp: 'C++', css: 'CSS', dockerfile: 'Dockerfile', html: 'HTML', javascript: 'JavaScript',
  javascriptreact: 'JavaScript React', json: 'JSON', jsonc: 'JSON', markdown: 'Markdown', php: 'PHP',
  plaintext: 'text', powershell: 'PowerShell', python: 'Python', scss: 'SCSS', shellscript: 'shell',
  sql: 'SQL', typescript: 'TypeScript', typescriptreact: 'TypeScript React', vue: 'Vue', xml: 'XML', yaml: 'YAML',
};

function languageName(languageId) {
  if (!languageId) return 'text';
  return LANGUAGE_NAMES[languageId] ?? languageId.charAt(0).toUpperCase() + languageId.slice(1);
}

const AGENT_NAMES = {
  claudeagent: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', grok: 'Grok', kiro: 'Kiro', pi: 'Pi', muse: 'Muse',
};
const UPPERCASE_WORDS = new Set(['gpt', 'ai', 'glm', 'llm']);

// "cufora/claude-opus-5-5" -> "Claude Opus 5.5", "gpt-5.6-luna" -> "GPT 5.6 Luna"
function modelName(model) {
  if (typeof model !== 'string' || !model.trim()) return '';
  const words = model.trim().split('/').pop().split(/[-_\s]+/).filter(Boolean);
  const out = [];
  for (const word of words) {
    const previous = out[out.length - 1];
    if (/^\d+$/.test(word) && previous && /^\d+(\.\d+)*$/.test(previous) && !previous.includes('.')) out[out.length - 1] = `${previous}.${word}`;
    else if (UPPERCASE_WORDS.has(word.toLowerCase())) out.push(word.toUpperCase());
    else out.push(/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1));
  }
  return out.join(' ');
}

function agentName(provider) {
  if (typeof provider !== 'string' || !provider) return '';
  return AGENT_NAMES[provider.toLowerCase()] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function decode(chunk) {
  if (!Buffer.isBuffer(chunk) || chunk.length < 8 || chunk.readUInt32LE(4) !== chunk.length - 8) return null;
  const op = chunk.readUInt32LE(0);
  if (op !== HANDSHAKE && op !== FRAME) return null;
  try {
    return { op, payload: JSON.parse(chunk.subarray(8).toString('utf8')) };
  } catch {
    return null;
  }
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// Another Discord application doesn't have VS Code's image keys ("idle-vscode", "js", ...),
// so they are sent as links to VS Code's own copies of those images.
async function loadAssetUrls(cacheFile, logger) {
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {}
  if (!cached || Date.now() - cached.fetchedAt > ASSET_CACHE_MS) {
    try {
      const response = await fetch(`https://discord.com/api/v10/oauth2/applications/${VSCODE_CLIENT_ID}/assets`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const assets = (await response.json()).map(({ id, name }) => ({ id, name }));
      cached = { fetchedAt: Date.now(), assets };
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cached));
    } catch (error) {
      logger.warn(`Could not load Discord Presence images (${error.message})${cached ? '; using the saved copy' : '; language icons will be missing'}`);
    }
  }
  return new Map((cached?.assets ?? []).map(({ id, name }) => [name, `https://cdn.discordapp.com/app-assets/${VSCODE_CLIENT_ID}/${id}.png`]));
}

function fill(template, values) {
  if (typeof template !== 'string') return undefined;
  const text = template
    .replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key] ?? '') : match))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s·•|:–—-]+|[\s·•|:–—-]+$/g, '');
  const chars = Array.from(text);
  if (chars.length < 2) return undefined;
  return chars.length > TEXT_LIMIT ? `${chars.slice(0, TEXT_LIMIT - 1).join('')}…` : text;
}

function normalizeClientId(clientId, logger) {
  if (clientId === null || clientId === undefined || clientId === '') return null;
  if (typeof clientId !== 'string') {
    logger.warn(`Ignoring discordClientId ${JSON.stringify(clientId)}: write the Application ID as a string in quotes`);
    return null;
  }
  const id = clientId.trim();
  if (id === VSCODE_CLIENT_ID) return null;
  if (!/^\d{17,20}$/.test(id)) {
    logger.warn(`Ignoring discordClientId "${id}": Discord only accepts a real Application ID here${/^0+$/.test(id) ? ' (it rejects 0 as "Invalid Client ID")' : ''}`);
    return null;
  }
  return id;
}

function setText(target, key, template, values) {
  if (template === undefined) return;
  const text = fill(template, values);
  if (text === undefined) delete target[key];
  else target[key] = text;
}

function forMode(value, mode) {
  if (value === null || typeof value !== 'object') return value;
  return mode ? value[mode] : undefined;
}

function languageImage(languageImages, context) {
  if (!languageImages || typeof languageImages !== 'object') return undefined;
  const keys = [context?.extension, context?.languageId].filter(Boolean);
  for (const key of keys) {
    const match = Object.keys(languageImages).find((name) => name.toLowerCase() === key.toLowerCase());
    if (match && typeof languageImages[match] === 'string' && languageImages[match]) return languageImages[match];
  }
  return undefined;
}

function resolveImage(image, { assetUrls, presenceImages } = {}) {
  if (/^(https?|mp):/.test(image)) return image;
  if (presenceImages?.base && presenceImages.names.has(image)) return `${presenceImages.base}/${encodeURIComponent(image)}.png`;
  return assetUrls?.get(image) ?? image;
}

// Buttons and links would publish the workspace's git remote (Discord Presence's "View Repository").
function removeLinks(activity) {
  delete activity.buttons;
  delete activity.url;
  delete activity.details_url;
  delete activity.state_url;
  delete activity.assets.large_url;
  delete activity.assets.small_url;
  if (activity.metadata) {
    const { button_urls: _urls, ...metadata } = activity.metadata;
    if (Object.keys(metadata).length) activity.metadata = metadata;
    else delete activity.metadata;
  }
}

function rewriteActivity(activity, options) {
  const { context, status, largeImages, languageImages, smallImage, smallText, swapImages, showButtons } = options;
  const resolve = (image) => resolveImage(image, options);
  const next = { ...activity, assets: { ...(activity.assets ?? {}) } };
  const assets = next.assets;
  if (!showButtons) removeLinks(next);
  for (const key of ['large_image', 'small_image']) {
    if (typeof assets[key] === 'string') assets[key] = resolve(assets[key]);
  }
  const mode = context?.mode;
  const values = context ?? {};
  const texts = mode && status ? status[mode] : undefined;
  if (texts) {
    setText(next, 'details', texts.details, values);
    setText(next, 'state', texts.state, values);
    setText(assets, 'large_text', texts.largeText, values);
  }
  const largeImage = forMode(largeImages, mode);
  if (typeof largeImage === 'string' && largeImage) {
    if (largeImage !== 'language') assets.large_image = resolve(largeImage);
    else {
      const custom = languageImage(languageImages, context);
      if (custom) assets.large_image = resolve(custom);
    }
  }
  const small = forMode(smallImage, mode);
  if (typeof small === 'string' && small) assets.small_image = resolve(small);
  const smallLabel = forMode(smallText, mode);
  if (smallLabel !== undefined) setText(assets, 'small_text', smallLabel, values);
  if (swapImages) {
    [assets.large_image, assets.small_image] = [assets.small_image, assets.large_image];
    [assets.large_text, assets.small_text] = [assets.small_text, assets.large_text];
    for (const key of ['large_image', 'small_image', 'large_text', 'small_text']) if (assets[key] === undefined) delete assets[key];
  }
  return next;
}

async function installDiscordOverrides({
  clientId: rawClientId,
  smallImage,
  smallText,
  largeImages,
  languageImages,
  swapImages,
  presenceImagesUrl,
  showButtons,
  status,
  getContext,
  cacheDir,
  logger,
  settleMs = SETTLE_MS,
}) {
  const clientId = normalizeClientId(rawClientId, logger);
  const customApp = Boolean(clientId);
  const assetUrls = customApp ? await loadAssetUrls(path.join(cacheDir, 'discord-assets.json'), logger) : null;
  const original = net.Socket.prototype.write;
  const presenceImages = typeof presenceImagesUrl === 'string' && presenceImagesUrl ? { base: presenceImagesUrl.replace(/\/+$/, ''), names: PRESENCE_IMAGES } : null;
  const options = {
    status,
    largeImages,
    languageImages,
    smallImage,
    smallText,
    swapImages: Boolean(swapImages),
    showButtons: showButtons === true,
    presenceImages,
    assetUrls,
  };
  let last = null;
  let refreshes = 0;

  const rewrite = (payload) => ({
    ...payload,
    args: { ...payload.args, activity: rewriteActivity(payload.args.activity, { ...options, context: getContext?.() }) },
  });

  net.Socket.prototype.write = function write(chunk, ...rest) {
    const frame = decode(chunk);
    if (!frame) return original.call(this, chunk, ...rest);
    const { op, payload } = frame;
    if (op === HANDSHAKE && payload?.client_id === VSCODE_CLIENT_ID) {
      last = null;
      if (customApp) return original.call(this, encode(op, { ...payload, client_id: clientId }), ...rest);
    }
    if (op === FRAME && payload?.cmd === 'SET_ACTIVITY' && payload.nonce) {
      if (!payload.args?.activity) {
        last = null;
        logger.debug('Presence cleared');
        return original.call(this, chunk, ...rest);
      }
      const rewritten = rewrite(payload);
      last = { socket: this, payload, sent: JSON.stringify(rewritten.args.activity), at: Date.now() };
      const { details, state } = rewritten.args.activity;
      logger.debug(`Presence: ${[details, state].filter(Boolean).join(' / ')}`);
      return original.call(this, encode(op, rewritten), ...rest);
    }
    return original.call(this, chunk, ...rest);
  };

  if (customApp) logger.info(`Discord Presence uses Discord application ${clientId}`);

  // Sends the extension's last activity again when T3 Code's state changed but the extension had no reason to.
  return function refresh() {
    if (!last || last.socket.destroyed || !last.socket.writable) return false;
    const now = Date.now();
    if (now - last.at < settleMs) return false;
    const rewritten = rewrite(last.payload);
    const sent = JSON.stringify(rewritten.args.activity);
    if (sent === last.sent) return false;
    last.sent = sent;
    last.at = now;
    rewritten.nonce = `t3-refresh-${++refreshes}`;
    const { details, state } = rewritten.args.activity;
    logger.debug(`Presence: ${[details, state].filter(Boolean).join(' / ')}`);
    original.call(last.socket, encode(FRAME, rewritten));
    return true;
  };
}

module.exports = { agentName, installDiscordOverrides, languageName, modelName, normalizeClientId, rewriteActivity, VSCODE_CLIENT_ID };
