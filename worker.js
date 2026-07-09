// ============================================================
// Cloudflare Worker 入口（ESM）
// 路由：/api/rooms → Lobby DO（大厅房间列表）
//        /ws 与 /api/* → 对应 Room DO（按 roomId 分片）
//        其余 → 静态资源（public/，由 assets 绑定托管）
// ============================================================

import { Room } from './room-do.js';
import { Lobby } from './lobby-do.js';

export { Room, Lobby };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 大厅房间浏览列表 → Lobby DO（跨房间索引）
    if (path === '/api/rooms' && request.method === 'GET') {
      const id = env.LOBBY.idFromName('global');
      const stub = env.LOBBY.get(id);
      return stub.fetch(request);
    }

    // WebSocket 或房间内动作 → 对应 Room DO
    if (path.startsWith('/api/') || path === '/ws') {
      let roomId = url.searchParams.get('roomId');
      if (!roomId && request.method === 'POST') {
        // roomId 可能在 POST body 里
        try {
          const b = await request.clone().json();
          roomId = b && b.roomId;
        } catch (e) { /* ignore */ }
      }
      roomId = (roomId || 'default').toString();
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // 静态资源（public/）
    return env.ASSETS.fetch(request);
  }
};
