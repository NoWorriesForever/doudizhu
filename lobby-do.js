// ============================================================
// Durable Object：Lobby —— 全局单例，维护跨房间索引
// 供大厅房间浏览（/api/rooms）读取进行中/未满房间列表。
// Room DO 在状态变化时通过 /lobby-update、/lobby-remove 维护此索引。
// ============================================================

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.index = new Map(); // roomId -> { roomId, hostName, phase, playerCount, capacity, isFull, canJoin }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 大厅房间列表
    if (path === '/api/rooms' && request.method === 'GET') {
      // 只展示：进行中 或 未满大厅
      const list = [...this.index.values()].filter(r =>
        r.canJoin || ['bidding', 'playing', 'reveal'].includes(r.phase));
      list.sort((a, b) => {
        if (a.canJoin !== b.canJoin) return a.canJoin ? -1 : 1;
        return String(a.roomId).localeCompare(String(b.roomId));
      });
      return json(200, { rooms: list });
    }

    // Room DO 上报索引更新
    if (path === '/lobby-update' && request.method === 'POST') {
      try {
        const info = await request.json();
        if (info && info.roomId) {
          this.index.set(info.roomId, info);
          await this.persist();
        }
      } catch (e) {}
      return json(200, { ok: true });
    }

    // Room DO 上报房间移除
    if (path === '/lobby-remove' && request.method === 'POST') {
      try {
        const { roomId } = await request.json();
        if (roomId) {
          this.index.delete(roomId);
          await this.persist();
        }
      } catch (e) {}
      return json(200, { ok: true });
    }

    return json(404, { err: 'no' });
  }

  async persist() {
    try {
      await this.state.storage.put('index', [...this.index.entries()]);
    } catch (e) { /* ignore */ }
  }

  // 恢复持久化索引
  async alarm() {
    // 暂不使用 alarm，索引由 Room DO 主动维护
  }
}
