#!/usr/bin/env node
// 回帰シナリオのランナー。
//
//   node tools/verify.mjs            すべて実行
//   node tools/verify.mjs lanes      名前を指定して実行(複数可)
//   node tools/verify.mjs --list     シナリオ一覧
//
// Node 20以上が必要(Playwrightの要件)。詳細は docs/spec.md の検証ワークフローの章。

import { withGame, SHOT_DIR, SetupError } from './harness.mjs';

// --- 表明のための最小限のヘルパ ------------------------------------------

// 表明が落ちたことを表す。実行時エラーと区別するために専用の型にしている
class AssertionFailure extends Error {}

// 失敗したら即座に投げる(fail-fast)。
// こうすることで withGame 側が「失敗した瞬間の画面」をスクリーンショットに残せる。
// 最後まで走らせてから撮ると、そのころには画面が先へ進んでしまっていて診断に使えない
function makeChecker() {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) {
      failures.push(msg);
      throw new AssertionFailure(msg);
    }
    return true;
  };
  check.equal = (actual, expected, label) =>
    check(
      actual === expected,
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  check.failures = failures;
  // 失敗時に withGame が撮ったスクリーンショットのパスが積まれる
  check.shots = [];
  return check;
}

// --- シナリオ -------------------------------------------------------------

const scenarios = {
  // 通常プレイ(?debug=1なし)でエラーが出ないこと。
  // デバッグAPIを常設したことで通常プレイが壊れていないかの確認も兼ねる
  smoke: async (check) => {
    await withGame({ name: 'smoke', debug: false, check }, async (game) => {
      await game.page.waitForTimeout(1500);
      check(game.errors.length === 0, `コンソールエラー: ${JSON.stringify(game.errors)}`);

      // 通常プレイにデバッグAPIが漏れていないこと
      const leaked = await game.page.evaluate(() => !!window.__t);
      check.equal(leaked, false, '通常モードなのに window.__t が生えている');

      await game.shot('normal-play');
    });
  },

  // キーボード操作(issue #1)。矢印キーでレーンが1つずつ移動し、
  // 両端(0とLANE_COUNT-1)で止まる(範囲外に出ない)こと
  lanes: async (check) => {
    await withGame({ name: 'lanes', check }, async (game) => {
      let s = await game.snap();
      check.equal(s.playerLane, 2, '開始レーンは中央(2)');

      for (let i = 0; i < 5; i++) {
        await game.page.keyboard.press('ArrowLeft');
        await game.tick(1, 1);
      }
      s = await game.snap();
      check.equal(s.playerLane, 0, '左端(0)を超えない');

      for (let i = 0; i < 6; i++) {
        await game.page.keyboard.press('ArrowRight');
        await game.tick(1, 1);
      }
      s = await game.snap();
      check.equal(s.playerLane, 4, '右端(4)を超えない');
    });
  },

  // 被弾ルール(issue #2)。自機と異なるレーンの敵でも、下端到達で必ず被弾する
  // (以前は同じレーンのときだけ被弾していた)。無敵化での無効化も確認
  damage: async (check) => {
    await withGame({ name: 'damage', muteki: false, check }, async (game) => {
      await game.call('setPlayerLane', 0);
      const before = await game.snap();
      check.equal(before.playerHP, before.maxHP, '開始時はフルHP');

      // 自機と別レーン(4)に、下端到達済みの位置で敵を出す
      await game.call('spawnEnemy', 'normal', 4, 9999);
      await game.tick(1, 1);
      const after = await game.snap();
      check(after.playerHP < before.playerHP, '別レーンの敵でも下端到達で被弾する');
      check.equal(after.counts.enemies, before.counts.enemies, '到達した敵は消える');

      // 無敵化中はダメージを受けない
      await game.call('setInvincible', true);
      const beforeInv = await game.snap();
      await game.call('spawnEnemy', 'normal', 4, 9999);
      await game.tick(1, 1);
      const afterInv = await game.snap();
      check.equal(afterInv.playerHP, beforeInv.playerHP, '無敵化中はダメージを受けない');
    });
  },

  // 氷アイテムの2段階入手(issue #6 + 追加修正)。
  // 割る前は無反応、規定回数のヒットで割れるが即座には付与されず、
  // 割れた後にプレイヤーが触れて初めて効果が付与されること
  items: async (check) => {
    await withGame({ name: 'items', check }, async (game) => {
      // 自動連射・アイテム自動供給のタイマーを止め、forceFire()と
      // このシナリオで出したアイテムだけで挙動を制御する
      await game.call('setFireTimer', 999999);
      await game.call('setItemSpawnTimer', 999999);
      await game.call('setPlayerLane', 1);
      await game.call('clearItems');
      await game.call('clearBullets');
      // power(iceHp=2)を画面中段に出す。プレイヤーとは十分離して、
      // 割れた直後に接触しない位置にする
      await game.call('spawnItem', 'power', 1, 400);

      const before = await game.snap();
      check.equal(before.levels.power, 0, '割る前: powerレベルは0');

      // 1発目: まだ割れない
      await game.call('forceFire');
      await game.tick(60, 1);
      const afterHit1 = await game.snap();
      check.equal(afterHit1.counts.items, 1, '1発目: アイテムはまだ残っている');
      check.equal(afterHit1.counts.itemsBroken, 0, '1発目: まだ割れていない');
      check.equal(afterHit1.levels.power, 0, '1発目: 効果は付与されない');

      // 2発目: 割れる。ただしまだ触れていないので効果は付与されない
      await game.call('clearBullets');
      await game.call('forceFire');
      await game.tick(60, 1);
      const afterHit2 = await game.snap();
      check.equal(afterHit2.counts.items, 1, '2発目: 割れてもアイテムは画面上に残る');
      check.equal(afterHit2.counts.itemsBroken, 1, '2発目: broken状態になる');
      check.equal(afterHit2.levels.power, 0, '2発目: 触れるまで効果は付与されない');
      await game.shot('broken-waiting');

      // 割れたアイテムが自然落下でプレイヤーに触れるまで進める
      await game.tick(300, 1);
      const collected = await game.snap();
      check.equal(collected.counts.items, 0, '触れた後: アイテムが回収されて消える');
      check.equal(collected.levels.power, 1, '触れた後: powerレベルが上がる');
      await game.shot('collected');
    });
  },

  // 散アイテムの弾数段階(PR #9)。角度をつけた拡散ではなく、
  // レベルに応じて直線の弾が1→3→5発と段階的に増えること
  bullets: async (check) => {
    await withGame({ name: 'bullets', check }, async (game) => {
      const cases = [
        { level: 0, expectCount: 1 },
        { level: 1, expectCount: 3 },
        { level: 2, expectCount: 3 },
        { level: 3, expectCount: 5 },
        { level: 5, expectCount: 5 }
      ];
      for (const c of cases) {
        await game.call('setLevel', 'spread', c.level);
        await game.call('clearBullets');
        await game.call('forceFire');
        const s = await game.snap();
        check.equal(s.counts.bullets, c.expectCount, `spreadレベル${c.level}: 弾数`);
      }

      const hasVx = await game.page.evaluate(() => bullets.some((b) => b.vx !== undefined));
      check.equal(hasVx, false, 'すべての弾が直線(vxを持たない)');
      await game.shot('five-bullets');
    });
  },

  // ボス/コンボイ(issue #12)。強制出現中は通常のwave進行・雑魚スポーンが止まり、
  // 全滅させると再開すること
  boss: async (check) => {
    await withGame({ name: 'boss', check }, async (game) => {
      // --- 単体ボス ---
      await game.call('spawnBossNow', 'single');
      let s = await game.snap();
      check.equal(s.eventActive, true, '単体ボス: イベント中になる');
      check.equal(s.counts.enemies, 1, '単体ボス: 敵は1体(ボスのみ)');
      check(s.boss !== null, '単体ボス: snap()にボス情報が出る');

      const waveBefore = s.wave;
      await game.tick(200, 1); // 通常なら何度もwaveが進む長さ
      s = await game.snap();
      check.equal(s.wave, waveBefore, 'ボス戦中はwaveが進まない');
      check.equal(s.counts.enemies, 1, 'ボス戦中は雑魚が湧かない(ボスのみのまま)');

      await game.call('killBoss');
      await game.tick(1, 1);
      s = await game.snap();
      check.equal(s.eventActive, false, 'ボス撃破後にイベントが終わる');
      check.equal(s.counts.enemies, 0, 'ボス撃破後に敵がいなくなる');
      check(s.counts.items >= 1, 'ボス撃破は確定ドロップがある');
      await game.shot('single-defeated');

      // --- コンボイ ---
      await game.call('clearItems');
      await game.call('spawnBossNow', 'convoy');
      s = await game.snap();
      check.equal(s.eventActive, true, 'コンボイ: イベント中になる');
      check.equal(s.counts.enemies, 3, 'コンボイ: 敵専用レーンの数だけ出現する');
      await game.shot('convoy-spawned');

      await game.call('clearEnemies'); // 配列操作だけで全滅させても、残存チェックで正しく終了すること
      await game.tick(1, 1);
      s = await game.snap();
      check.equal(s.eventActive, false, 'コンボイ全滅後にイベントが終わる');
    });
  },

  // 緊急回避ボム(issue #13)。チャージがなければ発動しない、発動すると雑魚/コンボイは
  // 即死・ボスは大ダメージ(即死しない)・弾は残る、使用後は一定時間アイテムが取得できないこと
  bomb: async (check) => {
    await withGame({ name: 'bomb', check }, async (game) => {
      // 他タイマーの自然発火に横から邪魔されないよう止めておく
      await game.call('setFireTimer', 999999);
      await game.call('setItemSpawnTimer', 999999);

      // --- チャージ0: 発動しない ---
      await game.call('setBombCharges', 0);
      await game.call('spawnEnemy', 'normal', 0);
      await game.call('spawnEnemy', 'normal', 2);
      await game.call('useBomb');
      let s = await game.snap();
      check.equal(s.counts.enemies, 2, 'チャージ0: 発動せず敵はそのまま');
      check.equal(s.bombCharges, 0, 'チャージ0: 消費されない');

      // --- 雑魚・コンボイの即死、弾は残る、コンボイ全滅でイベントも終わる ---
      await game.call('clearEnemies');
      await game.call('setBombCharges', 1);
      await game.call('spawnBossNow', 'convoy'); // 敵専用レーン3体
      await game.call('spawnEnemy', 'normal', 0); // 通常の雑魚も混ぜる
      await game.call('forceFire');
      const beforeWipe = await game.snap();
      await game.call('useBomb');
      await game.tick(1, 1);
      s = await game.snap();
      check.equal(s.counts.enemies, 0, 'ボム: 雑魚・コンボイが全滅する');
      check.equal(s.eventActive, false, 'ボム: コンボイ全滅でイベントも終わる');
      check(s.score > beforeWipe.score, 'ボム: 撃破スコアが加算される');
      check.equal(s.bombCharges, 0, 'ボム: チャージが消費される');
      check.equal(s.counts.bullets, beforeWipe.counts.bullets, 'ボム: 弾は消えずに残る');

      // --- ボスは即死せず大ダメージ ---
      await game.call('clearEnemies');
      await game.call('spawnBossNow', 'single');
      await game.call('setBombCharges', 1);
      const bossBefore = (await game.snap()).boss;
      await game.call('useBomb');
      await game.tick(1, 1);
      s = await game.snap();
      check(s.boss !== null, 'ボム: ボスは即死せず残る');
      check(s.boss.hp < bossBefore.hp, 'ボム: ボスはダメージを受ける');
      check(s.boss.hp > s.boss.maxHp * 0.5, 'ボム: ボスは一撃では倒れない');

      // --- デメリット: 使用後は一定時間アイテムが取得できない ---
      await game.call('clearEnemies');
      await game.call('clearItems');
      await game.call('setBombCharges', 1);
      await game.call('setPlayerLane', 1);
      await game.call('useBomb'); // itemLockTimerがセットされる
      await game.call('spawnItem', 'rapid', 1, 700); // プレイヤーのすぐ近くに出す
      await game.call('forceFire');
      await game.tick(10, 1); // 弾が届いて割れるところまで
      s = await game.snap();
      check.equal(s.itemLocked, true, 'ボム直後: アイテムロック中である');
      check(s.counts.items >= 1, 'ロック中: 割れても回収されずアイテムが残る');
      check.equal(s.levels.rapid, 0, 'ロック中: レベルは上がらない');

      await game.tick(500, 1); // ロック(約480)が切れるまで進める
      s = await game.snap();
      check.equal(s.itemLocked, false, 'ロックが解除される');

      await game.call('clearItems');
      await game.call('spawnItem', 'rapid', 1, 700);
      await game.call('forceFire');
      await game.tick(20, 1);
      s = await game.snap();
      check.equal(s.counts.items, 0, 'ロック解除後: 割れたアイテムが回収される');
      check.equal(s.levels.rapid, 1, 'ロック解除後: レベルが上がる');
      await game.shot('after-unlock');
    });
  },

  // ゲームオーバーのランク表示(issue #5)。到達ウェーブに応じたランクが
  // 正しく表示されること
  gameover: async (check) => {
    await withGame({ name: 'gameover', check }, async (game) => {
      const cases = [
        { wave: 15, expectRank: 'S' },
        { wave: 10, expectRank: 'A' },
        { wave: 7, expectRank: 'B' },
        { wave: 4, expectRank: 'C' },
        { wave: 1, expectRank: 'D' }
      ];
      let first = true;
      for (const c of cases) {
        const cur = await game.snap();
        if (!cur.running) await game.call('start');
        await game.call('setWave', c.wave);
        await game.call('killPlayer');
        await game.tick(1, 1);
        const rankText = await game.page.evaluate(
          () => document.querySelector('.go-rank')?.textContent
        );
        check.equal(rankText, c.expectRank, `wave${c.wave}: ランク`);
        if (first) {
          await game.shot(`rank-${c.expectRank}`);
          first = false;
        }
      }
    });
  }
};

// --- CLI ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('シナリオ:');
    for (const name of Object.keys(scenarios)) console.log(`  ${name}`);
    return 0;
  }

  const unknown = args.filter((a) => !scenarios[a]);
  if (unknown.length) {
    console.error(`不明なシナリオ: ${unknown.join(', ')}`);
    console.error(`指定できるのは: ${Object.keys(scenarios).join(', ')}`);
    return 2;
  }

  const names = args.length ? args : Object.keys(scenarios);
  const results = [];

  for (const name of names) {
    const check = makeChecker();
    process.stdout.write(`▶ ${name} ... `);
    try {
      await scenarios[name](check);
      console.log('PASS');
      results.push({ name, ok: true });
    } catch (err) {
      if (err instanceof SetupError) throw err; // 環境不備は全体を止める

      if (err instanceof AssertionFailure) {
        console.log('FAIL');
        for (const f of check.failures) console.log(`    - ${f}`);
      } else {
        console.log('ERROR');
        console.log(`    ${err.stack || err.message}`);
      }
      for (const s of check.shots) console.log(`    ⤷ 失敗時の画面: ${s}`);
      results.push({ name, ok: false });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  console.log(`スクリーンショット: ${SHOT_DIR}`);
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // 環境不備は原因と対処だけを示す(スタックトレースは出さない)
    if (err instanceof SetupError) {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(2);
  });
