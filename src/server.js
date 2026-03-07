#!/usr/bin/env node
/**
 * obsidian-to-x-publisher Local HTTP Server
 *
 * ObsidianプラグインからのリクエストをX Articlesに転送するローカルサーバー
 * ポート 3001 で起動
 *
 * 使い方:
 *   npm run server
 */

const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const { publishToX } = require('./x-publisher');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));

// ========================================
// Health Check
// ========================================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// ========================================
// Publish Endpoint
// ========================================

app.post('/publish', async (req, res) => {
    const { title, markdown, images, headless } = req.body;

    if (!title || !markdown) {
        return res.status(400).json({
            success: false,
            error: 'title と markdown は必須です'
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

        res.json({
            success: true,
            articleUrl: result.articleUrl
        });
    } catch (error) {
        console.error('[Server] 投稿失敗:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ========================================
// Start Server
// ========================================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[X Publisher Server] ポート ${PORT} で起動しました`);
    console.log(`[X Publisher Server] http://127.0.0.1:${PORT}/health で動作確認できます`);

    // Cookies ファイルの存在確認
    const fs = require('fs');
    const cookiesPath = path.join(__dirname, '../x-cookies.json');
    if (!fs.existsSync(cookiesPath)) {
        console.warn('[X Publisher Server] ⚠️  x-cookies.json が見つかりません');
        console.warn('[X Publisher Server]    先に npm run login を実行してください');
    } else {
        console.log('[X Publisher Server] ✅ x-cookies.json を確認');
    }
});
