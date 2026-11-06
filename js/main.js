'use strict';
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const STEP = 1 / 60;
const MAX_SPEED = SEG_LEN / STEP;
const BOOST_FACTOR = 1.35, OFFROAD_FACTOR = 0.45;
const ACCEL = MAX_SPEED / 4.5, COAST = MAX_SPEED / 7, OVERSPEED_DECEL = MAX_SPEED / 1.4;
const STEER_RATE = 2.2, CENTRIFUGAL = 0.12, ROAD_LIMIT = 2.3;
const GRAVITY = 14000, RAMP_VY = 5400, AIR_CLEARANCE = 260;
const PLAYER_HW = 0.1, GLANCE_RATIO = 0.72;
const CRASH_TIME = 1.5, RECOVER_TIME = 1.6, TILT_TIME = 1.1;
const CHAIN_TIMEOUT = 6, MAX_MULT = 5, BOOST_DRAIN = 0.32;
const BOOST_BEACON = 0.015, BOOST_GATE = 0.0375;
const BEST_KEY = 'mudlark-rally-best';

const input = { left: false, right: false, boost: false };
let touchMode = false;

const game = {
  state: 'title', menu: 0, stageIndex: 0, stage: null, track: null, art: null,
  score: 0, time: 0, clock: 0, countdown: 0, clearTimer: 0, clearBonus: 0, paused: false,
  best: loadBest(), newBest: false, banner: null, popups: [], particles: [], skyX: 0, skyY: 0, shake: 0,
};

const player = {};

function loadBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

function saveBest() {
  if (game.score <= game.best) return;
  game.best = game.score;
  game.newBest = true;
  try { localStorage.setItem(BEST_KEY, String(game.best)); } catch { /* storage unavailable */ }
}

function resetPlayer() {
  Object.assign(player, {
    x: 0, z: 0, speed: 0, steer: 0, wy: 0, vy: 0, air: false, airTime: 0,
    crash: 0, invuln: 0, tilt: 0, tiltDir: 1, spin: 0, squash: 0, tread: 0, roll: 0,
    boost: 0.35, boosting: false, chain: 0, chainTimer: 0, slick: 0,
  });
}

function loadStage(index) {
  game.stageIndex = index;
  game.stage = STAGES[index];
  game.track = buildTrack(game.stage);
  game.art = makeStageArt(game.stage, index);
  game.popups.length = 0;
  game.particles.length = 0;
  game.banner = null;
  resetPlayer();
}

function startStage(index) {
  loadStage(index);
  game.time = game.stage.startTime;
  game.state = 'ready';
  game.countdown = 3;
}

function toTitle() {
  game.state = 'title';
  loadStage(game.menu);
  player.speed = MAX_SPEED * 0.55;
}

const segAt = z => {
  const { segs } = game.track;
  return segs[Math.max(0, Math.min(segs.length - 1, Math.floor(z / SEG_LEN)))];
};

function groundAt(z) {
  const s = segAt(z);
  const p = (z - s.p1.world.z) / SEG_LEN;
  return s.p1.world.y + (s.p2.world.y - s.p1.world.y) * Math.max(0, Math.min(1, p));
}

const multiplier = () => Math.min(MAX_MULT, 1 + Math.floor(player.chain / 5));

function addScore(points, label, color = '#fff') {
  game.score += points;
  game.popups.push({ text: label ? `${label} +${points}` : `+${points}`, life: 1.1, y: game.popups.length * 15, color });
}

function showBanner(text, sub, time = 1.8) {
  game.banner = { text, sub, life: time };
}

function crash() {
  if (player.invuln > 0 || player.crash > 0) return;
  player.crash = CRASH_TIME;
  player.tilt = 0;
  player.chain = 0;
  player.boosting = false;
  game.shake = 12;
  sound.crash();
  burst(VIEW_W / 2, VIEW_H - 40, 26, ['#ffcf3f', '#ff5a3c', '#fff'], 260);
}

function glance(dir) {
  if (player.invuln > 0) return;
  if (player.tilt > 0) { crash(); return; }
  player.tilt = TILT_TIME;
  player.tiltDir = dir;
  game.shake = 5;
  sound.glance();
  addScore(150, 'TWO WHEELS', '#7fe3ff');
  burst(VIEW_W / 2 + dir * 40, VIEW_H - 20, 8, ['#ffcf3f', '#fff'], 180);
}

function collect(item) {
  item.taken = true;
  player.chain++;
  player.chainTimer = CHAIN_TIMEOUT;
  player.boost = Math.min(1, player.boost + BOOST_BEACON);
  const mult = multiplier();
  addScore(100 * mult, mult > 1 ? `x${mult}` : '', '#ffd23c');
  sound.beacon(mult);
}

function hitItem(item, height) {
  const reach = PLAYER_HW + item.hw;
  const gap = Math.abs(player.x - item.x);
  if (item.k === 'beacon') {
    const reachable = Math.abs(height - item.lift) < (item.lift > 0 ? 620 : 420);
    if (!item.taken && gap < reach && reachable) collect(item);
    return;
  }
  if (gap >= reach) return;
  if (item.k === 'gate') {
    if (item.taken) return;
    item.taken = true;
    player.boost = Math.min(1, player.boost + BOOST_GATE);
    addScore(500, 'GATE', '#5ff0d8');
    sound.gate();
    return;
  }
  if (height > AIR_CLEARANCE) return;
  switch (item.k) {
    case 'ramp':
      if (player.speed > MAX_SPEED * 0.2) {
        player.air = true;
        player.airTime = 0;
        player.vy = RAMP_VY * (0.4 + 0.6 * Math.min(1.15, player.speed / MAX_SPEED));
        sound.launch();
      }
      break;
    case 'puddle':
      if (player.slick <= 0) {
        player.speed *= 0.82;
        sound.splash();
        burst(VIEW_W / 2, VIEW_H - 14, 14, ['#b7d6e2', '#6f93a8', '#fff'], 200);
      }
      player.slick = 0.45;
      break;
    case 'boulder':
    case 'barrel':
      if (gap > reach * GLANCE_RATIO) glance(Math.sign(item.x - player.x) || 1);
      else crash();
      break;
    case 'trunk':
      crash();
      break;
    default:
      if (item.solid) crash();
  }
}

function crossSegment(seg, height) {
  for (const item of seg.items) {
    if (item.scenery && !item.solid) continue;
    hitItem(item, height);
  }
  if (seg.checkpoint) reachCheckpoint();
  if (seg.finish) finishStage();
}

function reachCheckpoint() {
  game.time += game.stage.legTime;
  sound.checkpoint();
  showBanner('CHECKPOINT', `+${Math.round(game.stage.legTime)} SECONDS`);
}

function finishStage() {
  game.clearBonus = Math.ceil(game.time) * 200;
  game.score += game.clearBonus;
  game.clearTimer = 4.5;
  game.state = 'clear';
  sound.fanfare();
}

// One physics tick. Pass controls = null to let the rover coast with nobody at the wheel.
function stepPlayer(dt, controls) {
  const p = player;
  const startSeg = segAt(p.z + PLAYER_Z);
  const pct = p.speed / MAX_SPEED;
  const height = () => p.wy - groundAt(p.z + PLAYER_Z);

  p.invuln = Math.max(0, p.invuln - dt);
  p.slick = Math.max(0, p.slick - dt);
  p.squash = Math.max(0, p.squash - dt * 5);

  if (p.crash > 0) {
    p.crash -= dt;
    p.speed = Math.max(0, p.speed - MAX_SPEED * 1.6 * dt);
    p.spin += dt * 14;
    if (p.crash <= 0) {
      p.spin = 0;
      p.invuln = RECOVER_TIME;
      p.x = Math.max(-0.9, Math.min(0.9, p.x));
    }
  } else {
    const steerIn = controls ? (controls.right ? 1 : 0) - (controls.left ? 1 : 0) : 0;
    p.steer += (steerIn - p.steer) * Math.min(1, dt * 11);
    const grip = (p.air ? 0.4 : 1) * (p.tilt > 0 ? 0.55 : 1) * (p.slick > 0 ? 0.6 : 1);
    const turn = dt * STEER_RATE * Math.min(1, pct * 2);
    p.x += p.steer * turn * grip;
    if (!p.air) p.x -= turn * pct * startSeg.curve * CENTRIFUGAL;
    p.x = Math.max(-ROAD_LIMIT, Math.min(ROAD_LIMIT, p.x));

    const offroad = Math.abs(p.x) > 1.05 && !p.air;
    const wantBoost = controls && controls.boost && p.boost > 0 && !offroad;
    if (wantBoost && !p.boosting) sound.boost();
    p.boosting = wantBoost;
    if (p.boosting) p.boost = Math.max(0, p.boost - BOOST_DRAIN * dt);

    let limit = MAX_SPEED * (p.boosting ? BOOST_FACTOR : 1);
    if (offroad) limit *= OFFROAD_FACTOR;
    if (p.boosting) p.speed += ACCEL * 2.2 * dt;
    else if (controls) p.speed += ACCEL * dt * (1.15 - pct * 0.5);
    else p.speed -= COAST * dt;
    if (p.speed > limit) p.speed = Math.max(limit, p.speed - OVERSPEED_DECEL * dt);
    p.speed = Math.max(0, p.speed);

    if (offroad && p.speed > 1000) {
      game.shake = Math.max(game.shake, 2);
      if (Math.random() < 0.5) dust(game.stage.pal.ground[0]);
    }
  }

  p.tilt = Math.max(0, p.tilt - dt);
  if (p.chainTimer > 0) {
    p.chainTimer -= dt;
    if (p.chainTimer <= 0) p.chain = 0;
  }

  const oldFront = p.z + PLAYER_Z;
  const oldGround = groundAt(oldFront);
  p.z += p.speed * dt;
  const front = p.z + PLAYER_Z;
  const ground = groundAt(front);
  p.tread = (p.tread + p.speed * dt * 0.012) % 360;

  // Hill crests can throw the rover into the air just as ramps do.
  if (p.air) {
    p.airTime += dt;
    p.vy -= GRAVITY * dt;
    p.wy += p.vy * dt;
    if (p.wy <= ground) land(ground);
  } else {
    const groundVy = (ground - oldGround) / dt;
    if (groundVy < p.vy - GRAVITY * dt - 260) {
      p.air = true;
      p.airTime = 0;
      p.vy -= GRAVITY * dt;
      p.wy += p.vy * dt;
    } else {
      p.vy = groundVy;
      p.wy = ground;
    }
  }

  const from = Math.floor(oldFront / SEG_LEN) + 1, to = Math.floor(front / SEG_LEN);
  if (game.state === 'play') {
    for (let i = from; i <= to && game.state === 'play'; i++) crossSegment(game.track.segs[i], height());
  }

  const lean = p.tilt > 0 ? -p.tiltDir * 0.42 * Math.min(1, p.tilt * 4) : 0;
  const target = lean + p.steer * 0.1 * Math.min(1, pct * 1.5) + (p.air ? p.steer * 0.12 : 0);
  p.roll += (target - p.roll) * Math.min(1, dt * 12);
}

function land(ground) {
  const p = player;
  const hang = p.airTime;
  p.air = false;
  p.wy = ground;
  p.vy = 0;
  if (hang > 0.3) {
    p.squash = 1;
    game.shake = Math.max(game.shake, 4);
    sound.land();
    dust(game.stage.pal.road[0], 10);
    if (game.state === 'play' && p.crash <= 0) addScore(Math.round(hang * 10) * 40, 'AIR', '#ffa0e0');
  }
}

function dust(color, count = 1) {
  for (let i = 0; i < count; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    game.particles.push({
      x: VIEW_W / 2 + side * 42, y: VIEW_H - 8, vx: side * 30 + (Math.random() - 0.5) * 70,
      vy: -40 - Math.random() * 70, life: 0.5, max: 0.5, size: 4 + Math.random() * 6, color,
    });
  }
}

function burst(x, y, count, colors, force) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = force * (0.3 + Math.random() * 0.7);
    game.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.7, max: 0.7, size: 2 + Math.random() * 4,
      color: colors[i % colors.length],
    });
  }
}

function update(dt) {
  game.clock += dt;
  game.shake = Math.max(0, game.shake - dt * 22);
  for (const p of game.particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 240 * dt;
  }
  game.particles = game.particles.filter(p => p.life > 0);
  for (const p of game.popups) { p.life -= dt; p.y += dt * 42; }
  game.popups = game.popups.filter(p => p.life > 0);
  if (game.banner && (game.banner.life -= dt) <= 0) game.banner = null;

  const seg = segAt(player.z + PLAYER_Z);
  const pct = player.speed / MAX_SPEED;
  game.skyX += seg.curve * pct * dt * 34;
  const slope = (seg.p2.world.y - seg.p1.world.y) / SEG_LEN;
  game.skyY += (slope * 46 - game.skyY) * Math.min(1, dt * 3);

  switch (game.state) {
    case 'title':
      player.z += player.speed * dt;
      player.wy = groundAt(player.z + PLAYER_Z);
      if (player.z > game.track.finishZ - SEG_LEN * 100) player.z = 0;
      break;
    case 'ready': {
      const before = Math.ceil(game.countdown);
      game.countdown -= dt;
      if (Math.ceil(game.countdown) !== before) sound.count(game.countdown <= 0);
      if (game.countdown <= 0) game.state = 'play';
      break;
    }
    case 'play': {
      const before = Math.ceil(game.time);
      game.time -= dt;
      if (before <= 10 && Math.ceil(game.time) !== before) sound.tick();
      stepPlayer(dt, input);
      if (game.state === 'play' && game.time <= 0) {
        game.time = 0;
        game.state = 'over';
        saveBest();
        sound.gameOver();
      }
      break;
    }
    case 'over':
      stepPlayer(dt, null);
      break;
    case 'clear':
      stepPlayer(dt, null);
      game.clearTimer -= dt;
      if (game.clearTimer <= 0) advanceStage();
      break;
  }

  const live = game.state === 'play' || game.state === 'clear' || game.state === 'over';
  sound.engine(Math.min(1.35, pct), live || game.state === 'ready');
}

function advanceStage() {
  if (game.stageIndex + 1 < STAGES.length) startStage(game.stageIndex + 1);
  else {
    game.state = 'won';
    saveBest();
    sound.fanfare();
  }
}

// --- Rendering -----------------------------------------------------------------------------

function project(p, camX, camY, camZ) {
  p.camera.x = -camX;
  p.camera.y = p.world.y - camY;
  p.camera.z = p.world.z - camZ;
  p.screen.scale = CAM_DEPTH / p.camera.z;
  p.screen.x = Math.round(VIEW_W / 2 + p.screen.scale * p.camera.x * VIEW_W / 2);
  p.screen.y = Math.round(VIEW_H / 2 - p.screen.scale * p.camera.y * VIEW_H / 2);
  p.screen.w = Math.round(p.screen.scale * ROAD_W * VIEW_W / 2);
}

function quad(color, x1, y1, w1, x2, y2, w2) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 - w1, y1);
  ctx.lineTo(x2 - w2, y2);
  ctx.lineTo(x2 + w2, y2);
  ctx.lineTo(x1 + w1, y1);
  ctx.closePath();
  ctx.fill();
}

function drawSegment(seg, pal, fog) {
  const a = seg.p1.screen, b = seg.p2.screen;
  const band = seg.band;
  ctx.fillStyle = pal.ground[band];
  ctx.fillRect(0, b.y, VIEW_W, a.y - b.y);
  quad(pal.edge[band], a.x, a.y, a.w * 1.09, b.x, b.y, b.w * 1.09);
  quad(pal.road[band], a.x, a.y, a.w, b.x, b.y, b.w);
  for (const off of [-0.42, 0.42]) {
    quad(pal.rut, a.x + a.w * off, a.y, a.w * 0.05, b.x + b.w * off, b.y, b.w * 0.05);
  }
  if (seg.checkpoint || seg.finish || seg.startLine) {
    const cells = 10, ca = a.w * 2 / cells, cb = b.w * 2 / cells;
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = i % 2 ? '#fff' : '#17151c';
      ctx.beginPath();
      ctx.moveTo(a.x - a.w + ca * i, a.y);
      ctx.lineTo(b.x - b.w + cb * i, b.y);
      ctx.lineTo(b.x - b.w + cb * (i + 1), b.y);
      ctx.lineTo(a.x - a.w + ca * (i + 1), a.y);
      ctx.fill();
    }
  }
  if (fog > 0.01) {
    ctx.globalAlpha = fog;
    ctx.fillStyle = pal.fog;
    ctx.fillRect(0, b.y, VIEW_W, a.y - b.y);
    ctx.globalAlpha = 1;
  }
}

function drawItem(seg, item, n) {
  const s = seg.p1.screen;
  if (!(s.scale > 0)) return;
  const img = game.art[item.k];
  const px = s.scale * VIEW_W / 2;
  const w = item.w * px, h = item.h * px;
  const bob = item.k === 'beacon' ? Math.sin(game.clock * 4 + seg.index) * 36 + 150 : 0;
  const x = s.x + s.scale * item.x * ROAD_W * VIEW_W / 2 - w / 2;
  const y = s.y - h - (item.lift + bob) * s.scale * VIEW_H / 2;
  const hidden = Math.max(0, y + h - seg.clip);
  if (hidden >= h || x > VIEW_W || x + w < 0) return;
  ctx.globalAlpha = Math.min(1, (DRAW_DIST - n) / 26);
  ctx.drawImage(img, 0, 0, img.width, img.height * (1 - hidden / h), x, y, w, h - hidden);
  ctx.globalAlpha = 1;
}

function drawBackdrop(pal) {
  const art = game.art;
  ctx.drawImage(art.sky, 0, 0);
  const layer = (img, speed, base) => {
    const top = base + game.skyY - img.height;
    const off = ((game.skyX * speed) % img.width + img.width) % img.width;
    ctx.drawImage(img, -off, top);
    ctx.drawImage(img, img.width - off, top);
  };
  layer(art.far, 0.5, VIEW_H / 2 + 14);
  layer(art.near, 1, VIEW_H / 2 + 26);
  ctx.fillStyle = pal.near;
  ctx.fillRect(0, VIEW_H / 2 + 26 + game.skyY, VIEW_W, VIEW_H);
}

function drawWorld() {
  const pal = game.stage.pal;
  const { segs } = game.track;
  const p = player;
  const front = p.z + PLAYER_Z;
  const groundY = groundAt(front);
  const lift = Math.max(0, p.wy - groundY);
  const camY = groundY + CAM_H + lift * 0.55;
  const camX = p.x * ROAD_W;

  drawBackdrop(pal);

  const base = segAt(p.z);
  const basePct = (p.z - base.p1.world.z) / SEG_LEN;
  const playerIndex = segAt(front).index;
  let maxY = VIEW_H, x = 0, dx = -(base.curve * basePct);
  const last = Math.min(segs.length - 1, base.index + DRAW_DIST);

  for (let i = base.index; i <= last; i++) {
    const seg = segs[i];
    seg.clip = maxY;
    project(seg.p1, camX - x, camY, p.z);
    project(seg.p2, camX - x - dx, camY, p.z);
    x += dx;
    dx += seg.curve;
    const a = seg.p1, b = seg.p2;
    if (a.camera.z <= CAM_DEPTH || b.screen.y >= a.screen.y || b.screen.y >= maxY) continue;
    const d = (i - base.index) / DRAW_DIST;
    drawSegment(seg, pal, 1 - Math.exp(-d * d * 3.2));
    maxY = b.screen.y;
  }

  for (let i = last; i > base.index; i--) {
    const seg = segs[i];
    for (const item of seg.items) {
      if (!(item.taken && item.k === 'beacon')) drawItem(seg, item, i - base.index);
    }
    if (i === playerIndex && game.state !== 'title') drawPlayer(lift);
  }
}

function drawPlayer(lift) {
  const p = player;
  const rise = lift * 0.45 / CAM_H * VIEW_H / 2;
  const groundLine = VIEW_H - 10;
  const shadow = 52 * (1 - Math.min(0.5, rise / 160));
  ctx.fillStyle = 'rgba(0,0,0,.32)';
  ctx.beginPath();
  ctx.ellipse(VIEW_W / 2, groundLine, shadow, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (p.invuln > 0 && Math.floor(game.clock * 12) % 2) return;
  const bump = Math.abs(p.x) > 1.05 && !p.air && p.speed > 1000 ? Math.sin(game.clock * 50) * 2 : 0;
  drawRover(ctx, VIEW_W / 2, groundLine - rise + bump, {
    steer: p.steer, roll: p.roll, spin: p.spin, squash: p.squash, tread: p.tread, boost: p.boosting,
  });
}

function text(str, x, y, size, color = '#fff', align = 'left') {
  ctx.font = `bold ${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,.75)';
  ctx.fillText(str, x + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

function drawHud() {
  const p = player;
  const cx = VIEW_W / 2;
  const legsDone = game.track.segs.filter(s => s.checkpoint && s.p1.world.z < p.z + PLAYER_Z).length;
  text('SCORE', 12, 18, 12, '#ffd23c');
  text(String(game.score).padStart(7, '0'), 12, 36, 18);
  text('TIME', cx, 16, 12, '#ffd23c', 'center');
  const low = game.time < 10;
  text(String(Math.ceil(game.time)), cx, 46, 32, low && Math.floor(game.clock * 4) % 2 ? '#ff5a3c' : '#fff', 'center');
  text(game.stage.name, VIEW_W - 12, 18, 12, '#ffd23c', 'right');
  text(`LEG ${Math.min(game.stage.legs, legsDone + 1)}/${game.stage.legs}`, VIEW_W - 12, 36, 14, '#fff', 'right');

  // On touch screens the bottom of the view belongs to the buttons, so these readouts move to the top left.
  const hudY = touchMode ? 64 : VIEW_H - 14;
  text(`${Math.round(p.speed / MAX_SPEED * 160)}`, 12, hudY, 26);
  text('KM/H', 66, hudY, 11, '#ffd23c');

  const bx = touchMode ? 12 : VIEW_W - 112, by = touchMode ? 84 : hudY - 12;
  text('BOOST', bx, by - 5, 11, '#ffd23c');
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(bx, by, 100, 10);
  ctx.fillStyle = p.boosting ? '#fff' : '#ff8a3c';
  ctx.fillRect(bx + 1, by + 1, 98 * p.boost, 8);

  const mult = multiplier();
  if (p.chain > 0) {
    text(`CHAIN ${p.chain}`, VIEW_W - 12, 54, 12, '#ffd23c', 'right');
    if (mult > 1) text(`x${mult}`, VIEW_W - 12, 76, 20, '#ff9a3c', 'right');
  }

  for (const pop of game.popups) {
    ctx.globalAlpha = Math.min(1, pop.life * 2);
    text(pop.text, cx, VIEW_H - 110 - pop.y, 14, pop.color, 'center');
    ctx.globalAlpha = 1;
  }

  if (game.banner) {
    text(game.banner.text, cx, 100, 26, '#5ff0d8', 'center');
    if (game.banner.sub) text(game.banner.sub, cx, 122, 14, '#fff', 'center');
  }
}

function dim(alpha) {
  ctx.fillStyle = `rgba(8,5,14,${alpha})`;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
}

function drawTitle() {
  const cx = VIEW_W / 2;
  dim(0.45);
  text('MUDLARK', cx, 84, 54, '#ffd23c', 'center');
  text('RALLY', cx, 124, 36, '#5ff0d8', 'center');
  text(`< ${game.stage.name} >`, cx, 178, 20, '#fff', 'center');
  text(`COURSE ${game.menu + 1} OF ${STAGES.length}`, cx, 198, 12, '#ffd23c', 'center');
  const start = touchMode ? 'TAP BOOST TO START' : 'PRESS ENTER TO START';
  if (Math.floor(game.clock * 2) % 2 === 0) text(start, cx, 236, 16, '#fff', 'center');
  if (!touchMode) {
    text('LEFT / RIGHT  STEER      SPACE  BOOST', cx, 276, 12, '#e8e0d0', 'center');
    text('P  PAUSE      M  SOUND', cx, 294, 12, '#e8e0d0', 'center');
  }
  text('Beat the clock. Chain beacons. Ride the ramps.', cx, 318, 12, '#e8e0d0', 'center');
  if (game.best) text(`BEST ${game.best}`, cx, 344, 14, '#ffd23c', 'center');
}

function drawOverlay() {
  const cx = VIEW_W / 2;
  switch (game.state) {
    case 'ready': {
      const n = Math.ceil(game.countdown);
      text(game.stage.name, cx, 110, 24, '#ffd23c', 'center');
      text(String(n), cx, 170, 56, '#fff', 'center');
      break;
    }
    case 'clear':
      dim(0.35);
      text('COURSE CLEAR', cx, 130, 34, '#5ff0d8', 'center');
      text(`TIME BONUS ${game.clearBonus}`, cx, 168, 18, '#ffd23c', 'center');
      text(`SCORE ${game.score}`, cx, 194, 18, '#fff', 'center');
      break;
    case 'over':
      dim(0.5);
      text('OUT OF TIME', cx, 130, 38, '#ff5a3c', 'center');
      text(`SCORE ${game.score}`, cx, 172, 20, '#fff', 'center');
      if (game.newBest) text('NEW BEST!', cx, 198, 16, '#ffd23c', 'center');
      text(touchMode ? 'TAP BOOST' : 'PRESS ENTER', cx, 232, 14, '#e8e0d0', 'center');
      break;
    case 'won':
      dim(0.55);
      text('RALLY CHAMPION', cx, 126, 36, '#ffd23c', 'center');
      text('All four courses conquered', cx, 156, 14, '#fff', 'center');
      text(`FINAL SCORE ${game.score}`, cx, 188, 20, '#fff', 'center');
      if (game.newBest) text('NEW BEST!', cx, 212, 16, '#ffd23c', 'center');
      text(touchMode ? 'TAP BOOST' : 'PRESS ENTER', cx, 244, 14, '#e8e0d0', 'center');
      break;
  }
  if (game.paused) {
    dim(0.5);
    text('PAUSED', cx, VIEW_H / 2, 34, '#fff', 'center');
    text(touchMode ? 'TAP ANY BUTTON' : 'PRESS P', cx, VIEW_H / 2 + 24, 14, '#e8e0d0', 'center');
  }
  if (sound.muted) text('MUTED', VIEW_W - 12, VIEW_H - 36, 11, '#ff9a3c', 'right');
}

function render() {
  ctx.save();
  if (game.shake > 0) ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
  drawWorld();
  for (const p of game.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  if (game.state === 'title') drawTitle();
  else {
    drawHud();
    drawOverlay();
  }
}

// --- Input and main loop -------------------------------------------------------------------

function menuMove(dir) {
  game.menu = (game.menu + dir + STAGES.length) % STAGES.length;
  sound.tick();
  toTitle();
}

function confirmAction() {
  sound.unlock();
  switch (game.state) {
    case 'title':
      game.score = 0;
      game.newBest = false;
      startStage(game.menu);
      break;
    case 'clear':
      advanceStage();
      break;
    case 'over':
    case 'won':
      toTitle();
      break;
  }
}

function setPaused(paused) {
  game.paused = paused;
  sound.setPaused(paused);
}

function togglePause() {
  if (game.state === 'play' || game.state === 'ready') setPaused(!game.paused);
}

const KEYS = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'boost',
};

function actionDown(action) {
  input[action] = true;
  if (game.state === 'title' && action === 'left') menuMove(-1);
  else if (game.state === 'title' && action === 'right') menuMove(1);
  else if (action === 'boost' && game.state !== 'play' && game.state !== 'ready') confirmAction();
}

window.addEventListener('keydown', e => {
  const action = KEYS[e.code];
  if (action || e.code === 'Enter') e.preventDefault();
  if (e.repeat) return;
  sound.unlock();
  if (action) actionDown(action);
  else if (e.code === 'Enter') confirmAction();
  else if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  else if (e.code === 'KeyM') sound.toggleMute();
});

window.addEventListener('keyup', e => {
  const action = KEYS[e.code];
  if (action) input[action] = false;
});

window.addEventListener('blur', () => {
  for (const k of Object.keys(input)) input[k] = false;
  if (game.state === 'play') setPaused(true);
});

if (matchMedia('(pointer: coarse)').matches) {
  touchMode = true;
  document.body.classList.add('touch');
  for (const btn of document.querySelectorAll('#touch button')) {
    const action = btn.dataset.action;
    const release = () => { input[action] = false; btn.classList.remove('on'); };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      sound.unlock();
      if (game.paused) setPaused(false);
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('on');
      actionDown(action);
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
  }
}

let lastTime = 0, accumulator = 0;
function frame(now) {
  accumulator += Math.min(0.1, (now - lastTime) / 1000 || 0);
  lastTime = now;
  while (accumulator >= STEP) {
    if (!game.paused) update(STEP);
    accumulator -= STEP;
  }
  render();
  requestAnimationFrame(frame);
}

toTitle();
requestAnimationFrame(frame);

// Makes the game installable and playable offline. Unavailable when opened from a local file.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
