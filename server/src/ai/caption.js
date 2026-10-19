import { log } from '../util.js';
import { isImageMime } from '../assets.js';

/**
 * Describe an uploaded image once, so it is searchable ("find the robot arm picture") and the text-only
 * parts of the system (recall, Live mode) know what it shows. Runs in the background after upload.
 */
export async function captionAsset({ gemini, assets, store, hub, settings }, assetId) {
  const s = settings.get();
  if (!gemini.configured || !s.autoCaptionImages) return null;
  const file = assets.read(assetId);
  if (!file || !isImageMime(file.asset.mime) || file.data.length > 7 * 1024 * 1024 || file.asset.caption) return null;
  try {
    const { text } = await gemini.generate({
      model: s.textModel,
      thinkingLevel: s.thinkingLevel,
      temperature: 0.2,
      maxOutputTokens: 200,
      contents: [{ role: 'user', parts: [
        { text: 'Describe this image in one or two plain sentences, for later search. Name the main subject, any readable text, and notable colors or style. No preamble.' },
        { inlineData: { mimeType: file.asset.mime, data: file.data.toString('base64') } },
      ] }],
    });
    const caption = text.trim().slice(0, 500);
    if (!caption) return null;
    assets.setCaption(assetId, caption);
    // Give every image object using this asset a searchable description (system edit; not part of undo history).
    const rows = store.db.prepare(`SELECT board_id, id, data FROM objects WHERE type = 'image' AND json_extract(data,'$.asset') = ?`).all(assetId);
    const byBoard = new Map();
    for (const r of rows) {
      const o = JSON.parse(r.data);
      if (o.alt) continue;
      if (!byBoard.has(r.board_id)) byBoard.set(r.board_id, []);
      byBoard.get(r.board_id).push({ op: 'patch', id: o.id, set: { alt: caption } });
    }
    for (const [boardId, ops] of byBoard) store.applyBatch(boardId, ops, { actor: 'system', label: 'Image description' });
    hub.broadcast({ t: 'asset', id: assetId, caption });
    return caption;
  } catch (e) {
    log('warn', 'image caption failed', { assetId, error: String(e?.message || e) });
    return null;
  }
}
