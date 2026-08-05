const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
function resize(){ canvas.width = innerWidth; canvas.height = innerHeight; }
resize();
window.addEventListener('resize', resize);

const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');
const scoreVal = document.getElementById('scoreVal');
const waveVal = document.getElementById('waveVal');
const hpBar = document.getElementById('hpBar');

let W = ()=>canvas.width, H = ()=>canvas.height;

// レーンを5本に分割し、役割を固定する: 敵レーン3本・パワーアップレーン2本を交互配置
// [敵, 供給, 敵, 供給, 敵] という並びにすることで、自機が左右どちらに寄っても
// 「敵を避ける/撃つ」と「アイテムを取る」を両方カバーしやすい配置にしている
const LANE_COUNT = 5;
const ENEMY_LANES = [0, 2, 4];
const POWERUP_LANES = [1, 3];
function laneX(i){ return W() * ( (i+1) / (LANE_COUNT+1) ); }

// ---- game state ----
let player, bullets, enemies, particles, items, toasts;
let score, wave, playerHP, maxHP;
let fireTimer, spawnCooldown, waveTimer, running=false;
let touchX = null;
let itemSpawnTimer = 0;

// パワーアップは時間制限なしの永続レベルアップ方式。ただし放置していると一定時間ごとに1段階下がる
// (=取り続けないと火力が目減りする)。shieldだけは「被弾を肩代わりする回数」のストック。
const LEVEL_CAP = { rapid: 6, spread: 5, power: 8 };
const SHIELD_CAP = 3;
const LEVEL_DECAY_INTERVAL = 2400; // 約40秒ごとに全レベルが1段階ダウン
let levels = { rapid:0, spread:0, power:0 };
let shieldCharges = 0;
let levelDecayTimer = 0;

// 敵のティア定義。ウェーブが進むほど強いティアが解禁され、出現比率も上がっていく。
// hunter: trueの敵は一定間隔で自機のいるレーンへ狙いを変えてくる(その場に留まり続ける戦法を崩す)
const ENEMY_TIERS = [
  { key:'normal', unlockWave:1, hpMult:1,   sizeMult:1.0,  speedMult:1.0,  color:'#ff5f6d', dmg:14, scoreMult:1, hunter:false },
  { key:'hard',   unlockWave:2, hpMult:5,   sizeMult:1.25, speedMult:0.62, color:'#5a5f73', dmg:22, scoreMult:3, hunter:false },
  { key:'elite',  unlockWave:5, hpMult:9,   sizeMult:1.35, speedMult:0.78, color:'#8b5cf6', dmg:26, scoreMult:5, hunter:true  },
  { key:'titan',  unlockWave:9, hpMult:18,  sizeMult:1.6,  speedMult:0.5,  color:'#d92b3a', dmg:34, scoreMult:9, hunter:true  }
];

// ウェーブ数から出現重みを計算し、加重ランダムでティアを1つ選ぶ
function pickTier(){
  const weighted = [];
  for (const t of ENEMY_TIERS){
    if (wave < t.unlockWave) continue;
    let w;
    if (t.key === 'normal') w = Math.max(1, 10 - wave*0.5);
    else w = 2 + (wave - t.unlockWave) * 1.4;
    weighted.push({ t, w });
  }
  const total = weighted.reduce((s,x)=>s+x.w, 0);
  let r = Math.random()*total;
  for (const x of weighted){ r -= x.w; if (r<=0) return x.t; }
  return weighted[weighted.length-1].t;
}

function initGame(){
  // プレイヤーはレーン単位で移動する(自由な連続移動ではなく、5レーンのどこかに所属する)
  player = { x: laneX(2), y: H()-90, w: 46, h: 46, lane: 2, targetLane: 2 };
  bullets = [];
  enemies = [];
  particles = [];
  items = [];
  toasts = [];
  score = 0;
  wave = 1;
  maxHP = 100;
  playerHP = maxHP;
  fireTimer = 0;
  spawnCooldown = 40; // 開始直後から敵が来る
  waveTimer = 480; // 約8秒ごとに難易度(ウェーブ)が上昇
  itemSpawnTimer = 180; // 開始3秒後くらいに最初のアイテムが降ってくる
  levels = { rapid:0, spread:0, power:0 };
  shieldCharges = 0;
  levelDecayTimer = LEVEL_DECAY_INTERVAL;
  updateUI();
}

function updateUI(){
  scoreVal.textContent = score;
  waveVal.textContent = wave;
  hpBar.style.width = Math.max(0,(playerHP/maxHP*100)) + '%';
  renderBuffRow();
}

function renderBuffRow(){
  const row = document.getElementById('buffRow');
  const defs = [
    {k:'rapid', ic:'速', color:'#4fd1ff', val: levels.rapid},
    {k:'spread', ic:'散', color:'#c98bff', val: levels.spread},
    {k:'power', ic:'撃', color:'#ff5f6d', val: levels.power},
    {k:'shield', ic:'盾', color:'#4dff88', val: shieldCharges}
  ];
  row.innerHTML = defs.filter(d=>d.val>0).map(d=>
    `<div class="buff"><div class="ic" style="background:${d.color}">${d.ic}</div>${d.k==='shield' ? '×'+d.val : 'Lv'+d.val}</div>`
  ).join('');
}

// 敵レーン(0,2,4)固定で、一定間隔ごとに1列(最大3体)を継続的にスポーンし続ける方式。
// 「全滅させたら休憩できる」状態を無くし、常に画面内に敵がいる圧力を作る。
// ウェーブが進むほど間隔が短く、速度・耐久・硬い敵の比率が上がっていく。
function spawnInterval(){
  return Math.max(16, 68 - wave*6); // フレーム。ウェーブが進むほど短くなる=出現率アップ
}

function spawnEnemyRow(){
  const hpBase = 1 + Math.floor(wave/1.7);
  for (const lane of ENEMY_LANES){
    if (Math.random() < 0.85){ // まれに1レーン抜けて緩急をつける
      const tier = pickTier();
      const hp = Math.round(hpBase * tier.hpMult);
      enemies.push({
        lane,
        x: laneX(lane),
        y: -60,
        w: 34 * tier.sizeMult,
        h: 34 * tier.sizeMult,
        vy: (0.95 + wave*0.09) * tier.speedMult,
        hp, maxHp: hp,
        tier,
        hitFlash: 0,
        swayPhase: Math.random()*Math.PI*2,
        // hunterタイプは着地までの間、狙いを自機のレーンへ切り替えてくる
        shiftTimer: tier.hunter ? 55 + Math.random()*30 : Infinity,
        telegraph: 0
      });
    }
  }
}

// パワーアップレーン(1,3)専用。撃破ドロップではなく一定間隔で自動的に降ってくる。
// これを取り続けないと火力・耐久が追いつかず敵の圧力に押しつぶされる。
function spawnPowerupFromLane(){
  const lane = POWERUP_LANES[Math.floor(Math.random()*POWERUP_LANES.length)];
  const type = ITEM_TYPES[Math.floor(Math.random()*ITEM_TYPES.length)];
  items.push({ x: laneX(lane), y: -20, vy: 2.0, r: 15, type, hp: type.iceHp, maxHp: type.iceHp, hitFlash: 0 });
}

// ---- input ----
// ドラッグ位置に一番近いレーンをターゲットにする(自由な連続移動ではなくレーン単位のスナップ)
function nearestLane(x){
  let best = 0, bestDist = Infinity;
  for (let i=0;i<LANE_COUNT;i++){
    const d = Math.abs(laneX(i)-x);
    if (d<bestDist){ bestDist=d; best=i; }
  }
  return best;
}
canvas.addEventListener('touchstart', e=>{
  touchX = e.touches[0].clientX;
  player.targetLane = nearestLane(touchX);
}, {passive:true});
canvas.addEventListener('touchmove', e=>{
  touchX = e.touches[0].clientX;
  player.targetLane = nearestLane(touchX);
}, {passive:true});
canvas.addEventListener('touchend', ()=>{ touchX = null; }, {passive:true});
canvas.addEventListener('mousedown', e=>{ touchX = e.clientX; player.targetLane = nearestLane(touchX); });
canvas.addEventListener('mousemove', e=>{ if(touchX!==null){ player.targetLane = nearestLane(e.clientX); } });
window.addEventListener('mouseup', ()=>{ touchX=null; });

// キーボード操作(矢印キー): タッチ/マウスドラッグとは独立に targetLane を直接更新する
window.addEventListener('keydown', e=>{
  if (!player) return;
  if (e.key === 'ArrowLeft'){
    player.targetLane = Math.max(0, player.targetLane - 1);
  } else if (e.key === 'ArrowRight'){
    player.targetLane = Math.min(LANE_COUNT - 1, player.targetLane + 1);
  }
});

// ---- update ----
function fireBullet(){
  bullets.push({ x: player.x, y: player.y - player.h/2, vy: -9, r: 5 });
  bullets.push({ x: player.x-14, y: player.y - player.h/2+6, vy: -9, r: 4 });
  bullets.push({ x: player.x+14, y: player.y - player.h/2+6, vy: -9, r: 4 });
  // 拡散弾はレベルに応じて角度違いのペアが増えていく(永続強化)
  for (let i=1; i<=levels.spread; i++){
    const vx = 1.8 * i;
    bullets.push({ x: player.x, y: player.y - player.h/2, vy: -8.7, vx: -vx, r: 4 });
    bullets.push({ x: player.x, y: player.y - player.h/2, vy: -8.7, vx:  vx, r: 4 });
  }
}

function spawnParticles(x,y,color){
  for(let i=0;i<8;i++){
    particles.push({
      x, y, vx:(Math.random()-.5)*4, vy:(Math.random()-.5)*4,
      life:20, color
    });
  }
}

// iceHp: 氷を割って入手するのに必要な被弾数。永続レベル系は軽く、ストック系は重めにしている
const ITEM_TYPES = [
  {k:'rapid', color:'#4fd1ff', ic:'速', iceHp:1},
  {k:'spread', color:'#c98bff', ic:'散', iceHp:1},
  {k:'power', color:'#ff5f6d', ic:'撃', iceHp:2},
  {k:'shield', color:'#4dff88', ic:'盾', iceHp:3},
  {k:'heal', color:'#ff9f4f', ic:'回', iceHp:3}
];

// 撃破時のボーナスドロップ(低確率)。メインの供給は専用レーンから。
function maybeDropItem(x,y){
  if (Math.random() < 0.08){
    const type = ITEM_TYPES[Math.floor(Math.random()*ITEM_TYPES.length)];
    items.push({ x, y, vy: 1.6, r: 14, type, hp: type.iceHp, maxHp: type.iceHp, hitFlash: 0 });
  }
}

function applyItem(type){
  if (type.k === 'rapid') levels.rapid = Math.min(LEVEL_CAP.rapid, levels.rapid+1);
  else if (type.k === 'spread') levels.spread = Math.min(LEVEL_CAP.spread, levels.spread+1);
  else if (type.k === 'power') levels.power = Math.min(LEVEL_CAP.power, levels.power+1);
  else if (type.k === 'shield') shieldCharges = Math.min(SHIELD_CAP, shieldCharges+1);
  else if (type.k === 'heal') playerHP = Math.min(maxHP, playerHP + 30);
  updateUI();
}

function addToast(text, color){
  toasts.push({ text, color, life: 90, y: 90 });
}

function update(dt){
  // レーン移動: targetLaneへ滑らかに補間しつつ、現在レーンは即座に更新(当たり判定は即応させる)
  player.lane = player.targetLane;
  const tx = laneX(player.targetLane);
  player.x += (tx - player.x) * Math.min(1, 0.28*dt);

  // 難易度(ウェーブ)は時間経過で自動的に上昇。全滅待ちにしないことで常に圧力をかける
  waveTimer -= dt;
  if (waveTimer <= 0){
    wave++;
    waveTimer = 480;
    updateUI();
  }

  // アイテムレベルは放置していると一定時間ごとに1段階ダウンする(その場に居座るだけでは強さを維持できない)
  levelDecayTimer -= dt;
  if (levelDecayTimer <= 0){
    levelDecayTimer = LEVEL_DECAY_INTERVAL;
    let decayed = false;
    for (const k of ['rapid','spread','power']){
      if (levels[k] > 0){ levels[k]--; decayed = true; }
    }
    if (decayed){ addToast('強化が弱まった…アイテムを取ろう', '#ff9d9d'); updateUI(); }
  }

  // 敵の継続スポーン
  spawnCooldown -= dt;
  if (spawnCooldown <= 0){
    spawnEnemyRow();
    spawnCooldown = spawnInterval();
  }

  // パワーアップレーンへの自動供給(取り逃すとそのまま画面外へ)
  itemSpawnTimer -= dt;
  if (itemSpawnTimer <= 0){
    spawnPowerupFromLane();
    itemSpawnTimer = 300; // 約5秒間隔
  }

  fireTimer -= dt;
  const fireInterval = Math.max(2.5, 9 - levels.rapid*1.1); // レベルが上がるほど連射間隔が縮む
  if (fireTimer<=0){ fireBullet(); fireTimer = fireInterval; }

  bullets.forEach(b=>{ b.y += b.vy; if (b.vx) b.x += b.vx; });
  bullets = bullets.filter(b=> b.y > -20 && b.x>-20 && b.x<W()+20);

  // 敵はレーンに沿って直進(レーン内で軽く揺れるだけ、レーンをまたがない)。
  // hunterタイプは一定間隔で自機のいるレーンへ狙いを切り替える(予告フラッシュ付き)。
  enemies.forEach(en=>{
    en.swayPhase += 0.05;
    const sway = Math.sin(en.swayPhase) * 8; // 揺れ幅を小さく抑えてレーンを保つ
    en.x = laneX(en.lane) + sway;
    en.y += en.vy * dt;

    if (en.tier.hunter){
      if (en.telegraph > 0){
        en.telegraph -= dt;
        if (en.telegraph <= 0 && en.lane !== player.lane){
          en.lane = player.lane; // 予告後に自機のレーンへ切り替え
        }
      } else {
        en.shiftTimer -= dt;
        if (en.shiftTimer <= 0){
          en.shiftTimer = 110 + Math.random()*40;
          if (en.lane !== player.lane){ en.telegraph = 22; } // 切り替え前に少し光って予告
        }
      }
    }
  });

  // reach bottom -> レーンに関係なく必ず被弾する(避けても素通りにはならない)
  enemies = enemies.filter(en=>{
    if (en.y > H()-40){
      if (shieldCharges>0){
        shieldCharges -= 1;
        spawnParticles(en.x, H()-60, '#4dff88');
      } else {
        playerHP -= en.tier.dmg;
        spawnParticles(en.x, H()-60, '#ff5f6d');
      }
      updateUI();
      return false;
    }
    return true;
  });

  // bullet-enemy collision(攻撃力レベルに応じてダメージが永続的に上がる)
  const dmg = 1 + levels.power;
  for (let bi=bullets.length-1; bi>=0; bi--){
    const b = bullets[bi];
    for (let ei=enemies.length-1; ei>=0; ei--){
      const en = enemies[ei];
      const dx = b.x-en.x, dy=b.y-en.y;
      if (Math.sqrt(dx*dx+dy*dy) < en.w/2 + b.r){
        en.hp -= dmg;
        en.hitFlash = 6;
        bullets.splice(bi,1);
        if (en.hp<=0){
          score += 10 * en.tier.scoreMult;
          spawnParticles(en.x, en.y, en.tier.color);
          maybeDropItem(en.x, en.y);
          enemies.splice(ei,1);
          updateUI();
        }
        break;
      }
    }
  }

  // bullet-item collision(氷を割るたびにhpが減り、0になった瞬間に即座に効果を付与する)
  for (let bi=bullets.length-1; bi>=0; bi--){
    const b = bullets[bi];
    for (let ii=items.length-1; ii>=0; ii--){
      const it = items[ii];
      const dx = b.x-it.x, dy=b.y-it.y;
      if (Math.sqrt(dx*dx+dy*dy) < it.r + b.r){
        it.hp -= 1;
        it.hitFlash = 6;
        bullets.splice(bi,1);
        if (it.hp<=0){
          applyItem(it.type);
          spawnParticles(it.x, it.y, it.type.color);
          items.splice(ii,1);
        }
        break;
      }
    }
  }

  // items falling(触れても回収されない。入手するには撃って割る必要がある)
  items.forEach(it=> it.y += it.vy * dt);
  items = items.filter(it=> it.y <= H()+20);

  particles.forEach(p=>{ p.x+=p.vx; p.y+=p.vy; p.life--; });
  particles = particles.filter(p=>p.life>0);

  toasts.forEach(t=>{ t.life -= dt; });
  toasts = toasts.filter(t=>t.life>0);

  if (playerHP<=0){
    gameOver();
  }
}

// ---- draw ----
function draw(){
  ctx.clearRect(0,0,W(),H());

  // stars bg
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for(let i=0;i<40;i++){
    const sx = (i*97)%W();
    const sy = (i*53 + (Date.now()/20))%H();
    ctx.fillRect(sx, sy, 2, 2);
  }

  // レーン背景を役割ごとに色分け(敵レーン=赤み、供給レーン=水色み)して区別を明確化
  const laneW = W() / (LANE_COUNT+1) * 0.9;
  ENEMY_LANES.forEach(i=>{
    ctx.fillStyle = 'rgba(255,95,109,0.05)';
    ctx.fillRect(laneX(i)-laneW/2, 0, laneW, H());
  });
  POWERUP_LANES.forEach(i=>{
    ctx.fillStyle = 'rgba(79,209,255,0.06)';
    ctx.fillRect(laneX(i)-laneW/2, 0, laneW, H());
  });

  // 自機の現在レーンをハイライト(同じレーンに敵が来ると危険、という判断材料に)
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(laneX(player.lane)-laneW/2, 0, laneW, H());

  // レーン区切り線
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  for (let i=0; i<LANE_COUNT-1; i++){
    const lx = (laneX(i) + laneX(i+1)) / 2;
    ctx.beginPath();
    ctx.moveTo(lx, 0);
    ctx.lineTo(lx, H());
    ctx.stroke();
  }

  // player (triangle ship)
  ctx.save();
  ctx.translate(player.x, player.y);
  if (shieldCharges>0){
    ctx.strokeStyle = '#4dff88';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0,0, player.w/2+10, 0, Math.PI*2);
    ctx.stroke();
  }
  ctx.fillStyle = '#4fd1ff';
  ctx.beginPath();
  ctx.moveTo(0,-player.h/2);
  ctx.lineTo(player.w/2, player.h/2);
  ctx.lineTo(-player.w/2, player.h/2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.arc(0,4,6,0,Math.PI*2);
  ctx.fill();
  ctx.restore();

  // bullets(攻撃力レベルが上がるほど弾の色が白熱していく)
  ctx.fillStyle = levels.power>0 ? '#ff9d9d' : '#fff98a';
  bullets.forEach(b=>{
    ctx.beginPath();
    ctx.arc(b.x,b.y,b.r,0,Math.PI*2);
    ctx.fill();
  });

  // enemies
  enemies.forEach(en=>{
    ctx.save();
    ctx.translate(en.x, en.y);
    const flashing = en.hitFlash>0 || en.telegraph>0;
    if (en.hitFlash>0) en.hitFlash--;
    const key = en.tier.key;
    if (key === 'normal'){
      ctx.fillStyle = flashing ? '#fff' : en.tier.color;
      ctx.beginPath();
      ctx.moveTo(0, en.h/2);
      ctx.lineTo(en.w/2, -en.h/2);
      ctx.lineTo(-en.w/2, -en.h/2);
      ctx.closePath();
      ctx.fill();
    } else {
      // hard / elite / titan: 装甲風の八角形。ティアごとに色と縁取りが変わる
      ctx.fillStyle = flashing ? '#fff' : (key==='hard' ? '#5a5f73' : en.tier.color);
      ctx.strokeStyle = key==='hard' ? '#ff5f6d' : '#fff';
      ctx.lineWidth = key==='titan' ? 4 : 3;
      const s = en.w/2;
      ctx.beginPath();
      ctx.moveTo(-s*0.5,-s); ctx.lineTo(s*0.5,-s);
      ctx.lineTo(s,-s*0.5); ctx.lineTo(s,s*0.5);
      ctx.lineTo(s*0.5,s); ctx.lineTo(-s*0.5,s);
      ctx.lineTo(-s,s*0.5); ctx.lineTo(-s,-s*0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // hunterタイプ(elite/titan)は目玉アイコンで「追跡してくる」ことを示す
      if (en.tier.hunter){
        ctx.fillStyle = en.telegraph>0 ? '#fff98a' : '#0a0e1a';
        ctx.beginPath();
        ctx.arc(0,0, s*0.28, 0, Math.PI*2);
        ctx.fill();
      }
    }
    // hp mini bar(通常敵は複数HPになった時だけ表示、それ以外は常時表示)
    if (en.maxHp>1){
      ctx.fillStyle='rgba(0,0,0,.5)';
      ctx.fillRect(-en.w/2, -en.h/2-8, en.w, 4);
      ctx.fillStyle= key==='normal' ? '#4dff88' : en.tier.color;
      ctx.fillRect(-en.w/2, -en.h/2-8, en.w*(en.hp/en.maxHp), 4);
    }
    ctx.restore();
  });

  // items(氷漬け: 被弾フラッシュ・氷っぽい縁取り・残りHPのミニバーを表示)
  items.forEach(it=>{
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.fillStyle = it.hitFlash>0 ? '#fff' : it.type.color;
    if (it.hitFlash>0) it.hitFlash--;
    ctx.beginPath();
    ctx.arc(0,0,it.r,0,Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#0a0e1a';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.type.ic, 0, 1);
    if (it.maxHp>1){
      ctx.fillStyle='rgba(0,0,0,.5)';
      ctx.fillRect(-it.r, -it.r-8, it.r*2, 3);
      ctx.fillStyle='#fff';
      ctx.fillRect(-it.r, -it.r-8, it.r*2*(it.hp/it.maxHp), 3);
    }
    ctx.restore();
  });

  // particles
  particles.forEach(p=>{
    ctx.globalAlpha = p.life/20;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x-2,p.y-2,4,4);
    ctx.globalAlpha = 1;
  });

  // toasts(レベルダウン通知など)
  toasts.forEach(t=>{
    ctx.globalAlpha = Math.min(1, t.life/30);
    ctx.fillStyle = t.color;
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.text, W()/2, t.y);
    ctx.globalAlpha = 1;
  });
}

let lastTime = 0;
function loop(t){
  const dt = Math.min(2, (t-lastTime)/16.67 || 1);
  lastTime = t;
  if (running){
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
}

// 到達ウェーブに応じたランク。ゲームオーバー画面の演出に使う
const RANKS = [
  { min: 12, key:'S', color:'#ffd23f', msg:'レーンの支配者' },
  { min: 9,  key:'A', color:'#4fd1ff', msg:'熟練パイロット' },
  { min: 6,  key:'B', color:'#4dff88', msg:'一人前' },
  { min: 3,  key:'C', color:'#c98bff', msg:'見習い' },
  { min: 0,  key:'D', color:'#aab',    msg:'訓練中' }
];
function getRank(w){
  return RANKS.find(r => w >= r.min);
}

function gameOver(){
  running = false;
  const rank = getRank(wave);
  overlay.classList.add('gameover');
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="go-item go-rank" style="color:${rank.color}">${rank.key}</div>
    <div class="go-item go-rankmsg">${rank.msg}</div>
    <div class="go-item go-score">${score}</div>
    <p class="go-item go-sub">スコア ／ 到達ウェーブ ${wave}</p>
    <button id="startBtn" class="go-item go-btn">もう一度</button>
  `;
  document.getElementById('startBtn').addEventListener('click', startGame);
}

function startGame(){
  overlay.classList.remove('gameover');
  overlay.style.display = 'none';
  initGame();
  running = true;
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

startBtn.addEventListener('click', startGame);
