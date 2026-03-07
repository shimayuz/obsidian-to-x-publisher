#!/usr/bin/env node
/**
 * obsidian-to-x-publisher Local HTTP Server v2.3.0
 *
 * OAuth 2.0 PKCE 認証フローを内蔵
 * OAuth はシステムブラウザで行う（ボット検出なし）
 * 記事投稿は Playwright Chrome を使用
 *
 * X Developer Portal に登録する Callback URI:
 *   http://127.0.0.1:3001/oauth/callback
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const dotenv = require('dotenv');

let chromium;
try {
    chromium = require('playwright').chromium;
} catch {
    // playwright not installed – fall back to system browser
}

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
    codeVerifier: null,
    expectedState: null,
    clientId: null,
    clientSecret: null,
    browserContext: null  // Playwright browser context (for cookie capture)
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
// OAuth Browser Launcher
// ========================================

async function launchOAuthBrowser(url) {
    if (!chromium) {
        // playwright 未インストール時はシステムブラウザにフォールバック
        console.log('[OAuth] システムブラウザで認証フローを開始します...');
        const openCmd = process.platform === 'win32' ? `start "" "${url}"`
                      : process.platform === 'linux'  ? `xdg-open "${url}"`
                      : `open "${url}"`;
        exec(openCmd, () => {});
        return;
    }

    // 専用プロファイルディレクトリ（ログイン状態を保持）
    const profileDir = path.join(__dirname, '../.x-chrome-profile');

    try {
        const context = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless: false,
            slowMo: 50,
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: { width: 1280, height: 900 },
            locale: 'ja-JP',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['ja', 'en-US', 'en'] });
        });

        oauth.browserContext = context;

        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        console.log('[OAuth] Chrome が起動しました。X にログインして「許可」をクリックしてください...');
    } catch (err) {
        console.warn('[OAuth] Chrome 起動失敗。システムブラウザで開きます:', err.message);
        oauth.browserContext = null;
        const openCmd = process.platform === 'win32' ? `start "" "${url}"`
                      : process.platform === 'linux'  ? `xdg-open "${url}"`
                      : `open "${url}"`;
        exec(openCmd, () => {});
    }
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
        // Also update live process.env
        process.env[key] = value;
    }
    fs.writeFileSync(ENV_PATH, content.trim() + '\n');
}

// ========================================
// Session Cookie Helpers
// ========================================

function hasValidSession() {
    if (!fs.existsSync(COOKIES_PATH)) return false;
    try {
        const state = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        return !!state.cookies?.find(c => c.name === 'auth_token' && c.value);
    } catch {
        return false;
    }
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
  .card { background: white; border-radius: 12px; padding: 48px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 440px; }
  h1 { color: ${color}; font-size: 24px; margin-bottom: 16px; }
  p { color: #6b7280; line-height: 1.6; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
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
        version: '2.3.0',
        oauthConnected: !!process.env.X_ACCESS_TOKEN,
        sessionReady: hasValidSession()
    });
});

// ========================================
// OAuth: Start Flow (opens system browser)
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

    const url = authUrl.toString();
    res.json({ status: 'pending' });

    // Launch in background (do not await)
    launchOAuthBrowser(url).catch(err => {
        console.error('[OAuth] ブラウザ起動失敗:', err.message);
        Object.assign(oauth, { status: 'error', error: 'ブラウザを開けませんでした: ' + err.message });
    });
});

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
        const tokens = await exchangeCodeForTokens(
            code,
            oauth.codeVerifier,
            oauth.clientId,
            oauth.clientSecret
        );

        // Persist Bearer tokens to .env
        updateEnvFile({
            X_ACCESS_TOKEN: tokens.access_token,
            X_REFRESH_TOKEN: tokens.refresh_token || ''
        });
        console.log('[OAuth] ✅ Bearer トークン取得完了');

        // Playwright コンテキストから Cookie を自動キャプチャ
        let cookiesCaptured = false;
        if (oauth.browserContext) {
            try {
                await new Promise(r => setTimeout(r, 800));
                const storageState = await oauth.browserContext.storageState();
                const authToken = storageState.cookies?.find(c => c.name === 'auth_token' && c.value)?.value;
                if (authToken) {
                    fs.writeFileSync(COOKIES_PATH, JSON.stringify(storageState, null, 2));
                    updateEnvFile({ X_AUTH_TOKEN: authToken });
                    const ct0 = storageState.cookies.find(c => c.name === 'ct0')?.value;
                    if (ct0) updateEnvFile({ X_CSRF_TOKEN: ct0 });
                    cookiesCaptured = true;
                    console.log('[OAuth] ✅ Cookie 自動取得完了 (auth_token, ct0)');
                }
            } catch (e) {
                console.warn('[OAuth] Cookie 自動取得失敗:', e.message);
            }

            const ctx = oauth.browserContext;
            oauth.browserContext = null;
            setTimeout(async () => {
                try { await ctx.close(); } catch {}
            }, 3000);
        }

        Object.assign(oauth, { status: 'success', error: null });

        res.send(renderCallbackPage(
            '✅ OAuth 認証完了',
            cookiesCaptured
                ? 'このタブを閉じて Obsidian に戻ってください。<br>投稿できるようになりました！'
                : 'このタブを閉じて Obsidian に戻ってください。<br>Cookie 設定の「保存する」から auth_token を手動入力してください。',
            true
        ));
    } catch (err) {
        Object.assign(oauth, { status: 'error', error: err.message });
        console.error('[OAuth] コールバックエラー:', err.message);
        if (oauth.browserContext) {
            const ctx = oauth.browserContext;
            oauth.browserContext = null;
            setTimeout(async () => { try { await ctx.close(); } catch {} }, 1000);
        }
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
        oauthConnected: !!process.env.X_ACCESS_TOKEN,
        sessionReady: hasValidSession(),
        // backward compat
        authenticated: hasValidSession()
    });
});

// ========================================
// Session Cookies: Manual Entry
// ========================================

app.post('/session/cookies', (req, res) => {
    const { authToken, csrfToken } = req.body || {};

    if (!authToken) {
        return res.status(400).json({ error: 'authToken は必須です' });
    }

    const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

    const storageState = {
        cookies: [
            { name: 'auth_token', value: authToken, domain: '.twitter.com', path: '/', httpOnly: true,  secure: true, sameSite: 'None', expires },
            { name: 'auth_token', value: authToken, domain: '.x.com',       path: '/', httpOnly: true,  secure: true, sameSite: 'None', expires },
            ...(csrfToken ? [
                { name: 'ct0', value: csrfToken, domain: '.twitter.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax', expires },
                { name: 'ct0', value: csrfToken, domain: '.x.com',       path: '/', httpOnly: false, secure: true, sameSite: 'Lax', expires }
            ] : [])
        ],
        origins: []
    };

    fs.writeFileSync(COOKIES_PATH, JSON.stringify(storageState, null, 2));
    updateEnvFile({ X_AUTH_TOKEN: authToken });
    if (csrfToken) updateEnvFile({ X_CSRF_TOKEN: csrfToken });

    console.log('[Session] ✅ Cookie を保存しました');
    res.json({ success: true });
});

// ========================================
// Publish Endpoint
// ========================================

app.post('/publish', async (req, res) => {
    const { title, markdown, images, headless } = req.body;

    if (!title || !markdown) {
        return res.status(400).json({ success: false, error: 'title と markdown は必須です' });
    }

    if (!hasValidSession()) {
        return res.status(401).json({
            success: false,
            error: 'セッション Cookie が設定されていません。Obsidian 設定の「セッション Cookie 設定」を完了してください。'
        });
    }

    try {
        console.log(`[Server] 投稿開始: "${title}"`);
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
    console.log(`\n[X Publisher Server] v2.3.0 起動`);
    console.log(`[X Publisher Server] http://127.0.0.1:${PORT}/health`);
    console.log(`[X Publisher Server] OAuth コールバック: ${REDIRECT_URI}\n`);

    if (!hasValidSession()) {
        console.warn('[X Publisher Server] ⚠️  Cookie 未設定 - Obsidian 設定から「セッション Cookie 設定」を完了してください\n');
    } else {
        console.log('[X Publisher Server] ✅ セッション Cookie 設定済み\n');
    }
});
