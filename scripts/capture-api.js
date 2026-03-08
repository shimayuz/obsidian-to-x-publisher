#!/usr/bin/env node
/**
 * X Articles API キャプチャツール
 *
 * 目的:
 *   記事エディタで入力 → 自動保存される際のネットワークリクエストを捕捉し
 *   API エンドポイントとペイロード形式を特定する。
 *
 * 使い方:
 *   npm run capture-api
 *   → ブラウザが開くので、記事に何か入力して数秒待つ（自動保存を待つ）
 *   → ターミナルに API リクエストのログが出る
 *   → Ctrl+C で終了
 */

'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const COOKIES_PATH = path.join(__dirname, '../x-cookies.json');
const CDP_PORT = 9224; // capture用は 9224 を使用（server.js の 9223 と衝突回避）

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

// 捕捉対象のキーワード（記事保存・更新に関係しそうなもの）
const CAPTURE_PATTERNS = [
    /article/i,
    /draft/i,
    /create/i,
    /update/i,
    /upsert/i,
    /save/i,
    /publish/i,
    /upload/i,
    /media/i,
];

function shouldCapture(url) {
    // x.com または twimg.com への POST のみ対象
    if (!url.includes('x.com') && !url.includes('twitter.com') && !url.includes('twimg.com')) {
        return false;
    }
    return CAPTURE_PATTERNS.some(p => p.test(url));
}

function formatBody(body) {
    if (!body) return '(empty)';
    try {
        const parsed = JSON.parse(body);
        return JSON.stringify(parsed, null, 2);
    } catch {
        // URLencoded
        try {
            const decoded = decodeURIComponent(body);
            return decoded.length > 2000 ? decoded.slice(0, 2000) + '...(truncated)' : decoded;
        } catch {
            return body.length > 2000 ? body.slice(0, 2000) + '...(truncated)' : body;
        }
    }
}

async function main() {
    const chromePath = findChromeBinary();
    if (!chromePath) {
        console.error('Google Chrome が見つかりません');
        process.exit(1);
    }

    if (!fs.existsSync(COOKIES_PATH)) {
        console.error('x-cookies.json が見つかりません。先に npm run login を実行してください');
        process.exit(1);
    }

    const storageState = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const tempProfileDir = path.join(os.tmpdir(), `x-capture-${Date.now()}`);

    console.log('\n=== X Articles API キャプチャ ===');
    console.log('Chrome を起動中...');

    const chromeProc = spawn(chromePath, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${tempProfileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-extensions',
    ], { stdio: 'ignore', detached: false });

    await waitForChromeReady(CDP_PORT, 15000);

    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    const contexts = browser.contexts();
    const context = contexts[0];
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // Cookie 注入
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Network.enable');
    for (const cookie of storageState.cookies) {
        try {
            await cdpSession.send('Network.setCookie', {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                expires: cookie.expires || -1,
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure !== false,
                sameSite: cookie.sameSite || 'None',
                url: 'https://x.com',
            });
        } catch {}
    }

    // ─── リクエスト捕捉 ───────────────────────────────────────
    const captured = [];

    page.on('request', async (req) => {
        if (req.method() !== 'POST') return;
        const url = req.url();
        if (!shouldCapture(url)) return;

        const body = req.postData() || '';
        const headers = req.headers();

        const entry = {
            timestamp: new Date().toISOString(),
            method: req.method(),
            url,
            contentType: headers['content-type'] || '',
            body,
        };
        captured.push(entry);

        console.log('\n' + '─'.repeat(60));
        console.log(`📡 [${entry.timestamp}] POST ${url}`);
        console.log(`   Content-Type: ${entry.contentType}`);
        console.log('   Body:');
        console.log(formatBody(body).split('\n').map(l => '   ' + l).join('\n'));
    });

    page.on('response', async (resp) => {
        const url = resp.url();
        if (!shouldCapture(url)) return;
        if (resp.request().method() !== 'POST') return;

        let respBody = '';
        try {
            respBody = await resp.text();
        } catch {}

        console.log(`   ↳ Response ${resp.status()}: ${respBody.slice(0, 500)}`);

        // GraphQL クエリ名を抽出してログ
        try {
            const json = JSON.parse(respBody);
            const keys = Object.keys(json.data || {});
            if (keys.length) console.log(`   ↳ GraphQL data keys: ${keys.join(', ')}`);
        } catch {}
    });
    // ─────────────────────────────────────────────────────────

    // 記事一覧ページへ移動
    await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    console.log('\n✅ ブラウザを開きました');
    console.log('📝 ブラウザで記事に何か入力して、数秒待ってください（自動保存が走ります）');
    console.log('   → 保存リクエストがここにログされます');
    console.log('   Ctrl+C で終了\n');

    // Ctrl+C 終了処理
    process.on('SIGINT', () => {
        console.log('\n\n=== キャプチャ結果サマリー ===');
        console.log(`捕捉したリクエスト数: ${captured.length}`);

        if (captured.length > 0) {
            // ログファイルに保存
            const logPath = path.join(__dirname, `../api-capture-${Date.now()}.json`);
            fs.writeFileSync(logPath, JSON.stringify(captured, null, 2));
            console.log(`\n📄 詳細を保存しました: ${logPath}`);

            // 記事本文を含んでいそうなリクエストを強調
            const articleReqs = captured.filter(c =>
                c.body.includes('body') || c.body.includes('markdown') || c.body.includes('article')
            );
            if (articleReqs.length) {
                console.log('\n⭐ 記事本文を含む可能性があるリクエスト:');
                articleReqs.forEach(r => {
                    console.log(`  POST ${r.url}`);
                });
            }
        } else {
            console.log('リクエストが捕捉されませんでした。');
            console.log('→ ブラウザで記事に何か入力して保存操作を行ってください');
        }

        try { chromeProc.kill('SIGTERM'); } catch {}
        try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
        process.exit(0);
    });

    // 終了するまで待機
    await new Promise(() => {});
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
