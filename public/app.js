// ============================================================
// 斗地主前端 · WebSocket 通信 + 局部更新
// ============================================================

const $ = (id) => document.getElementById(id);
const SUIT = ['♠', '♥', '♣', '♦'];

// 叫/抢地主状态展示文案（座位昵称下方）
const BID_LABEL = { call: '叫地主', grab: '抢地主', nocall: '不叫', nograb: '不抢' };

// 表情展示时长（毫秒），需与后端 EMOTE_TTL_MS 保持一致
const EMOTE_TTL_MS = 3500;

let playerId = '';
let roomId = '';
let selected = new Set();
let lastVersion = -1;
let prevPlaySig = '';
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let turnInfo = null;       // 当前轮次倒计时信息
let countdownTimer = null; // 倒计时定时器
let mySeat = -1;           // 我的座位号（倒计时定位用）
let lastState = null;      // 最近一次渲染用的完整状态（供事件委托读取 lastPlay/phase 等）
let handSig = '';          // 手牌签名，避免每轮询重建 DOM
let pendingReq = null;     // {requestId, roomId, name} 自己发起的待审批申请
let roomsTimer = null;     // 房间列表轮询
let joinStatusTimer = null; // 申请状态轮询
let lastPushAt = 0;          // 最近一次收到 SSE 推送的时间（判断 SSE 是否健康）
let pollTimer = null;       // 状态轮询兜底（隧道下 SSE 可能被缓冲/延迟）
let consecutiveBad = 0;     // 连续拉不到有效状态计数（判定已离开房间）
let joinGraceUntil = 0;      // 进房宽限期截止时间（冷启动/时序期间不判离场）

// ---- 工具 ----

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 1600);
}

async function post(route, body) {
  const r = await fetch('/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function get(route, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch('/api/' + route + qs);
  return r.json();
}

// 发送动作。只做一次网络往返（post），界面更新交给 800ms 轮询 + SSE 兜底，
// 这样点击“出牌/不出”只需等一次隧道往返，延迟减半、移动端更跟手。
async function act(route, body) {
  return await post(route, body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- 表情栏（玩家发送表情）----
function buildEmoteBar(el) {
  if (!el) return;
  el.innerHTML = '';
  Object.keys(EMOTES).forEach(id => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-btn';
    b.dataset.emote = id;
    b.title = EMOTES[id].t;
    b.textContent = EMOTES[id].e;
    b.onclick = () => sendEmote(id);
    el.appendChild(b);
  });
}
function sendEmote(id) {
  if (!playerId || !roomId) return;
  post('emote', { roomId, playerId, emoteId: id }).catch(() => {});
}

// 表情气泡更新：按 TTL 判断是否可见；仅在 at 变化时重新触发动画，避免每次轮询重播
function updateEmoteBubble(el, emote) {
  if (!el) return;
  const active = emote && (Date.now() - emote.at < EMOTE_TTL_MS);
  if (active) {
    if (el._at !== emote.at) {
      el.textContent = (EMOTES[emote.id] ? EMOTES[emote.id].e : '😊');
      el.classList.remove('show');
      void el.offsetWidth; // 强制重排以重启动画
      el.classList.add('show');
      el._at = emote.at;
    }
  } else if (el._at !== null && el._at !== undefined) {
    el.classList.remove('show');
    el._at = null;
  }
}

// ---- SSE 连接 ----

function connectWS() {
  if (!playerId || !roomId) return;
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }

  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = proto + location.host + '/ws?roomId=' + encodeURIComponent(roomId) + '&playerId=' + playerId;
  ws = new WebSocket(url);

  ws.onmessage = (e) => {
    try {
      const st = JSON.parse(e.data);
      lastPushAt = Date.now();
      $('netbar').classList.add('hide');
      reconnectDelay = 1000;
      render(st);
    } catch (err) {
      console.warn('WS parse error', err);
    }
  };

  ws.onclose = () => {
    // 断线 → 自动重连；HTTP 轮询兜底保证界面可用
    $('netbar').classList.remove('hide');
    ws = null;
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      connectWS();
    }, reconnectDelay);
  };

  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

// ---- 状态轮询兜底（隧道下 SSE 可能被缓冲/延迟，用 HTTP 拉状态保证可用）----
// 500ms 轮询：对手出牌也能在 ~0.5s 内显示；动作只发一次往返，界面很快刷新。
function startStatePolling() {
  stopStatePolling();
  pollTimer = setInterval(pollState, 500);
  pollState();
}
function stopStatePolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
async function pollState() {
  if (!playerId || !roomId) return;
  if (lastPushAt && Date.now() - lastPushAt < 600) return; // WS 刚推送过，跳过一次避免重复渲染
  // 仅“刚加入的 6 秒宽限”内容忍暂时拿不到身份（DO 冷启动/首屏时序保险）；
  // 宽限过后仍 mySeat<0 = 确实不在房间（如本机存了过期会话/被移除）→ 退回大厅重进，避免永久假死。
  const inGrace = Date.now() < joinGraceUntil;
  try {
    const st = await get('state', { roomId, playerId });
    if (st && st.mySeat >= 0) {
      consecutiveBad = 0;
      $('netbar').classList.add('hide');
      render(st);
    } else if (!inGrace && ++consecutiveBad >= 2) {
      stopStatePolling();
      showJoinForm('你已不在该房间，请重新加入');
    }
  } catch (e) {
    if (!inGrace && ++consecutiveBad >= 2) { stopStatePolling(); showJoinForm('连接已断开，请重新加入'); }
  }
}

// ---- 卡片 DOM 缓存（局部更新核心） ----

const cardCache = new Map(); // cid -> cardEl

function cardEl(c, mini) {
  const cached = cardCache.get(c.id);
  if (cached) {
    // 更新可能变化的类名
    const isJoker = c.v >= 16;
    const red = isJoker ? (c.v === 17) : (c.suit === 1 || c.suit === 3);
    cached.className = 'card' + (mini ? ' mini' : '') + (isJoker ? ' jk' : '') + (red ? ' red' : '');
    return cached;
  }

  const d = document.createElement('div');
  const isJoker = c.v >= 16;
  const red = isJoker ? (c.v === 17) : (c.suit === 1 || c.suit === 3);
  d.className = 'card' + (mini ? ' mini' : '') + (isJoker ? ' jk' : '') + (red ? ' red' : '');
  if (isJoker) {
    d.innerHTML = '<span class="v">' + (c.v === 17 ? '大王' : '小王') + '</span>';
  } else {
    d.innerHTML = '<span class="v">' + c.label + '</span><span class="s">' + SUIT[c.suit] + '</span>';
  }
  d.dataset.cid = c.id;
  cardCache.set(c.id, d);
  return d;
}

// 新建一张牌节点（不进 cardCache）：供底牌/出牌区/亮牌区使用，
// 避免与手牌区因同一 card id 共享同一 DOM 节点而被互相“拽走”导致闪烁。
function freshCardEl(c, mini) {
  const isJoker = c.v >= 16;
  const red = isJoker ? (c.v === 17) : (c.suit === 1 || c.suit === 3);
  const d = document.createElement('div');
  d.className = 'card' + (mini ? ' mini' : '') + (isJoker ? ' jk' : '') + (red ? ' red' : '');
  if (isJoker) {
    d.innerHTML = '<span class="v">' + (c.v === 17 ? '大王' : '小王') + '</span>';
  } else {
    d.innerHTML = '<span class="v">' + c.label + '</span><span class="s">' + SUIT[c.suit] + '</span>';
  }
  return d;
}
function makeCardBack() {
  const d = document.createElement('div');
  d.className = 'backcard';
  return d;
}

// ---- 渲染 ----

let lastRoundNo = -1;          // 上一局局号，用于换局时清空残留选牌
let lastBottomSig = '';        // 底牌签名，静止重建避免闪烁

function render(st) {
  if (st.mySeat < 0) return;

  const inGame = st.phase !== 'lobby';
  $('lobby').classList.toggle('hide', inGame);
  $('game').classList.toggle('hide', !inGame);

  if (!inGame) {
    $('banner').classList.add('hide');
    updateEmoteBubble($('myEmoteBubble'), null);
    $('lobbyMsg').textContent = st.message;
    $('roundInfo').innerHTML =
      '本轮共 <b style="color:var(--gold)">' + st.totalRounds + '</b> 局' +
      (st.mySeat === 0 ? ' · <a href="#" id="chgRounds" style="color:#fff">修改</a>' : '');
    const cr = $('chgRounds');
    if (cr) cr.onclick = (e) => {
      e.preventDefault();
      const n = prompt('设置本轮局数（1-20）：', st.totalRounds);
      if (n) post('setrounds', { roomId, playerId, rounds: +n });
    };
    const list = st.seats.filter(Boolean).map(s => {
      const meMark = s.seat === st.mySeat ? ' （你）' : '';
      const rdy = s.ready ? '<span class="rdy">已准备✓</span>' : '';
      const em = (s.emote && (Date.now() - s.emote.at < EMOTE_TTL_MS))
        ? ' <span class="em-sp">' + (EMOTES[s.emote.id] ? EMOTES[s.emote.id].e : '😊') + '</span>' : '';
      return '<div style="padding:4px 0">座位' + s.seat + '：' + s.name + meMark + (s.isBot ? '（机器人）' : '') + rdy + em + '</div>';
    }).join('');
    $('seatList').innerHTML = list;
    const rc = $('readyCount');
    rc.innerHTML = '准备人数：<b>' + (st.readyCount || 0) + '</b>/3 · 共 ' + st.playerCount + '/3 人';
    rc.classList.toggle('full', (st.readyCount || 0) >= 3);
    $('readyBtn').textContent = st.myReady ? '取消准备' : '准备';
    renderHostRequests(st);
    return;
  }

  lastVersion = st.version;
  mySeat = st.mySeat;
  lastState = st;

  // 展示赢家最后一手阶段（showwin）：先不显示任何人的手牌，专注看最后一手
  const suppressHand = st.phase === 'showwin';
  if (suppressHand) $('myhand').classList.add('hide');
  else $('myhand').classList.remove('hide');

  // 换局或离开对局阶段时，清空上一局残留的选牌
  // （同一副牌 card id 是确定性的，新一局若不清空，旧 id 仍会“预选中”导致误报“不是合法牌型”）
  if (st.roundNo !== lastRoundNo) { selected.clear(); lastRoundNo = st.roundNo; }
  if (st.phase !== 'playing') selected.clear();

  const myInfo = st.seats[st.mySeat] || {};
  const multTag = (st.landlordSeat >= 0 && st.callMult > 1)
    ? ' · <span class="mytotal">倍数 <b>\u00d7' + st.callMult + '</b></span>' : '';
  const roundTag = st.roundNo > 0
    ? ' · <span class="mytotal">第 <b>' + st.roundNo + '/' + st.totalRounds + '</b> 局</span>' : '';
  $('roomTag').innerHTML =
    '房间 ' + st.roomId + roundTag + ' · <span class="mytotal">积分 <b>' + fmtScore(myInfo.score || 0) + '</b></span>' + multTag;
  $('gameMsg').textContent = st.message;

  renderSeats(st);
  updateEmoteBubble($('myEmoteBubble'), st.seats[st.mySeat] ? st.seats[st.mySeat].emote : null);
  renderBottom(st);
  renderPlayed(st);
  renderBidding(st);
  renderMyMeta(st);
  // 手牌只在“牌本身变化”时重建 DOM（showwin 阶段隐藏，先专注最后一手）
  if (!suppressHand) {
    const newHandSig = (st.myHand || []).map(c => c.id).join(',');
    if (newHandSig !== handSig) { renderMyHand(st); handSig = newHandSig; }
  }
  renderActions(st);
  updateTurnTimer(st);

  if (st.phase === 'finished') showBanner(st);
  else $('banner').classList.add('hide');
}

// ---- 出牌倒计时 ----

function updateTurnTimer(st) {
  const turnSeat = st.phase === 'bidding' ? st.bidSeat
    : (st.phase === 'playing' ? st.curSeat : -1);
  if (turnSeat < 0 || !st.turnStartAt) {
    turnInfo = null;
    clearTimerEls();
    setMyTimer(null);
    return;
  }
  const info = st.seats[turnSeat];
  const isBot = !!(info && info.isBot);
  turnInfo = { seat: turnSeat, startAt: st.turnStartAt, ms: st.turnMs, isBot };
  if (!countdownTimer) countdownTimer = setInterval(tickTimer, 200);
  tickTimer();
}

function tickTimer() {
  if (!turnInfo) return;
  const remain = Math.max(0, turnInfo.ms - (Date.now() - turnInfo.startAt));
  const secs = Math.ceil(remain / 1000);
  const urgent = remain <= 5000 && remain > 0;
  const mine = (mySeat >= 0 && turnInfo.seat === mySeat && !turnInfo.isBot);

  // 对手座位倒计时（在各自头像卡内显示）
  document.querySelectorAll('.seat-timer').forEach(el => {
    const seatDiv = el.closest('.seat');
    if (!seatDiv || !seatDiv.classList.contains('active')) {
      el.textContent = ''; el.classList.remove('urgent'); return;
    }
    if (turnInfo.isBot) {
      el.textContent = '思考中'; el.classList.remove('urgent');
    } else {
      el.textContent = '剩 ' + secs + 's';
      el.classList.toggle('urgent', urgent);
    }
  });

  // 自己的倒计时：醒目数字 + 进度条，最后 5 秒变红脉冲
  if (mine) setMyTimer(secs, remain, turnInfo.ms, urgent);
  else setMyTimer(null);
}

function setMyTimer(secs, remain, ms, urgent) {
  const box = $('myTimer');
  if (!box) return;
  if (secs === null) { box.classList.add('hide'); return; }
  box.classList.remove('hide');
  $('myTimerNum').textContent = '出牌倒计时 ' + secs + 's';
  const fill = $('myTimerFill');
  if (fill) {
    const pct = Math.max(0, Math.min(100, (remain / ms) * 100));
    fill.style.width = pct + '%';
  }
  box.classList.toggle('urgent', !!urgent);
}

function clearTimerEls() {
  document.querySelectorAll('.seat-timer').forEach(el => { el.textContent = ''; el.classList.remove('urgent'); });
}

// ---- 座位渲染（局部更新） ----

function renderSeats(st) {
  const box = $('seats');
  const revealing = st.phase === 'reveal' || st.phase === 'finished';
  const order = [(st.mySeat + 1) % 3, (st.mySeat + 2) % 3];

  for (let idx = 0; idx < order.length; idx++) {
    const s = order[idx];
    const info = st.seats[s];
    const div = box.children[idx] || document.createElement('div');
    if (!div.parentNode) box.appendChild(div);
    div.dataset.seat = s;

    if (!info) {            // 防御：座位数据缺失时清空该格，避免抛异常卡死整页
      div.className = 'seat';
      div.innerHTML = '';
      div.dataset.hc = '';
      div.dataset.built = '';
      continue;
    }
    div.className = 'seat' +
      (((st.phase === 'playing' && st.curSeat === s) || (st.phase === 'bidding' && st.bidSeat === s)) ? ' active' : '');

    let role = info.isLandlord ? '<span class="crown">地主</span>' : (st.landlordSeat >= 0 ? '农民' : '');
    if (st.phase === 'bidding' && info.isCaller && st.bidRound === 'grab') role = '已叫地主';
    let conn = '';
    if (info.connected === false && !info.isBot) {
      conn = info.hosting ? ' <span class="offtag">托管中</span>' : ' <span class="offtag">掉线</span>';
    }

    // 结构只建一次（首建/上一局残留），后续只更新文本与背面牌堆，避免每 500ms 轮询整块重建导致闪烁
    if (!div.dataset.built) {
      div.innerHTML = '<div class="nm"></div><div class="bidtag"></div><div class="role"></div>' +
        '<div class="seat-timer"></div><div class="backcards"></div><div class="cnt"></div>' +
        '<div class="emote-bubble"></div>';
      div.dataset.built = '1';
      div.dataset.hc = '';
    }
    div.querySelector('.nm').innerHTML = info.name +
      ' <span class="sc">' + fmtScore(info.score || 0) + '</span>' + conn;

    // 叫/抢地主状态：仅叫地主阶段，在昵称下方显示该玩家是否已叫/抢/不叫
    const bt = div.querySelector('.bidtag');
    if (st.phase === 'bidding' && info.bidAction) {
      bt.textContent = BID_LABEL[info.bidAction] || '';
      bt.className = 'bidtag show b-' + info.bidAction;
    } else {
      bt.textContent = '';
      bt.className = 'bidtag';
    }

    div.querySelector('.role').innerHTML = role;

    // 该座位表情气泡（其余玩家）
    updateEmoteBubble(div.querySelector('.emote-bubble'), info.emote);

    if (revealing && info.hand) {
      const hd = document.createElement('div');
      hd.className = 'revealhand';
      if (info.hand.length === 0) {
        hd.innerHTML = '<span style="font-size:.75rem;opacity:.85">已出完</span>';
      } else {
        info.hand.forEach(c => hd.appendChild(freshCardEl(c, true)));
      }
      const bc = div.querySelector('.backcards');
      bc.innerHTML = '';
      bc.appendChild(hd);
      div.querySelector('.cnt').textContent = info.hand.length + ' 张';
      div.dataset.hc = String(info.hand.length);
    } else {
      // 手牌数变化时才重建背面牌堆（背面牌本身无状态，没必要每轮询重绘 → 计数不闪）
      const hc = info.handCount;
      if (div.dataset.hc !== String(hc)) {
        const bc = div.querySelector('.backcards');
        bc.innerHTML = '';
        for (let i = 0; i < Math.min(hc, 20); i++) bc.appendChild(makeCardBack());
        div.querySelector('.cnt').textContent = hc + ' 张';
        div.dataset.hc = String(hc);
      }
    }
  }
}

// ---- 底牌 ----

function renderBottom(st) {
  if (st.bottom && st.bottom.length && st.landlordSeat >= 0) {
    const sig = st.bottom.map(c => c.id).join(',');
    if (sig === lastBottomSig) return;     // 底牌内容不变 → 跳过重建（杜绝闪烁）
    lastBottomSig = sig;
    const bb = $('bottomBox');
    bb.innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '底牌';
    bb.appendChild(tag);
    st.bottom.forEach(c => bb.appendChild(freshCardEl(c, true)));
  } else if (lastBottomSig !== '') {
    lastBottomSig = '';
    $('bottomBox').innerHTML = '';
  }
}

// ---- 出牌区 ----

function renderPlayed(st) {
  const pb = $('playedBox');
  pb.innerHTML = '';

  // 先单独展示赢家最后一手几秒（showwin 阶段）
  if (st.phase === 'showwin') {
    if (st.lastPlay) {
      const who = st.seats[st.lastPlay.seat];
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = (who ? who.name : '') + ' 出完了！';
      pb.appendChild(lbl);
      st.lastPlay.cards.forEach(c => pb.appendChild(freshCardEl(c, true)));
    }
    const tip = document.createElement('div');
    tip.className = 'reveal-tip';
    tip.textContent = '稍后亮牌，查看各家余牌…';
    pb.appendChild(tip);
    return;
  }

  const revealing = st.phase === 'reveal' || st.phase === 'finished';
  if (revealing) {
    const tip = document.createElement('div');
    tip.className = 'reveal-tip';
    tip.textContent = st.phase === 'reveal' ? '亮牌！查看各家余牌，即将结算…' : '本局结束';
    pb.appendChild(tip);
    if (st.lastPlay) {
      const who = st.seats[st.lastPlay.seat];
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = (who ? who.name : '') + ' 的最后一手：';
      pb.appendChild(lbl);
      st.lastPlay.cards.forEach(c => pb.appendChild(freshCardEl(c, true)));
    }
    return;
  }

  if (st.lastPlay) {
    const who = st.seats[st.lastPlay.seat];
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = (who ? who.name : '') + ' 出：';
    pb.appendChild(lbl);
    st.lastPlay.cards.forEach(c => pb.appendChild(freshCardEl(c, true)));

    const sig = st.lastPlay.seat + '|' + st.lastPlay.cards.map(c => c.id).join(',');
    if (sig !== prevPlaySig) {
      animatePlay(st.lastPlay.seat, st.mySeat, pb);
    }
    prevPlaySig = sig;
  } else if (st.phase === 'playing') {
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = (st.curSeat === st.mySeat ? '轮到你领出' : '等待对方领出');
    pb.appendChild(lbl);
    prevPlaySig = '';
  }
}

// ---- 叫地主 ----

function renderBidding(st) {
  const bidBox = $('bidBox');
  if (st.phase === 'bidding' && st.bidSeat === st.mySeat) {
    bidBox.classList.remove('hide');
    if (st.bidRound === 'call') {
      bidBox.innerHTML =
        '<button class="btn sm" data-bid="call">叫地主</button>' +
        '<button class="btn ghost sm" data-bid="pass">不叫</button>';
    } else {
      bidBox.innerHTML =
        '<button class="btn sm" data-bid="grab">抢地主（当前倍数 ' + st.callMult + '）</button>' +
        '<button class="btn ghost sm" data-bid="nograb">不抢</button>';
    }
  } else {
    bidBox.classList.add('hide');
  }
}

// ---- 我的身份 ----

function renderMyMeta(st) {
  const mm = $('myMeta');
  const revealing = st.phase === 'reveal' || st.phase === 'finished';
  const myInfo = st.seats[st.mySeat] || {};
  if (st.phase === 'playing' || revealing) {
    let myrole = myInfo.isLandlord ? '<span class="crown">地主</span>' : (st.landlordSeat >= 0 ? '农民' : '');
    mm.innerHTML = '<span class="badge">' + (myrole ? myrole + ' · ' : '') +
      '我的手牌 <span class="cn">' + (st.myHand ? st.myHand.length : 0) + '</span> 张</span>';
  } else if (st.phase === 'bidding' && myInfo.bidAction) {
    // 叫地主阶段：在自己的信息条显示我是否叫/抢/不叫
    mm.innerHTML = '<span class="badge bid-badge b-' + myInfo.bidAction + '">' + BID_LABEL[myInfo.bidAction] + '</span>';
  } else if (st.phase === 'showwin') {
    mm.innerHTML = '<span class="badge">本局结束，等待亮牌…</span>';
  } else {
    mm.innerHTML = '';
  }
}

// ---- 我的手牌（局部更新：复用已有 DOM） ----

function renderMyHand(st) {
  const h = $('myhand');
  const cards = st.myHand || [];

  // 移除不存在的旧元素（同时剔除已不在手牌中的残留选中，避免误报非法牌型）
  const currentIds = new Set(cards.map(c => c.id));
  for (const id of [...selected]) if (!currentIds.has(id)) selected.delete(id);
  for (const child of [...h.children]) {
    if (!currentIds.has(child.dataset.cid)) {
      cardCache.delete(child.dataset.cid);
      child.remove();
    }
  }

  // 确保顺序正确
  const existing = new Map();
  for (const child of [...h.children]) {
    existing.set(child.dataset.cid, child);
  }

  // 重建子元素顺序
  h.innerHTML = '';
  cards.forEach(c => {
    const el = cardEl(c, false);
    if (selected.has(c.id)) el.classList.add('sel');
    h.appendChild(el);
  });
}

// ---- 操作按钮 ----

function renderActions(st) {
  const act = $('actions');
  if (st.phase === 'playing' && st.curSeat === st.mySeat) {
    const canPass = !!st.lastPlay; // 领出方(lastPlay 为空)不能不出，必须出牌
    act.innerHTML =
      '<button class="btn sm" data-act="play">出牌</button>' +
      '<button class="btn ghost sm' + (canPass ? '' : ' dim') + '" data-act="pass">' +
        (canPass ? '不出' : '不出（领出须出牌）') + '</button>' +
      '<button class="btn ghost sm" data-act="clear">清空选择</button>';
  } else {
    act.innerHTML = '';
  }
}

// 事件委托：容器不会被 innerHTML 重建，点击绝不会被“正在重渲染”吞掉。
$('actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const kind = btn.dataset.act;
  if (kind === 'clear') { selected.clear(); if (lastState) renderMyHand(lastState); return; }
  if (kind === 'pass') {
    if (!lastState || !lastState.lastPlay) { toast('你是领出方，必须出牌'); return; }
    btn.disabled = true;
    const r = await act('pass', { roomId, playerId });
    if (r.err) { toast(r.err); btn.disabled = false; } else selected.clear();
    return;
  }
  if (kind === 'play') {
    const ids = [...selected];
    if (!ids.length) { toast('先选牌'); return; }
    btn.disabled = true;
    const r = await act('play', { roomId, playerId, cardIds: ids });
    if (r.err) { toast(r.err); btn.disabled = false; } else selected.clear();
  }
});

// 叫地主：同样用事件委托，避免每轮询重建按钮吞掉点击
$('bidBox').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-bid]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const r = await act('bid', { roomId, playerId, action: btn.dataset.bid });
  if (r.err) toast(r.err);
});

// ---- 结算弹窗 ----

function fmtScore(n) { n = n || 0; return (n > 0 ? '+' : '') + n; }

function readyCountHtml(st) {
  const full = (st.readyCount || 0) >= 3 ? ' full' : '';
  return '<div class="readycount' + full + '">准备人数：<b>' + (st.readyCount || 0) + '</b>/3</div>';
}
function onReadyNext() {
  post('ready', { roomId, playerId });
}

function showBanner(st) {
  $('banner').classList.remove('hide');
  const iWin = (st.winnerSide === 'landlord' && st.mySeat === st.landlordSeat) ||
               (st.winnerSide === 'peasant' && st.mySeat !== st.landlordSeat);
  const r = st.result;

  if (st.matchOver) {
    const ranked = [...st.seats.filter(Boolean)].sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = ranked[0];
    const iTop = top && top.seat === st.mySeat;
    $('bannerBig').innerHTML = iTop ? '<span class="win">你是大赢家！</span>' : '本轮结束';

    let html = '<b>' + st.totalRounds + ' 局最终排名</b><div class="scoretab">';
    ranked.forEach((s, i) => {
      const medal = ['第1名', '第2名', '第3名'][i] || '';
      html += '<div class="scorerow"><span>' + medal + ' ' + s.name + (s.seat === st.mySeat ? '（你）' : '') + '</span>' +
              '<span class="' + ((s.score || 0) >= 0 ? 'plus' : 'minus') + '">' + fmtScore(s.score || 0) + '</span></div>';
    });
    html += '</div>';
    html += '<div style="opacity:.6;font-size:.8rem;margin-top:8px">末局：' + (st.winnerSide === 'landlord' ? '地主获胜' : '农民获胜') + '</div>';
    $('bannerSub').innerHTML = html + readyCountHtml(st);
    setBannerBtn(st.myReady ? '已准备 ✓' : '准备新一轮', onReadyNext);
    return;
  }

  $('bannerBig').innerHTML = (iWin ? '<span class="win">你赢了！</span>' : '你输了') +
    ' <span style="font-size:.9rem;opacity:.7">第 ' + st.roundNo + '/' + st.totalRounds + ' 局</span>';

  let html = (st.winnerSide === 'landlord' ? '地主获胜' : '农民获胜');
  if (r) {
    const parts = [];
    if (r.callMult > 1) parts.push('叫抢\u00d7' + r.callMult);
    if (r.bombCount) parts.push(r.bombCount + '炸\u00d7' + Math.pow(2, r.bombCount));
    if (r.spring) parts.push('春天\u00d72');
    if (r.antiSpring) parts.push('反春天\u00d72');
    html += ' · 底分 ' + r.base + ' \u00d7 总倍数 ' + r.multiplier + (parts.length ? '（' + parts.join(' · ') + '）' : '');
    html += '<div class="scoretab">';
    st.seats.filter(Boolean).forEach(s => {
      const d = (r.deltas[s.seat] !== undefined) ? r.deltas[s.seat] : 0;
      html += '<div class="scorerow"><span>' + s.name + (s.seat === st.mySeat ? '（你）' : '') + (s.isLandlord ? ' ' : '') + '</span>' +
              '<span class="' + (d >= 0 ? 'plus' : 'minus') + '">' + fmtScore(d) + '</span>' +
              '<span class="tot">总 ' + (s.score || 0) + '</span></div>';
    });
    html += '</div>';
  }
  $('bannerSub').innerHTML = html + readyCountHtml(st);
  setBannerBtn(st.myReady ? '已准备 ✓' : '准备下一局', onReadyNext);
}

function setBannerBtn(txt, fn) {
  const b = $('againBtn');
  b.textContent = txt;
  b.onclick = fn;
}

// ---- 飞牌动效 ----

function animatePlay(seat, mySeat, playedBox) {
  const cardEls = [...playedBox.querySelectorAll('.card')];
  if (!cardEls.length) return;
  let sx, sy;
  if (seat === mySeat) {
    sx = window.innerWidth / 2;
    sy = window.innerHeight + 80;
  } else {
    const srcEl = document.querySelector('.seat[data-seat="' + seat + '"]');
    if (!srcEl) return;
    const r = srcEl.getBoundingClientRect();
    sx = r.left + r.width / 2;
    sy = r.top + r.height / 2;
  }
  playedBox.style.visibility = 'hidden';
  const clones = [];
  cardEls.forEach((el, i) => {
    const t = el.getBoundingClientRect();
    const c = el.cloneNode(true);
    c.className += ' fly-card';
    c.style.cssText = 'position:fixed;margin:0;z-index:60;' +
      'left:' + t.left + 'px;top:' + t.top + 'px;' +
      'width:' + t.width + 'px;height:' + t.height + 'px;' +
      'transition:transform .42s cubic-bezier(.2,.9,.25,1.15), opacity .3s;';
    const dx = sx - (t.left + t.width / 2);
    const dy = sy - (t.top + t.height / 2);
    c.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.35) rotate(' + ((i - cardEls.length / 2) * 7) + 'deg)';
    c.style.opacity = '0';
    document.body.appendChild(c);
    clones.push(c);
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clones.forEach(c => { c.style.transform = 'translate(0,0) scale(1) rotate(0)'; c.style.opacity = '1'; });
  }));
  setTimeout(() => {
    clones.forEach(c => c.remove());
    playedBox.style.visibility = 'visible';
  }, 460);
}

// ---- 拖动选牌 ----

function toggleSel(id, el) {
  if (selected.has(id)) { selected.delete(id); if (el) el.classList.remove('sel'); }
  else { selected.add(id); if (el) el.classList.add('sel'); }
}

// 选牌：用事件委托挂在容器上（容器不会被 innerHTML 重建，所以不会吞点击）。
// 点击/轻触一张牌即选中或取消，桌面与移动端一致；横向滑动交给浏览器滚动看牌。
(function setupHandSelect() {
  const hand = $('myhand');
  hand.addEventListener('click', e => {
    const el = e.target.closest('.card');
    if (el && el.dataset.cid) toggleSel(el.dataset.cid, el);
  });
})();

// ---- 局数选择器 ----

let chosenRounds = 3;
$('roundSel').addEventListener('click', e => {
  const b = e.target.closest('button[data-r]');
  if (!b) return;
  chosenRounds = +b.dataset.r;
  [...$('roundSel').children].forEach(x => x.classList.toggle('on', x === b));
});

// ---- 加入 ----

$('joinBtn').onclick = async () => {
  const name = $('name').value.trim() || '玩家';
  roomId = ($('room').value.trim() || 'default');
  const res = await post('join', { roomId, name, playerId, rounds: chosenRounds });
  if (res.err) { toast(res.err); return; }
  enterRoom(res.playerId, res.roomId);
};

// 进入房间（直接进房 / 申请通过后通用）
function enterRoom(pid, rid) {
  playerId = pid;
  roomId = rid;
  localStorage.setItem('ddz_pid', playerId);
  localStorage.setItem('ddz_room', roomId);
  stopRoomsPolling();
  lastRoundNo = -1;        // 重置：进入新房间首帧强制清残留选牌 + 重画底牌
  lastBottomSig = '';
  consecutiveBad = 0;
  lastPushAt = 0;
  joinGraceUntil = Date.now() + 6000; // 进房后 6 秒内不判“已离开房间”，规避 DO 冷启动/首屏时序误踢
  $('lobbyInfo').classList.remove('hide');
  updateLobbyChrome();
  startStatePolling(); // 立即拉一次状态 + 每 2s 兜底（隧道下 SSE 可能延迟）
  connectWS();        // 实时更新
}

// 退回大厅表单（清空凭据、显示输入框、刷新房间列表）
function showJoinForm(msg) {
  $('confirmModal') && $('confirmModal').classList.add('hide');
  clearTimeout(reconnectTimer);
  stopStatePolling();
  if (ws) { ws.close(); ws = null; }
  // 尽力通知服务器移除自己，避免房间残留“幽灵玩家”导致无法开局
  if (playerId && roomId) {
    const rid = roomId, pid = playerId;
    post('leave', { roomId: rid, playerId: pid }).catch(() => {});
  }
  playerId = '';
  roomId = '';
  localStorage.removeItem('ddz_pid');
  localStorage.removeItem('ddz_room');
  pendingReq = null;
  stopJoinStatusPolling();
  $('lobbyInfo').classList.add('hide');
  $('reqBox').classList.add('hide');
  $('myTimer') && $('myTimer').classList.add('hide');
  $('game').classList.add('hide');   // 关键：退回大厅时必须隐藏牌桌，否则看起来像“退出”无效
  $('lobby').classList.remove('hide');
  updateLobbyChrome();
  startRoomsPolling();
  if (msg) toast(msg);
}

$('readyBtn').onclick = () => post('ready', { roomId, playerId });
$('botBtn').onclick = async () => {
  const r = await post('addbot', { roomId, playerId });
  if (r.err) toast(r.err);
};
$('exitLobbyBtn').onclick = async () => {
  if (ws) { ws.close(); ws = null; }
  if (playerId) { try { await post('leave', { roomId, playerId }); } catch (e) {} }
  showJoinForm();
};
$('leaveBtn').onclick = () => {
  $('confirmModal').classList.remove('hide'); // 先弹确认框，避免误触退出
};
$('confirmCancel').onclick = () => {
  $('confirmModal').classList.add('hide');
};
$('confirmYes').onclick = () => {
  $('confirmModal').classList.add('hide');
  showJoinForm(); // 统一走退回大厅逻辑：关 WS、通知服务器移除自己、隐藏牌桌
};

// ---- 大厅房间浏览 + 加入申请 ----

function updateLobbyChrome() {
  const inRoom = !!playerId;
  $('joinCard').classList.toggle('hide', inRoom);
  $('roomsBrowser').classList.toggle('hide', inRoom);
  if (inRoom) return;
  // 未进房：根据是否等待审批切换「房间列表 / 等待条」
  $('roomsList').classList.toggle('hide', !!pendingReq);
  $('reqWaiting').classList.toggle('hide', !pendingReq);
}

function startRoomsPolling() {
  stopRoomsPolling();
  roomsTimer = setInterval(loadRooms, 3000);
  loadRooms();
}
function stopRoomsPolling() {
  if (roomsTimer) { clearInterval(roomsTimer); roomsTimer = null; }
}

async function loadRooms() {
  if (playerId || pendingReq) return; // 已进房或等待审批中，不刷新
  try {
    const data = await get('rooms');
    renderRooms(data.rooms || []);
  } catch (e) { /* 网络抖动忽略 */ }
}

function renderRooms(rooms) {
  const list = $('roomsList');
  if (!rooms.length) {
    list.innerHTML = '<div class="room-empty">暂无进行中的房间或空闲大厅。下方直接创建 / 进入一个房间，或稍后再来看看～</div>';
    return;
  }
  list.innerHTML = '';
  const phaseText = { lobby: '空闲大厅', bidding: '叫地主中', playing: '对局进行中', reveal: '亮牌中' };
  rooms.forEach(rm => {
    const card = document.createElement('div');
    card.className = 'room-card';
    let tagClass = 'room-tag', tagText = phaseText[rm.phase] || rm.phase;
    if (rm.phase === 'lobby') { tagClass += ' open'; tagText = '可加入'; }
    else { tagClass += ' progress'; tagText = '进行中'; }
    if (rm.isFull) { tagClass = 'room-tag full'; tagText = '已满员'; }
    const sub = '房主 <span class="rc-host">' + escapeHtml(rm.hostName) + '</span> · ' + rm.playerCount + '/' + rm.capacity + ' 人';
    card.innerHTML =
      '<div class="rc-main">' +
        '<div class="rc-id">房间 ' + escapeHtml(String(rm.roomId)) + '</div>' +
        '<div class="rc-sub">' + sub + '</div>' +
      '</div>' +
      '<span class="' + tagClass + '">' + tagText + '</span>';
    if (rm.canJoin && !rm.isFull) {
      const btn = document.createElement('button');
      btn.className = 'btn sm';
      btn.textContent = '申请加入';
      btn.onclick = () => onApplyClick(rm.roomId);
      card.appendChild(btn);
    }
    list.appendChild(card);
  });
}

async function onApplyClick(roomId) {
  let name = $('name').value.trim();
  if (!name) name = prompt('输入你的昵称（申请加入房间 ' + roomId + '）：', '') || '';
  name = name.trim();
  if (!name) return;
  const r = await post('join-request', { roomId, name });
  if (r.err) { toast(r.err); return; }
  pendingReq = { requestId: r.requestId, roomId, name };
  $('reqWaiting').innerHTML =
    '<div class="rw-text">已向房间 <b>' + escapeHtml(roomId) + '</b> 发起申请（昵称：' +
    escapeHtml(name) + '），等待房主通过…</div>' +
    '<button class="btn ghost sm" id="cancelReqBtn">取消</button>';
  $('cancelReqBtn').onclick = cancelRequest;
  updateLobbyChrome();
  startJoinStatusPolling();
}

async function cancelRequest() {
  if (pendingReq) {
    try { await post('join-cancel', { roomId: pendingReq.roomId, requestId: pendingReq.requestId }); } catch (e) {}
  }
  stopJoinStatusPolling();
  pendingReq = null;
  updateLobbyChrome();
  loadRooms();
}

function startJoinStatusPolling() {
  stopJoinStatusPolling();
  joinStatusTimer = setInterval(pollJoinStatus, 1500);
  pollJoinStatus();
}
function stopJoinStatusPolling() {
  if (joinStatusTimer) { clearInterval(joinStatusTimer); joinStatusTimer = null; }
}
async function pollJoinStatus() {
  if (!pendingReq) return;
  let r;
  try { r = await get('join-status', { roomId: pendingReq.roomId, requestId: pendingReq.requestId }); }
  catch (e) { return; }
  if (r.status === 'approved') {
    const rid = pendingReq.roomId;
    stopJoinStatusPolling();
    pendingReq = null;
    enterRoom(r.playerId, rid);
  } else if (r.status === 'rejected') {
    stopJoinStatusPolling();
    const reason = r.reason || '申请被拒绝';
    pendingReq = null;
    updateLobbyChrome();
    toast(reason);
    loadRooms();
  }
  // 'pending' → 继续轮询
}

// 房主视角：渲染待审批申请
function renderHostRequests(st) {
  const box = $('reqBox');
  const reqs = (st.isHost && st.pendingRequests) ? st.pendingRequests : [];
  if (!reqs.length) { box.classList.add('hide'); box.innerHTML = ''; return; }
  box.classList.remove('hide');
  let html = '<div class="rb-title">加入申请（' + reqs.length + '）</div>';
  reqs.forEach(rq => {
    html += '<div class="req-row" data-req="' + rq.requestId + '">' +
      '<span class="rq-name">' + escapeHtml(rq.name) + '</span>' +
      '<span class="rq-actions">' +
        '<button class="btn ok sm" data-act="approve">通过</button>' +
        '<button class="btn no sm" data-act="reject">拒绝</button>' +
      '</span></div>';
  });
  box.innerHTML = html;
  box.querySelectorAll('.req-row').forEach(row => {
    const rid = row.dataset.req;
    row.querySelector('[data-act="approve"]').onclick = async () => {
      const r = await post('join-approve', { roomId, playerId, requestId: rid });
      if (r.err) toast(r.err);
    };
    row.querySelector('[data-act="reject"]').onclick = async () => {
      const r = await post('join-reject', { roomId, playerId, requestId: rid });
      if (r.err) toast(r.err);
    };
  });
}

// ---- 自动恢复 + 初始化 ----

(function () {
  // 初始化两个表情栏（大厅等待 + 牌桌）
  buildEmoteBar($('lobbyEmoteBar'));
  buildEmoteBar($('gameEmoteBar'));

  const savedRoom = localStorage.getItem('ddz_room');
  const savedPid = localStorage.getItem('ddz_pid');
  if (savedPid && savedRoom) {
    playerId = savedPid;
    roomId = savedRoom;
    $('room').value = savedRoom;
    $('lobbyInfo').classList.remove('hide');
    updateLobbyChrome();
    startStatePolling();
    connectWS();
  } else {
    updateLobbyChrome();
    startRoomsPolling();
  }
})();
