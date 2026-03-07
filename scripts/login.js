#!/usr/bin/env node
/**
 * X (Twitter) OAuth 2.0 PKCE 認証スクリプト
 *
 * 仕組み:
 *   1. ローカルコールバックサーバーを起動 (port 3001)
 *   2. Playwright で x.com/i/oauth2/authorize を開く
 *      → X の本物のログイン画面が表示される (ボット検出なし)
 *   3. ユーザーが手動でログイン
 *   4. X がコールバック URL にリダイレクト
 *   5. アクセストークン + ブラウザ Cookie を保存
 *
 * 事前準備:
 *   1. https://developer.x.com でアプリを作成 (無料)
 *   2. Settings → User authentication → OAuth 2.0 を有効化
 *   3. Type: "Native App"
 *   4. Callback URL: http://127.0.0.1:3001/oauth/callback
 *   5. Client ID を .env の X_CLIENT_ID に設定
 *
 * 使い方:
 *   npm run login
 */

'use strict';

const { chromium } = require('playwright');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const COOKIES_PATH = path.join(__dirname, '../x-cookies.json');
const ENV_PATH = path.join(__dirname, '../.env');
const PORT = 3001;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;

// ========================================
// PKCE ヘルパー
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
// トークン交換
// ========================================

async function exchangeCodeForTokens(code, codeVerifier, clientId, clientSecret) {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
        client_id: clientId
    });

    // Confidential client（クライアントシークレットあり）は Basic 認証を使用
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (clientSecret) {
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
    }

    const response = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers,
        body: params.toString()
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`トークン取得失敗 (${response.status}): ${err}`);
    }

    return response.json();
}

// ========================================
// メイン認証フロー
// ========================================

async function login() {
    console.log('\n🔑 X OAuth 2.0 認証\n');

    // Client ID / Secret チェック
    const CLIENT_ID = process.env.X_CLIENT_ID;
    const CLIENT_SECRET = process.env.X_CLIENT_SECRET && process.env.X_CLIENT_SECRET !== 'your_client_secret_here'
        ? process.env.X_CLIENT_SECRET
        : null;

    if (CLIENT_SECRET) {
        console.log('🔒 Confidential Client モード（クライアントシークレットあり）');
    } else {
        console.log('🔓 Public Client モード（PKCE のみ）');
    }

    if (!CLIENT_ID || CLIENT_ID === 'your_client_id_here') {
        console.error('❌ X_CLIENT_ID が設定されていません\n');
        console.log('【事前準備】');
        console.log('  1. https://developer.x.com にアクセス');
        console.log('  2. 「Projects & Apps」→「Create App」');
        console.log('  3. 「User authentication settings」→「OAuth 2.0」を有効化');
        console.log('     - Type: Native App');
        console.log('     - Callback URI: http://127.0.0.1:3001/oauth/callback');
        console.log('  4. Client ID を取得');
        console.log('  5. .env に追加:');
        console.log('     X_CLIENT_ID=取得したClientID\n');
        process.exit(1);
    }

    // PKCE パラメータ生成
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    // OAuth URL 構築
    const oauthUrl = new URL('https://x.com/i/oauth2/authorize');
    oauthUrl.searchParams.set('response_type', 'code');
    oauthUrl.searchParams.set('client_id', CLIENT_ID);
    oauthUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    oauthUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
    oauthUrl.searchParams.set('state', state);
    oauthUrl.searchParams.set('code_challenge', codeChallenge);
    oauthUrl.searchParams.set('code_challenge_method', 'S256');

    console.log('📡 コールバックサーバーを起動します...');

    // コールバックサーバーとブラウザを並行して動かす
    const result = await new Promise(async (resolve, reject) => {
        const app = express();
        let browserContext = null;

        // タイムアウト: 5分
        const timeout = setTimeout(() => {
            reject(new Error('タイムアウト: 5分以内に認証が完了しませんでした'));
        }, 5 * 60 * 1000);

        // コールバックエンドポイント
        app.get('/oauth/callback', async (req, res) => {
            const { code, state: returnedState, error } = req.query;

            if (error) {
                clearTimeout(timeout);
                res.send(renderPage('❌ 認証エラー', error, false));
                reject(new Error(`OAuth エラー: ${error}`));
                return;
            }

            if (returnedState !== state) {
                clearTimeout(timeout);
                res.send(renderPage('❌ State 不一致', 'セキュリティエラー: state が一致しません', false));
                reject(new Error('State パラメータが一致しません'));
                return;
            }

            try {
                console.log('\n✅ コールバック受信 - トークンを取得中...');

                // コードをトークンに交換
                const tokens = await exchangeCodeForTokens(code, codeVerifier, CLIENT_ID, CLIENT_SECRET);

                // ブラウザの Cookie を取得（Playwright から）
                let storageState = null;
                if (browserContext) {
                    storageState = await browserContext.storageState();
                }

                clearTimeout(timeout);
                res.send(renderPage(
                    '✅ 認証完了',
                    'このタブを閉じてください。<br>Obsidian から X Article に投稿できるようになりました。',
                    true
                ));

                resolve({ tokens, storageState });
            } catch (err) {
                clearTimeout(timeout);
                res.send(renderPage('❌ エラー', err.message, false));
                reject(err);
            }
        });

        const server = app.listen(PORT, '127.0.0.1', async () => {
            console.log(`✅ コールバックサーバー起動: ${REDIRECT_URI}\n`);
            console.log('🌐 ブラウザを起動してX.comのログインページを開きます...');
            console.log('   メール/パスワードでログインしてください\n');

            try {
                // Playwright ブラウザ起動（ボット検出を回避する設定）
                const browser = await chromium.launch({
                    headless: false,
                    slowMo: 50,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--no-sandbox'
                    ],
                    ignoreDefaultArgs: ['--enable-automation']
                });

                browserContext = await browser.newContext({
                    viewport: { width: 1280, height: 900 },
                    locale: 'ja-JP',
                    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                });

                const page = await browserContext.newPage();

                // navigator.webdriver を隠してボット検出を回避
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    Object.defineProperty(navigator, 'languages', { get: () => ['ja', 'en-US', 'en'] });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                    // eslint-disable-next-line no-undef
                    window.chrome = {
                        runtime: {},
                        loadTimes: function () { },
                        csi: function () { },
                        app: {}
                    };
                });

                // OAuth 認可ページへ移動（X の本物のログイン画面が表示される）
                await page.goto(oauthUrl.toString(), { waitUntil: 'domcontentloaded' });

                // コールバックへのリダイレクトを待つ
                await page.waitForURL(
                    (url) => url.href.startsWith(REDIRECT_URI),
                    { timeout: 5 * 60 * 1000 }
                ).catch(() => {
                    // URL 変化を待つ別の方法（リダイレクトがブラウザで処理される場合）
                });

                // ブラウザは resolve 後に閉じる
                const checkClosed = setInterval(() => {
                    // resolve が呼ばれたら close
                }, 500);

            } catch (err) {
                reject(err);
            }
        });

        // Promise 解決時にサーバーを閉じる
        const origResolve = resolve;
        const wrappedResolve = (value) => {
            setTimeout(() => {
                server.close();
                if (browserContext) {
                    browserContext.browser()?.close().catch(() => { });
                }
            }, 1000);
            origResolve(value);
        };
        resolve = wrappedResolve;
    });

    // ========================================
    // 結果を保存
    // ========================================

    const { tokens, storageState } = result;

    console.log('\n💾 認証情報を保存中...');

    // x-cookies.json に Playwright の storageState を保存
    if (storageState) {
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(storageState, null, 2));
        console.log(`✅ Cookie を保存: ${COOKIES_PATH}`);
    } else {
        // storageState が取れなかった場合は空の構造を作成
        fs.writeFileSync(COOKIES_PATH, JSON.stringify({ cookies: [], origins: [] }, null, 2));
        console.log('⚠️  Cookie の保存に失敗しました（手動設定が必要な場合があります）');
    }

    // .env にトークンを書き込む
    updateEnvFile({
        X_ACCESS_TOKEN: tokens.access_token,
        X_REFRESH_TOKEN: tokens.refresh_token || '',
    });
    console.log('✅ トークンを .env に保存');

    // auth_token を Cookie から抽出して .env にも保存
    if (storageState?.cookies) {
        const authToken = storageState.cookies.find(c => c.name === 'auth_token')?.value;
        const csrfToken = storageState.cookies.find(c => c.name === 'ct0')?.value;
        if (authToken) updateEnvFile({ X_AUTH_TOKEN: authToken });
        if (csrfToken) updateEnvFile({ X_CSRF_TOKEN: csrfToken });
    }

    console.log('\n🎉 セットアップ完了！');
    console.log('   npm run server でサーバーを起動してください\n');
}

// ========================================
// .env ファイル更新
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
// コールバック画面 HTML
// ========================================

function renderPage(title, message, success) {
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
<div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body>
</html>`;
}

// ========================================
// エントリーポイント
// ========================================

login().catch(error => {
    console.error('\n❌ エラー:', error.message);
    process.exit(1);
});
