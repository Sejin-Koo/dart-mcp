// dart-mcp / api/doc-cache-cleanup.js — 원문 보관소 정리(매일 1회, vercel.json crons)
//
// 24시간이 지난 공시 원문 보관본(dart-doc-cache/*.zip)을 지운다. 만료 판정은 읽을 때도
// 하므로(lib/doc_cache.js) 이 작업이 늦게 돌아도 오래된 보관본이 응답에 쓰이지는 않는다.
// 이 작업은 저장 용량만 관리한다.
//
// 인증: Vercel Cron은 CRON_SECRET 환경변수가 있으면 Authorization: Bearer <값>을 붙여
// 호출한다. CRON_SECRET이 없거나 값이 다르면 실행하지 않는다 — 누구나 호출할 수 있게
// 열어 두면 목록 조회 횟수(Blob 고급 작업 한도)를 남이 소모할 수 있기 때문이다.
import { cacheEnabled, purgeExpired } from "../lib/doc_cache.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || "";
  res.setHeader("Content-Type", "application/json");
  if (!secret || auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  if (!cacheEnabled()) {
    res.end(JSON.stringify({ ok: true, skipped: "보관소 미설정" }));
    return;
  }
  try {
    const r = await purgeExpired();
    console.log(`[doc-cache-cleanup] scanned=${r.scanned} deleted=${r.deleted}`);
    res.end(JSON.stringify({ ok: true, ...r }));
  } catch (err) {
    console.log(`[doc-cache-cleanup] error=${err?.message || err}`);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}
