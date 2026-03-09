#!/usr/bin/env node
/**
 * obsidian-to-x-publisher Local HTTP Server v3.0.0
 *
 * GraphQL API パブリッシャーサーバー（Cookie ベース認証）
 * セッション Cookie は手動入力または Playwright Chrome で自動取得
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
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

dotenv.config({ path: ENV_PATH });

const { publishToXAPI } = require('./x-api-publisher');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ブラウザセッションセットアップ状態
const browserSetup = {
    status: 'idle', // 'idle' | 'running' | 'success' | 'error'
    error: null
};

const PROFILE_DIR = path.join(__dirname, '../.x-chrome-profile');

// ========================================
// Env Persistence
// ========================================

function clearEnvKeys(keys) {
    if (!fs.existsSync(ENV_PATH)) return;
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const key of keys) {
        content = content.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
        delete process.env[key];
    }
    const trimmed = content.trim();
    fs.writeFileSync(ENV_PATH, trimmed ? trimmed + '\n' : '');
}

function updateEnvFile(updates) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
    for (const [key, value] of Object.entries(updates)) {
        if (!value) continue;
        if (content.includes(`${key}=`)) {
            content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
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
// Health Check
// ========================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: '3.0.0',
        sessionReady: hasValidSession(),
        browserSetupStatus: browserSetup.status
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

    console.log('[Session] Cookie を保存しました');
    res.json({ success: true });
});

// ========================================
// Browser Session Setup Helpers
// ========================================

const CHROME_PATHS_MAC = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChromeBinary() {
    for (const p of CHROME_PATHS_MAC) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

async function waitForChromeReady(port, maxMs = 15000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`http://localhost:${port}/json/version`);
            if (resp.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

// ========================================
// Browser Session Setup
// ========================================

app.post('/session/browser-setup', async (req, res) => {
    if (!chromium) {
        return res.status(503).json({ error: 'Playwright がインストールされていません。npm install を実行してください。' });
    }
    if (browserSetup.status === 'running') {
        return res.status(409).json({ error: 'ブラウザが既に起動中です' });
    }

    const chromePath = findChromeBinary();
    if (!chromePath) {
        return res.status(503).json({ error: 'Google Chrome が見つかりません。Chrome をインストールしてください。' });
    }

    browserSetup.status = 'running';
    browserSetup.error = null;
    res.json({ status: 'running' });

    // バックグラウンドで実行
    (async () => {
        const CDP_PORT = 9222;
        let chromeProc = null;
        let browser = null;
        try {
            chromeProc = spawn(chromePath, [
                `--remote-debugging-port=${CDP_PORT}`,
                `--user-data-dir=${PROFILE_DIR}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-sync',
                'https://x.com'
            ], { stdio: 'ignore', detached: false });

            console.log('[BrowserSetup] Chrome を起動しました（bot 検出回避モード）。ログインしてください...');

            const ready = await waitForChromeReady(CDP_PORT, 15000);
            if (!ready) throw new Error('Chrome の起動がタイムアウトしました');

            browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
            const contexts = browser.contexts();
            const context = contexts.length > 0 ? contexts[0] : null;
            if (!context) throw new Error('ブラウザコンテキストが見つかりません');

            console.log('[BrowserSetup] X にログインするとクッキーが自動取得されます...');

            // auth_token が現れるまでポーリング（最大5分）
            let captured = false;
            for (let i = 0; i < 150; i++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const cookies = await context.cookies();
                    const authToken = cookies.find(c => c.name === 'auth_token' && c.value)?.value;
                    if (authToken) {
                        const storageState = { cookies, origins: [] };
                        fs.writeFileSync(COOKIES_PATH, JSON.stringify(storageState, null, 2));
                        updateEnvFile({ X_AUTH_TOKEN: authToken });
                        const ct0 = cookies.find(c => c.name === 'ct0')?.value;
                        if (ct0) updateEnvFile({ X_CSRF_TOKEN: ct0 });
                        captured = true;
                        console.log('[BrowserSetup] Cookie 取得完了！ブラウザを閉じます。');
                        break;
                    }
                } catch {}
            }

            try { await browser.close(); } catch {}
            browser = null;

            browserSetup.status = captured ? 'success' : 'error';
            if (!captured) browserSetup.error = 'タイムアウト。ログインが完了しませんでした。';
        } catch (err) {
            browserSetup.status = 'error';
            browserSetup.error = err.message;
            console.error('[BrowserSetup] エラー:', err.message);
        } finally {
            if (browser) { try { await browser.close(); } catch {} }
            if (chromeProc) { try { chromeProc.kill('SIGTERM'); } catch {} }
        }
    })();
});

app.get('/session/browser-setup/status', (req, res) => {
    res.json({
        status: browserSetup.status,
        error: browserSetup.error,
        sessionReady: hasValidSession()
    });
});

// ========================================
// Logout: Cookie・セッションをクリア
// ========================================

app.post('/session/logout', (req, res) => {
    if (fs.existsSync(COOKIES_PATH)) {
        try {
            fs.unlinkSync(COOKIES_PATH);
            console.log('[Logout] Cookie ファイルを削除しました');
        } catch (e) {
            console.warn('[Logout] Cookie ファイル削除失敗:', e.message);
        }
    }

    clearEnvKeys(['X_AUTH_TOKEN', 'X_CSRF_TOKEN']);

    console.log('[Logout] ログアウト完了');
    res.json({ success: true });
});

// Chrome プロファイルも含めた完全リセット
app.post('/session/reset', (req, res) => {
    Object.assign(browserSetup, { status: 'idle', error: null });

    if (fs.existsSync(PROFILE_DIR)) {
        try {
            fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
            console.log('[Reset] Chrome プロファイルを削除しました');
        } catch (e) { console.warn('[Reset] プロファイル削除失敗:', e.message); }
    }
    if (fs.existsSync(COOKIES_PATH)) {
        try { fs.unlinkSync(COOKIES_PATH); } catch {}
    }
    clearEnvKeys(['X_AUTH_TOKEN', 'X_CSRF_TOKEN']);
    console.log('[Reset] 完全リセット完了');
    res.json({ success: true });
});

// ========================================
// Publish Endpoint
// ========================================

app.post('/publish', async (req, res) => {
    const { title, markdown, images } = req.body;

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
        const result = await publishToXAPI({
            title,
            markdown,
            images: images || [],
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
    console.log(`\n[X Publisher Server] v3.0.0 起動`);
    console.log(`[X Publisher Server] http://127.0.0.1:${PORT}/health\n`);

    if (!hasValidSession()) {
        console.warn('[X Publisher Server] Cookie 未設定 - Obsidian 設定から「セッション Cookie 設定」を完了してください\n');
    } else {
        console.log('[X Publisher Server] セッション Cookie 設定済み\n');
    }
});
