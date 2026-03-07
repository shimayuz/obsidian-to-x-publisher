#!/usr/bin/env node
/**
 * obsidian-to-x-publisher Local HTTP Server v2.0.0
 *
 * Obsidian プラグインと X Articles を橋渡しするローカルサーバー
 * OAuth 2.0 PKCE 認証フローを内蔵
 *
 * 使い方:
 *   npm run server
 *
 * X Developer Portal に登録する Callback URI:
 *   http://127.0.0.1:3001/oauth/callback
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

const ENV_PATH = path.join(__dirname, '../.env');
const COOKIES_PATH = path.join(__dirname, '../x-cookies.json');
const PORT = process.env.PORT || 3001;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;

dotenv.config({ path: ENV_PATH });

const { publishToX } = require('./x-publisher');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ========================================
// OAuth State (in-memory)
// ========================================

const oauth = {
    status: 'idle',       // 'idle' | 'pending' | 'success' | 'error'
    error: null,
    browserContext: null, // Playwright context (for cookie capture)
    codeVerifier: null,
    expectedState: null,
    clientId: null,
    clientSecret: null
};

// ========================================
// PKCE Helpers
// ========================================

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

// ========================================
// Token Exchange
// ========================================

async function exchangeCodeForTokens(code, codeVerifier, clientId, clientSecret) {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
        client_id: clientId
    });

    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (clientSecret) {
        const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
    }

    const response = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers,
        body: params.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`トークン取得失敗 (${response.status}): ${text}`);
    }

    return response.json();
}

// ========================================
// Env Persistence
// ========================================

function updateEnvFile(updates) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
    for (const [key, value] of Object.entries(updates)) {
        if (!value) continue;
        if (content.includes(`${key}=`)) {
            content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
    }
    fs.writeFileSync(ENV_PATH, content.trim() + '\n');
}

// ========================================
// Callback Page HTML
// ========================================

function renderCallbackPage(title, message, success) {
    const color = success ? '#10b981' : '#ef4444';
    return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9fafb; }
  .card { background: white; border-radius: 12px; padding: 48px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 400px; }
  h1 { color: ${color}; font-size: 24px; margin-bottom: 16px; }
  p { color: #6b7280; line-height: 1.6; }
</style>
</head>
<body>
<div class="card"><h1>${title}</h1><p>${message}</p></div>
</body>
</html>`;
}

// ========================================
// Health Check
// ========================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: '2.0.0',
        authenticated: fs.existsSync(COOKIES_PATH)
    });
});

// ========================================
// OAuth: Start Flow
// ========================================

app.post('/oauth/start', (req, res) => {
    if (oauth.status === 'pending') {
        return res.status(409).json({ error: '認証フローが既に実行中です' });
    }

    const { clientId, clientSecret } = req.body || {};
    if (!clientId) {
        return res.status(400).json({ error: 'clientId は必須です' });
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    Object.assign(oauth, {
        status: 'pending',
        error: null,
        browserContext: null,
        codeVerifier,
        expectedState: state,
        clientId,
        clientSecret: clientSecret || null
    });

    const authUrl = new URL('https://x.com/i/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    console.log('[OAuth] 認証フロー開始...');
    res.json({ status: 'pending' });

    // Launch Playwright browser in background
    launchOAuthBrowser(authUrl.toString()).catch(err => {
        if (oauth.status === 'pending') {
            Object.assign(oauth, { status: 'error', error: err.message, browserContext: null });
        }
        console.error('[OAuth] ブラウザ起動失敗:', err.message);
    });
});

async function launchOAuthBrowser(authUrl) {
    const { chromium } = require('playwright');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 50,
        args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--no-sandbox'],
        ignoreDefaultArgs: ['--enable-automation']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'ja-JP',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    oauth.browserContext = context;

    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['ja', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // eslint-disable-next-line no-undef
        window.chrome = { runtime: {}, loadTimes: function () { }, csi: function () { }, app: {} };
    });

    await page.goto(authUrl, { waitUntil: 'domcontentloaded' });

    // Wait for redirect to callback URL (Express /oauth/callback handles the code exchange)
    await page.waitForURL(
        url => url.href.startsWith(REDIRECT_URI),
        { timeout: 5 * 60 * 1000 }
    ).catch(() => {
        // Timeout: update status if still pending
        if (oauth.status === 'pending') {
            Object.assign(oauth, {
                status: 'error',
                error: 'タイムアウト: 5分以内に認証が完了しませんでした'
            });
        }
    });
}

// ========================================
// OAuth: Callback (redirect from X)
// ========================================

app.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        Object.assign(oauth, { status: 'error', error: `OAuth エラー: ${error}` });
        return res.send(renderCallbackPage('❌ 認証エラー', String(error), false));
    }

    if (oauth.status !== 'pending') {
        return res.send(renderCallbackPage('❌ エラー', '認証フローが開始されていません', false));
    }

    if (state !== oauth.expectedState) {
        Object.assign(oauth, { status: 'error', error: 'State パラメータ不一致' });
        return res.send(renderCallbackPage('❌ セキュリティエラー', 'State パラメータが一致しません', false));
    }

    try {
        // Capture Playwright cookies (x.com session) before page navigates away
        let storageState = { cookies: [], origins: [] };
        if (oauth.browserContext) {
            storageState = await oauth.browserContext.storageState();
        }

        // Exchange authorization code for OAuth tokens
        const tokens = await exchangeCodeForTokens(
            code,
            oauth.codeVerifier,
            oauth.clientId,
            oauth.clientSecret
        );

        // Persist browser cookies (Playwright storageState)
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(storageState, null, 2));

        // Persist OAuth tokens to .env
        updateEnvFile({
            X_ACCESS_TOKEN: tokens.access_token,
            X_REFRESH_TOKEN: tokens.refresh_token || ''
        });

        // Also save auth_token / ct0 from cookies to .env
        const authToken = storageState.cookies.find(c => c.name === 'auth_token')?.value;
        const csrfToken = storageState.cookies.find(c => c.name === 'ct0')?.value;
        if (authToken) updateEnvFile({ X_AUTH_TOKEN: authToken });
        if (csrfToken) updateEnvFile({ X_CSRF_TOKEN: csrfToken });

        // Close browser after page renders
        const ctx = oauth.browserContext;
        setTimeout(() => ctx?.browser()?.close().catch(() => {}), 1500);

        Object.assign(oauth, { status: 'success', error: null, browserContext: null });
        console.log('[OAuth] ✅ 認証完了');

        res.send(renderCallbackPage(
            '✅ 認証完了',
            'このタブを閉じてください。<br>Obsidian から X Article に投稿できるようになりました。',
            true
        ));
    } catch (err) {
        Object.assign(oauth, { status: 'error', error: err.message });
        console.error('[OAuth] コールバックエラー:', err.message);
        res.send(renderCallbackPage('❌ エラー', err.message, false));
    }
});

// ========================================
// OAuth: Status Polling
// ========================================

app.get('/oauth/status', (req, res) => {
    res.json({
        status: oauth.status,
        error: oauth.error,
        authenticated: fs.existsSync(COOKIES_PATH)
    });
});

// ========================================
// Publish Endpoint
// ========================================

app.post('/publish', async (req, res) => {
    const { title, markdown, images, headless } = req.body;

    if (!title || !markdown) {
        return res.status(400).json({ success: false, error: 'title と markdown は必須です' });
    }

    if (!fs.existsSync(COOKIES_PATH)) {
        return res.status(401).json({
            success: false,
            error: 'X アカウントが未連携です。Obsidian 設定から「X アカウントを連携」を実行してください。'
        });
    }

    try {
        console.log(`[Server] 投稿開始: "${title}"`);
        console.log(`[Server] 画像数: ${images?.length || 0}`);

        const result = await publishToX({
            title,
            markdown,
            images: images || [],
            headless: headless !== false
        });

        console.log(`[Server] 投稿完了: ${result.articleUrl}`);
        res.json({ success: true, articleUrl: result.articleUrl });
    } catch (error) {
        console.error('[Server] 投稿失敗:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========================================
// Start Server
// ========================================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n[X Publisher Server] v2.0.0 起動`);
    console.log(`[X Publisher Server] http://127.0.0.1:${PORT}/health`);
    console.log(`[X Publisher Server] OAuth コールバック: ${REDIRECT_URI}\n`);

    if (!fs.existsSync(COOKIES_PATH)) {
        console.warn('[X Publisher Server] ⚠️  未認証 - Obsidian 設定から「X アカウントを連携」してください\n');
    } else {
        console.log('[X Publisher Server] ✅ 認証済み\n');
    }
});
