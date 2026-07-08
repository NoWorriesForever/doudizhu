'use strict';

// ============================================================
// SSE 推送：替代 HTTP 短轮询，服务端主动推状态变更
// ============================================================

// roomId-playerId -> Set<response>
const clients = new Map();

function clientKey(roomId, playerId) {
  return `${roomId}:${playerId}`;
}

// 注册一个 SSE 连接
function addClient(roomId, playerId, res) {
  const key = clientKey(roomId, playerId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  return key;
}

// 移除断开的 SSE 连接
function removeClient(res, key) {
  const set = clients.get(key);
  if (set) {
    set.delete(res);
    if (set.size === 0) clients.delete(key);
  }
}

// 向房间内指定玩家的所有连接推送状态（支持多 tab 同时打开）
function pushToPlayer(roomId, playerId, data) {
  const key = clientKey(roomId, playerId);
  const set = clients.get(key);
  if (!set) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch (e) { set.delete(res); }
  }
  if (set.size === 0) clients.delete(key);
}

// 向整个房间广播（给每个玩家推送各自的视图）
function broadcast(roomId, viewFn) {
  const room = require('./room');
  // 这里需要从外部传入 getRoom，避免循环依赖
  if (typeof viewFn !== 'function') return;
  // 遍历房间内的玩家，推送各自的视角
  for (const playerId of clients.keys()) {
    if (playerId.startsWith(roomId + ':')) {
      const data = viewFn(playerId);
      if (data) pushToPlayer(roomId, playerId.split(':')[1], data);
    }
  }
}

// 清理房间内所有 SSE 连接
function closeRoom(roomId) {
  for (const [key, set] of clients.entries()) {
    if (key.startsWith(roomId + ':')) {
      for (const res of set) {
        try { res.end(); } catch (e) {}
      }
      clients.delete(key);
    }
  }
}

module.exports = { addClient, removeClient, pushToPlayer, broadcast, closeRoom };
