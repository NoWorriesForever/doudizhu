'use strict';

// ============================================================
// 斗地主联机模拟器 · 入口
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || process.env.ZAOCODE_PREVIEW_PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const rooms = new Map();
const roomModule = require('./src/room');
const botModule = require('./src/bot');
const apiModule = require('./src/api');

// ---- 全局兜底：避免未捕获异常导致整个进程崩溃（所有 SSE 连接全断）----
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));

// ---- 定时任务：机器人 AI + 状态推送 + 亮牌计时 ----

let tickSeq = 0;
setInterval(() => {
  tickSeq++;
  const dirty = new Set(); // 本轮状态变更的房间

  for (const room of rooms.values()) {
    let changed = false;

    // 清理过期连接
    purgeStaleRoom(room);

    // 清理过期的加入申请（超时自动拒绝，供申请者轮询拿到 rejected）
    if (room.pendingRequests && room.pendingRequests.length) {
      const now = Date.now();
      const before = room.pendingRequests.length;
      room.pendingRequests = room.pendingRequests.filter(r => {
        if (now - (r.createdAt || 0) > roomModule.REQUEST_TTL_MS) {
          room.rejectedRequests[r.requestId] = true;
          return false;
        }
        return true;
      });
      if (room.pendingRequests.length !== before) {
        room.rejectedRequests = room.rejectedRequests || {};
        roomModule.bump(room);
        changed = true;
      }
    }

    // 亮牌 4.5 秒后进入结算
    if (room.phase === 'reveal' && Date.now() - room.revealAt > 4500) {
      room.phase = 'finished';
      const r = room.lastResult;
      const who = r && r.winnerSide === 'landlord' ? '地主获胜！' : '农民获胜！';
      const matchOver = room.roundNo >= room.totalRounds;
      room.message = matchOver
        ? `最终结算：${room.totalRounds} 局打完`
        : `第 ${room.roundNo}/${room.totalRounds} 局：${who}`;
      roomModule.bump(room);
      changed = true;
    }

    // 机器人思考 / 断线托管 / 在线超时
    const curTurnSeat = room.phase === 'bidding' ? room.bidSeat
      : (room.phase === 'playing' ? room.curSeat : -1);

    if (curTurnSeat >= 0) {
      const p = roomModule.playerBySeat(room, curTurnSeat);
      if (p) {
        const now = Date.now();
        const elapsed = now - (room.turnStartAt || now);
        const disconnected = !p.isBot && (now - (p.lastSeen || 0) > roomModule.HOST_MS);
        try {
          if (p.isBot) {
            // 机器人思考约 3 秒后行动
            if (elapsed >= roomModule.BOT_THINK_MS) {
              if (room.phase === 'bidding') {
                roomModule.doBid(room, curTurnSeat, botModule.botBid(room, curTurnSeat));
              } else {
                const move = botModule.botMove(room, curTurnSeat);
                if (move.action === 'play') roomModule.doPlay(room, curTurnSeat, move.ids);
                else roomModule.doPass(room, curTurnSeat);
              }
              changed = true;
            }
          } else if (disconnected) {
            // 断线托管：立即替决策
            if (room.phase === 'bidding') {
              roomModule.doBid(room, curTurnSeat, botModule.botBid(room, curTurnSeat));
            } else {
              const move = botModule.botMove(room, curTurnSeat);
              if (move.action === 'play') roomModule.doPlay(room, curTurnSeat, move.ids);
              else roomModule.doPass(room, curTurnSeat);
            }
            changed = true;
          } else {
            // 在线真人：15 秒超时
            if (elapsed >= roomModule.TURN_MS) {
              if (room.phase === 'bidding') {
                roomModule.doBid(room, curTurnSeat, room.bidRound === 'call' ? 'pass' : 'nograb');
              } else if (room.lastPlay === null) {
                // 领出超时：托管出最小牌
                const move = botModule.botMove(room, curTurnSeat);
                if (move.action === 'play') roomModule.doPlay(room, curTurnSeat, move.ids);
                else if (p.hand.length) roomModule.doPlay(room, curTurnSeat, [p.hand[0].id]);
              } else {
                roomModule.doPass(room, curTurnSeat);
              }
              changed = true;
            }
          }
        } catch (e) { /* 忽略单步异常 */ }
      }
    }

    if (changed) dirty.add(room.id);
  }

  // 每 300ms 推一次 SSE 状态（避免每次 tick 都推造成刷屏）
  // 只在房间有变更时推送
  if (dirty.size > 0) {
    for (const [roomId, room] of rooms) {
      if (!dirty.has(roomId)) continue;
      for (const p of room.players) {
        if (!p.isBot) {
          const sseModule = require('./src/sse');
          sseModule.pushToPlayer(roomId, p.id, apiModule.viewFor(room, p.id));
        }
      }
    }
  }
}, Number(process.env.BOT_MS) || 500);

function purgeStaleRoom(room) {
  const now = Date.now();
  if (room.phase === 'lobby') {
    const before = room.players.length;
    room.players = room.players.filter(p =>
      p.isBot || (now - (p.lastSeen || 0) < roomModule.LOBBY_STALE_MS));
    if (room.players.length !== before) roomModule.reseatAndReset(room);
    return;
  }
  const humans = room.players.filter(p => !p.isBot);
  if (humans.length && humans.every(p => now - (p.lastSeen || 0) > 180000)) {
    rooms.delete(room.id);
  }
}

// ---- HTTP 服务器 ----

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { pathname = req.url; }

  // 健康检查
  if (pathname === '/health' || pathname.endsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  }

  // API / SSE（处理成功后 api.js 内部已即时广播给房间内玩家）
  const handled = await apiModule.handleApi(req, res, rooms);
  if (handled) return;

  // 静态文件
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);

  // 安全：防止目录穿越
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    if (!res.headersSent) { res.writeHead(403); res.end('Forbidden'); }
    return;
  }

  // 确定 Content-Type
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  const ctype = mimeTypes[ext] || 'application/octet-stream';

  // 防御：响应头一旦发送就跳过后续写操作，杜绝 ERR_HTTP_HEADERS_SENT 导致整个进程崩溃
  if (res.headersSent) return;

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // 不存在的路径回退到 index.html（SPA）
      if (err.code === 'ENOENT') {
        if (res.headersSent) return;
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, buf2) => {
          if (err2) { if (!res.headersSent) { res.writeHead(500); res.end('Server error'); } return; }
          if (res.headersSent) return;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buf2);
        });
        return;
      }
      if (!res.headersSent) { res.writeHead(500); res.end('Server error'); }
      return;
    }
    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': ctype });
    res.end(buf);
  });
});

// ---- 自测 ----

function selftest() {
  const { parseCombo, beats } = require('./src/engine');
  const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error('FAIL ' + msg + ' got ' + JSON.stringify(a));
  };
  const T = (a, type) => {
    const r = parseCombo(a);
    if (!r || r.type !== type)
      throw new Error('FAIL type ' + type + ' got ' + JSON.stringify(r));
  };
  const N = (a) => {
    if (parseCombo(a) !== null)
      throw new Error('FAIL should be null: ' + a);
  };

  T([5], 'single');
  T([7, 7], 'pair');
  T([9, 9, 9], 'triple');
  T([9, 9, 9, 3], 'triple1');
  T([9, 9, 9, 4, 4], 'triple2');
  T([3, 4, 5, 6, 7], 'straight');
  T([3, 4, 5, 6, 7, 8, 9], 'straight');
  N([3, 4, 5, 6]);
  N([11, 12, 13, 14, 15]);
  T([3, 3, 4, 4, 5, 5], 'dstraight');
  T([3, 3, 3, 4, 4, 4], 'plane');
  T([3, 3, 3, 4, 4, 4, 5, 6], 'plane1');
  T([3, 3, 3, 4, 4, 4, 7, 7, 8, 8], 'plane2');
  // 新增边界测试
  T([3, 3, 3, 4, 4, 4, 5, 5, 6, 6], 'plane2'); // 飞机带两对，不同点数
  N([3, 3, 3, 4, 4, 4, 5, 5, 6]);              // 不应该被识别为飞机（混合对+单）
  T([3, 3, 3, 4, 4, 4, 5, 5, 5], 'plane');      // 三连三张，纯飞机
  T([3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5], 'plane1'); // 三个四张拆为 飞机带三单
  T([6, 6, 6, 6], 'bomb');
  N([8, 8, 8, 8, 3, 3, 3]); // 炸+3，不是合法整手
  T([16, 17], 'rocket');
  T([8, 8, 8, 8, 3, 5], 'four2');
  T([8, 8, 8, 8, 3, 3, 5, 5], 'four2p');
  N([3, 5]);
  N([3, 4, 5]);
  N([]);

  // beats
  const b = (a, c) => beats(parseCombo(a), parseCombo(c));
  if (!b([5], [6])) throw new Error('single beat');
  if (b([6], [5])) throw new Error('single no-beat');
  if (!b([5, 5], [6, 6])) throw new Error('pair beat');
  if (!b([3, 4, 5, 6, 7], [4, 5, 6, 7, 8])) throw new Error('straight beat');
  if (b([3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9])) throw new Error('straight len must match');
  if (!b([5], [6, 6, 6, 6])) throw new Error('bomb beats single');
  if (!b([6, 6, 6, 6], [16, 17])) throw new Error('rocket beats bomb');
  if (b([16, 17], [6, 6, 6, 6])) throw new Error('nothing beats rocket');
  if (!beats(null, parseCombo([3]))) throw new Error('lead any');

  // 飞机跨类型不能压
  if (b([3, 3, 3, 4, 4, 4], [3, 3, 3, 4, 4, 4, 5, 6]))
    throw new Error('plane cannot beat plane1 (diff type)');

  console.log('SELFTEST OK  牌型引擎全部通过');
}

if (process.env.SELFTEST) { selftest(); process.exit(0); }

server.listen(PORT, HOST, () => {
  console.log(`斗地主服务已启动 http://${HOST}:${PORT}`);
});
