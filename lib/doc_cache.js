// dart-mcp / lib/doc_cache.js
//
// 공시서류 원본파일(document.xml zip)의 24시간 보관소 (2026-10-31 신설).
//
// 왜 만들었나: dart_get_document_text는 키워드를 바꿀 때마다 같은 원문을 opendart에서
// 새로 받았다(Vercel 함수 기준 1회 30~40초). 한 질문에 원문 조회가 20번 넘게 이어진
// 실측 사례가 있어, 한 번 받은 원문을 Vercel Blob(비공개 저장소)에 접수번호 단위로
// 24시간 보관하고 그 안의 재조회는 보관본으로 처리한다.
//
// 설계 원칙
// 1. 키는 접수번호(rcept_no 14자리) 하나다. DART는 새 보고서·정정공시를 항상 새 접수번호로
//    올리므로, 같은 접수번호의 원문은 바뀌지 않는다. 그래서 보관본이 낡은 답을 낼 일이 없고,
//    24시간은 순수하게 용량 관리 기준이다. "최신 보고서가 무엇인가"는 공시검색(실시간)이 판단한다.
// 2. 보관소는 보조 장치다. 토큰이 없거나 Blob 호출이 실패·초과해도 도구는 멈추지 않고
//    기존처럼 opendart 직접 다운로드로 처리한다(상태만 응답에 표시).
// 3. 압축(zip) 상태 그대로 저장한다(사업보고서 기준 0.5MB 안팎). 풀어서 저장하면 10배 커진다.
// 4. 만료 판정은 읽을 때 uploadedAt으로 한다 — 정리 작업(api/doc-cache-cleanup.js)이
//    늦게 돌아도 24시간이 지난 보관본은 쓰지 않는다.

import { get, put, del, list } from "@vercel/blob";

export const CACHE_PREFIX = "dart-doc-cache/";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 8_000;

// 테스트에서 실제 Blob 대신 가짜 구현을 끼우기 위한 주입점.
let backend = { get, put, del, list };
export function __setCacheBackend(b) {
  backend = b ?? { get, put, del, list };
}

export function cacheEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN && process.env.DOC_CACHE_DISABLED !== "1";
}

function cachePath(rcept_no) {
  return `${CACHE_PREFIX}${rcept_no}.zip`;
}

function isZip(buf) {
  return buf && buf.length >= 100 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function withTimeout(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

/**
 * 보관본을 읽는다.
 * @returns {{ buf: Buffer, uploadedAt: Date } | { miss: string } | { error: string }}
 */
export async function readCachedZip(rcept_no, now = Date.now()) {
  const t = withTimeout(READ_TIMEOUT_MS);
  try {
    const res = await backend.get(cachePath(rcept_no), { access: "private", abortSignal: t.signal });
    if (!res || res.statusCode !== 200 || !res.stream) return { miss: "보관본 없음" };
    const uploadedAt = new Date(res.blob.uploadedAt);
    if (now - uploadedAt.getTime() > CACHE_TTL_MS) {
      // 만료분은 지우고(삭제는 과금 대상이 아님) 새로 받게 한다.
      backend.del(cachePath(rcept_no)).catch(() => {});
      return { miss: "보관 기간(24시간) 경과" };
    }
    const buf = Buffer.from(await new Response(res.stream).arrayBuffer());
    if (!isZip(buf)) return { miss: "보관본 손상(zip 아님)" };
    return { buf, uploadedAt };
  } catch (err) {
    return { error: `보관소 읽기 실패: ${err?.message || err}` };
  } finally {
    t.done();
  }
}

/** 원문 zip을 보관한다. 실패해도 예외를 던지지 않고 사유 문자열을 돌려준다. */
export async function writeCachedZip(rcept_no, buf) {
  const t = withTimeout(WRITE_TIMEOUT_MS);
  try {
    await backend.put(cachePath(rcept_no), buf, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/zip",
      abortSignal: t.signal,
    });
    return null;
  } catch (err) {
    return `보관소 저장 실패: ${err?.message || err}`;
  } finally {
    t.done();
  }
}

/**
 * 보관본 우선 → 없으면 download()로 받아 보관.
 * @param {string} rcept_no
 * @param {() => Promise<Buffer>} download  opendart 직접 다운로드 함수
 * @returns {Promise<{ buf: Buffer, cache: object }>}
 */
export async function getZipWithCache(rcept_no, download) {
  const valid = /^\d{14}$/.test(String(rcept_no));
  if (!valid || !cacheEnabled()) {
    const buf = await download();
    return {
      buf,
      cache: { status: "off", reason: !valid ? "접수번호가 14자리 숫자가 아니어서 보관하지 않음" : "보관소 미설정" },
    };
  }

  const hit = await readCachedZip(rcept_no);
  if (hit.buf) {
    return { buf: hit.buf, cache: { status: "hit", uploadedAt: hit.uploadedAt.toISOString() } };
  }

  const buf = await download();
  const writeErr = await writeCachedZip(rcept_no, buf);
  return {
    buf,
    cache: {
      status: writeErr ? "error" : "miss",
      reason: [hit.miss || hit.error, writeErr].filter(Boolean).join(" / ") || undefined,
    },
  };
}

/** 24시간이 지난 보관본을 전부 지운다(정리 작업용). */
export async function purgeExpired(now = Date.now()) {
  let cursor;
  let scanned = 0;
  const expired = [];
  do {
    const page = await backend.list({ prefix: CACHE_PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) {
      scanned++;
      if (now - new Date(b.uploadedAt).getTime() > CACHE_TTL_MS) expired.push(b.url);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (expired.length) await backend.del(expired);
  return { scanned, deleted: expired.length };
}
