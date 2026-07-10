// 表情目录：id -> {e: emoji, t: 文案}
// 与后端 src/room.js 的 EMOTE_IDS 保持一致
const EMOTES = {
  smile:   { e: '\u{1F60A}', t: '微笑' },
  cry:     { e: '\u{1F62D}', t: '哭泣' },
  laugh:   { e: '\u{1F602}', t: '大笑' },
  angry:   { e: '\u{1F620}', t: '生气' },
  shock:   { e: '\u{1F631}', t: '震惊' },
  cool:    { e: '\u{1F60E}', t: '得意' },
  cheer:   { e: '\u{1F389}', t: '庆祝' },
  awkward: { e: '\u{1F605}', t: '尴尬' },
  think:   { e: '\u{1F914}', t: '思考' },
  thumbs:  { e: '\u{1F44D}', t: '赞' },
};
