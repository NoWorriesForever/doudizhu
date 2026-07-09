// ============================================================
// 斗地主前端 · SSE 通信 + 局部更新 + 回放
// ============================================================

const $ = (id) => document.getElementById(id);
const SUIT = ['♠', '♥', '♣', '♦'];

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
  if (lastPushAt && Date.now() - lastPushAt < 600) return; // SSE 刚推送过，跳过一次避免重复渲染
  try {
    const st = await get('state', { roomId, playerId });
    if (st && st.mySeat >= 0) {
      consecutiveBad = 0;
      $('netbar').classList.add('hide');
      render(st);
    } else if (++consecutiveBad >= 3) {
      stopStatePolling();
      showJoinForm('你已不在该房间，请重新加入');
    }
  } catch (e) {
    if (++consecutiveBad >= 3) { stopStatePolling(); showJoinForm('连接已断开，请重新加入'); }
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

// ---- 渲染 ----

function render(st) {
  if (st.mySeat < 0) return;

  const inGame = st.phase !== 'lobby';
  $('lobby').classList.toggle('hide', inGame);
  $('game').classList.toggle('hide', !inGame);

  if (!inGame) {
    $('banner').classList.add('hide');
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
      return '<div style="padding:4px 0">座位' + s.seat + '：' + s.name + meMark + (s.isBot ? '（机器人）' : '') + '</div>';
    }).join('');
    $('seatList').innerHTML = list + '<div style="opacity:.7;font-size:.8rem;margin-top:6px">' + st.playerCount + '/3 人</div>';
    $('readyBtn').textContent = st.myReady ? '取消准备' : '准备';
    renderHostRequests(st);
    return;
  }

  lastVersion = st.version;
  mySeat = st.mySeat;
  lastState = st;

  const myInfo = st.seats[st.mySeat] || {};
  const multTag = (st.landlordSeat >= 0 && st.callMult > 1)
    ? ' · <span class="mytotal">倍数 <b>\u00d7' + st.callMult + '</b></span>' : '';
  const roundTag = st.roundNo > 0
    ? ' · <span class="mytotal">第 <b>' + st.roundNo + '/' + st.totalRounds + '</b> 局</span>' : '';
  $('roomTag').innerHTML =
    '房间 ' + st.roomId + roundTag + ' · <span class="mytotal">积分 <b>' + fmtScore(myInfo.score || 0) + '</b></span>' + multTag;
  $('gameMsg').textContent = st.message;

  // 未隐藏回放面板 → 更新步骤高亮
  if (!$('replayPanel').classList.contains('hide')) {
    updateReplayHighlight();
  }

  renderSeats(st);
  renderBottom(st);
  renderPlayed(st);
  renderBidding(st);
  renderMyMeta(st);
  // 手牌只在“牌本身变化”时重建 DOM（避免每 800ms 轮询都重建 17+ 张牌，移动端卡顿/吞点击）
  const newHandSig = (st.myHand || []).map(c => c.id).join(',');
  if (newHandSig !== handSig) { renderMyHand(st); handSig = newHandSig; }
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
    div.className = 'seat' +
      (((st.phase === 'playing' && st.curSeat === s) || (st.phase === 'bidding' && st.bidSeat === s)) ? ' active' : '');

    let role = info.isLandlord ? '<span class="crown">地主</span>' : (st.landlordSeat >= 0 ? '农民' : '');
    if (st.phase === 'bidding' && info.isCaller && st.bidRound === 'grab') role = '已叫地主';
    let conn = '';
    if (info.connected === false && !info.isBot) {
      conn = info.hosting ? ' <span class="offtag">托管中</span>' : ' <span class="offtag">掉线</span>';
    }

    div.innerHTML = '<div class="nm">' + info.name + (info.isBot ? '' : '') +
      ' <span class="sc">' + fmtScore(info.score || 0) + '</span>' + conn + '</div>' +
      '<div class="role">' + role + '</div>' +
      '<div class="seat-timer"></div>';

    if (revealing && info.hand) {
      const hd = document.createElement('div');
      hd.className = 'revealhand';
      if (info.hand.length === 0) {
        hd.innerHTML = '<span style="font-size:.75rem;opacity:.85">已出完</span>';
      } else {
        info.hand.forEach(c => hd.appendChild(cardEl(c, true)));
      }
      div.appendChild(hd);
    } else {
      let backs = '';
      for (let i = 0; i < Math.min(info.handCount, 20); i++)
        backs += '<div class="backcard"></div>';
      const bc = document.createElement('div');
      bc.className = 'backcards';
      bc.innerHTML = backs;
      div.appendChild(bc);
      const cnt = document.createElement('div');
      cnt.className = 'cnt';
      cnt.textContent = info.handCount + ' 张';
      div.appendChild(cnt);
    }
  }
}

// ---- 底牌 ----

function renderBottom(st) {
  const bb = $('bottomBox');
  bb.innerHTML = '';
  if (st.bottom && st.bottom.length && st.landlordSeat >= 0) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '底牌';
    bb.appendChild(tag);
    st.bottom.forEach(c => bb.appendChild(cardEl(c, true)));
  }
}

// ---- 出牌区 ----

function renderPlayed(st) {
  const pb = $('playedBox');
  const revealing = st.phase === 'reveal' || st.phase === 'finished';
  pb.innerHTML = '';

  if (revealing) {
    const tip = document.createElement('div');
    tip.className = 'reveal-tip';
    tip.textContent = st.phase === 'reveal' ? '亮牌！查看各家余牌，即将结算…' : '本局结束';
    pb.appendChild(tip);
    // 加回放按钮
    if (st.playLog && st.playLog.length) {
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = '回看本局';
      btn.style.cssText = 'margin-left:8px';
      btn.onclick = () => openReplay(st);
      pb.appendChild(btn);
    }
  } else if (st.lastPlay) {
    const who = st.seats[st.lastPlay.seat];
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = (who ? who.name : '') + ' 出：';
    pb.appendChild(lbl);
    st.lastPlay.cards.forEach(c => pb.appendChild(cardEl(c, true)));

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
  if (st.phase === 'playing' || revealing) {
    const myInfo = st.seats[st.mySeat] || {};
    let myrole = myInfo.isLandlord ? '<span class="crown">地主</span>' : (st.landlordSeat >= 0 ? '农民' : '');
    mm.innerHTML = '<span class="badge">' + (myrole ? myrole + ' · ' : '') +
      '我的手牌 <span class="cn">' + (st.myHand ? st.myHand.length : 0) + '</span> 张</span>';
  } else {
    mm.innerHTML = '';
  }
}

// ---- 我的手牌（局部更新：复用已有 DOM） ----

function renderMyHand(st) {
  const h = $('myhand');
  const cards = st.myHand || [];

  // 移除不存在的旧元素
  const currentIds = new Set(cards.map(c => c.id));
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
    $('bannerSub').innerHTML = html;
    setBannerBtn('再开一轮', async () => {
      await post('newmatch', { roomId, playerId });
      $('banner').classList.add('hide');
    });
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
  $('bannerSub').innerHTML = html;
  setBannerBtn('下一局', async () => {
    const rr = await post('next', { roomId, playerId });
    if (rr.err) toast(rr.err);
    else $('banner').classList.add('hide');
  });
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

// ---- 回放 ----

let replaySteps = [];
let replayIdx = -1;

function openReplay(st) {
  if (!st.playLog || !st.playLog.length) return;
  replaySteps = st.playLog;
  replayIdx = -1;
  $('replayPanel').classList.remove('hide');
  $('replayTitle').textContent = '第 ' + st.roundNo + ' 局回放';
  renderReplay();
}

function renderReplay() {
  const body = $('replayBody');
  body.innerHTML = '';
  replaySteps.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'step' + (i === replayIdx ? ' cur' : '');
    div.textContent = '第' + (i + 1) + '手  ' + step.seatName + '  ' +
      step.cardIds.length + '张  (' + step.combo.type + ')';
    body.appendChild(div);
  });
  $('replayStep').textContent = (replayIdx + 1) + '/' + replaySteps.length;
  if (replayIdx >= 0) {
    body.children[replayIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updateReplayHighlight() {
  if (replaySteps.length === 0) return;
  const body = $('replayBody');
  [...body.children].forEach((d, i) => {
    d.className = 'step' + (i === replayIdx ? ' cur' : '');
  });
  $('replayStep').textContent = (replayIdx + 1) + '/' + replaySteps.length;
}

$('replayCloseBtn').onclick = () => {
  $('replayPanel').classList.add('hide');
  replaySteps = [];
  replayIdx = -1;
};
$('replayPrevBtn').onclick = () => {
  if (replayIdx > 0) { replayIdx--; renderReplay(); }
};
$('replayNextBtn').onclick = () => {
  if (replayIdx < replaySteps.length - 1) { replayIdx++; renderReplay(); }
};
$('replayAutoBtn').onclick = () => {
  $('replayAutoBtn').disabled = true;
  replayIdx = -1;
  function step() {
    replayIdx++;
    renderReplay();
    if (replayIdx < replaySteps.length - 1) {
      setTimeout(step, 800);
    } else {
      $('replayAutoBtn').disabled = false;
    }
  }
  step();
};

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
  consecutiveBad = 0;
  lastPushAt = 0;
  $('lobbyInfo').classList.remove('hide');
  updateLobbyChrome();
  startStatePolling(); // 立即拉一次状态 + 每 2s 兜底（隧道下 SSE 可能延迟）
  connectWS();        // 实时更新
}

// 退回大厅表单（清空凭据、显示输入框、刷新房间列表）
function showJoinForm(msg) {
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
  showJoinForm(); // 统一走退回大厅逻辑：关 SSE、通知服务器移除自己、隐藏牌桌
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
