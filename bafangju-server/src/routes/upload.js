'use strict';
/**
 * 图片上传路由（P0-3）。
 * 合规要点：
 * - 必须注册在 attachUser 之后：需要解析上传者身份（商家 > 用户 > 游客）；
 * - 素材上传必须登录：游客只允许传入驻证照（避免匿名往公开目录写文件）；
 * - 文件类型按文件头 magic bytes 判定，不信任客户端 ext；
 * - 文件名用 UUID（不可预测、不含时间戳）；入驻证照落私有目录，**不挂静态路由**，仅管理后台鉴权后可查看；
 * - 频率限制（分钟级）+ 每日配额（主体 / 同源 IP / 全站），全部落库，跨重启有效。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = function register(app, ctx) {
  const { db, audit, upload, UPLOAD_DIR, PRIVATE_UPLOAD_DIR } = ctx;

  // 用途 purpose：entry=入驻证照（落私有目录，仅管理后台可查看）；material=商品广告素材（落公开目录，必须登录）
  app.post('/api/upload', (req, res) => {
    let identity = null;
    try {
      const body = req.body || {};
      const purpose = body.purpose === upload.PURPOSE.MATERIAL ? upload.PURPOSE.MATERIAL : upload.PURPOSE.ENTRY;
      identity = upload.resolveIdentity(req, db);
      // 素材上传必须登录：游客只允许传入驻证照（避免匿名往公开目录写文件）
      if (purpose === upload.PURPOSE.MATERIAL && identity.tier === 'guest') {
        throw new upload.UploadError('请先登录后再上传素材', 401);
      }
      const ip = upload.clientIp(req);
      const scopes = upload.quotaScopes(identity, ip);
      // ① 分钟级频率限制（主体 + 同源 IP）
      for (const s of scopes) upload.assertMinuteRate(`min:${s.scope}`, s.limits.perMinute);
      // ② 解码 + 真实类型校验（读文件头 magic bytes，不信任客户端 ext）
      const buf = upload.decodeImagePayload(body.dataBase64);
      const type = upload.detectImageType(buf);
      if (!type) throw new upload.UploadError('仅支持 PNG/JPEG/WEBP 图片（按文件真实内容判定）');
      // ③ 每日配额（主体 + 同源 IP + 全站）
      for (const s of scopes) upload.assertDailyQuota(db, s.scope, s.limits, buf.length);
      // ④ 落盘：文件名用 UUID（不可预测、不含时间戳）
      const priv = purpose === upload.PURPOSE.ENTRY;
      const dir = priv ? PRIVATE_UPLOAD_DIR : UPLOAD_DIR;
      const name = upload.randomFileName(type.ext);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      // ⑤ 记账 + 审计留痕
      for (const s of scopes) upload.consumeDailyQuota(db, s.scope, buf.length);
      const url = priv ? `/uploads-private/${name}` : `/uploads/${name}`;
      audit(db, identity.actor, 'upload.image', { tier: identity.tier, purpose, url, bytes: buf.length, ext: type.ext });
      res.json({ ok: true, url, ext: type.ext, bytes: buf.length, scope: priv ? 'private' : 'public' });
    } catch (e) {
      const status = e.status || 400;
      if (status === 429 || status === 401 || status === 403) {
        audit(db, (identity && identity.actor) || 'unknown', 'upload.rejected', {
          reason: e.message, purpose: (req.body || {}).purpose || '',
        });
      }
      res.status(status).json({ error: e.message });
    }
  });
};
