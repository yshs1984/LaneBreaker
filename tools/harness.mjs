// Playwrightでゲームを動かすための再利用ライブラリ。
// 使い捨てスクリプトで毎回書いていた定型処理(Node/Playwright/Chromiumの解決、
// 静的サーバの起動、デバッグAPIの待機、後片付け)をここに集約している。
//
// 使い方は tools/verify.mjs を参照。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// スクリーンショットの出力先。実行のたびに作り直す
export const SHOT_DIR = path.join(REPO_ROOT, '.verify-shots');

class SetupError extends Error {}

// --- 実行環境の解決 -------------------------------------------------------

function requireNode20() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    throw new SetupError(
      `PlaywrightはNode 20以上が必要ですが、現在は v${process.versions.node} です。\n` +
      'ポータブルなNode 20を用意して、それで実行してください。例:\n' +
      '  curl -sL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz\n' +
      '  mkdir -p /tmp/node20 && tar xf /tmp/node.tar.xz --strip-components=1 -C /tmp/node20\n' +
      '  /tmp/node20/bin/node tools/verify.mjs'
    );
  }
}

// npx経由でしか入っていない場合があるので、通常のimportに失敗したらキャッシュを探す
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // 続けてnpxキャッシュを走査する
  }

  const npxCache = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npxCache)) {
    for (const entry of fs.readdirSync(npxCache)) {
      const candidate = path.join(npxCache, entry, 'node_modules', 'playwright', 'index.mjs');
      if (fs.existsSync(candidate)) return await import(candidate);
      const cjs = path.join(npxCache, entry, 'node_modules', 'playwright');
      if (fs.existsSync(path.join(cjs, 'package.json'))) return await import(cjs);
    }
  }

  throw new SetupError(
    'Playwrightが見つかりません。次のいずれかで用意してください:\n' +
    '  npx playwright@latest install chromium\n' +
    '  npm i -D playwright'
  );
}

// chromium-1222 のようなバージョン固定を避け、入っている中で最新のものを選ぶ
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(base)) return null;

  const builds = fs.readdirSync(base)
    .filter(name => /^chromium-\d+$/.test(name))
    .map(name => ({ name, rev: Number(name.split('-')[1]) }))
    .sort((a, b) => b.rev - a.rev);

  for (const { name } of builds) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const exe = path.join(base, name, rel);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// --- 静的サーバ -----------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

// リポジトリルートを配信する。配信ディレクトリを取り違える事故を防ぐため、
// 外部コマンド(python3 -m http.server)には依存せずここで完結させる
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.join(REPO_ROOT, rel);

      // リポジトリ外へ抜ける参照は拒否する
      if (!filePath.startsWith(REPO_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.on('error', reject);
    // ポート0でOSに空きポートを割り当てさせる(ポート衝突を考えなくてよくなる)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// --- ゲーム操作のラッパ ---------------------------------------------------

function makeGame(page, errors, shotPrefix) {
  let shotCount = 0;

  const call = (name, ...args) =>
    page.evaluate(
      ([n, a]) => {
        if (!window.__t) throw new Error('window.__t が無い(?debug=1 で開いているか確認)');
        if (typeof window.__t[n] !== 'function') throw new Error(`window.__t.${n} が無い`);
        return window.__t[n](...a);
      },
      [name, args]
    );

  return {
    page,
    errors,
    call,
    snap: () => call('snap'),
    tick: (steps = 1, dt = 0.05) => call('tick', steps, dt),
    async shot(name) {
      shotCount += 1;
      const file = path.join(
        SHOT_DIR,
        `${shotPrefix}-${String(shotCount).padStart(2, '0')}-${name}.png`
      );
      await page.screenshot({ path: file });
      return file;
    }
  };
}

// 失敗したときの画面を残す。撮影自体が失敗しても本来のエラーを覆い隠さないよう、
// あくまでbest effortで行う
async function captureFailure(game, check) {
  if (!game) return;
  try {
    const file = await game.shot('FAILED');
    if (check && check.shots) check.shots.push(file);
  } catch {
    // ページやブラウザが既に落ちている場合は諦める
  }
}

/**
 * ゲームを開いて fn(game) を実行し、必ず後片付けする。
 *
 * opts:
 *   debug   — ?debug=1 で開くか(既定 true)。false にすると通常プレイと同じ条件になる
 *   start   — 自動でゲームを開始するか(既定 true)
 *   muteki  — 自動で無敵にするか(既定 true。debug:false のときは無視される)
 *   name    — スクリーンショットのファイル名の接頭辞
 *   check   — 表明ヘルパ。渡すと、表明が落ちた(＝例外が飛んだ)その瞬間の画面を
 *             ブラウザを閉じる前にスクリーンショットへ残す
 */
export async function withGame(opts, fn) {
  const { debug = true, start = true, muteki = true, name = 'run', check = null } = opts || {};

  requireNode20();
  const { chromium } = await loadPlaywright();
  const executablePath = findChromium();
  if (!executablePath) {
    throw new SetupError(
      'Chromiumが見つかりません。次で用意してください:\n  npx playwright@latest install chromium'
    );
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { server, port } = await startServer();
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

  let game = null;

  try {
    // iPhone 13相当。このゲームはスマホ縦持ち前提のレイアウト
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${port}/index.html${debug ? '?debug=1' : ''}`);

    if (debug) {
      await page.waitForFunction(() => !!window.__t, null, { timeout: 5000 });
    }

    game = makeGame(page, errors, name);

    if (start) {
      if (debug) {
        await game.call('start');
        if (muteki) await game.call('setInvincible', true);
        await game.tick(3, 0.03);
      } else {
        // 通常モードにはデバッグAPIが無いので、実際の#startBtnをクリックして開始する
        await page.click('#startBtn');
        await page.waitForTimeout(200);
      }
    }

    return await fn(game);
  } catch (err) {
    // 表明が落ちた／実行時エラーが出たその場の画面を、ブラウザを閉じる前に残す
    await captureFailure(game, check);
    throw err;
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

export { SetupError };
