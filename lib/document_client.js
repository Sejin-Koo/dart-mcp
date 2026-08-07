// dart-mcp / lib/document_client.js
//
// 공시서류 원본파일(document.xml) 다운로드·파싱. dart_client.js의 정형 API 8종과
// 달리 서술형 본문(사업의 내용/계열회사/정관 목적/주석/별첨)을 다룬다.
//
// 설계 원칙 (2026-08-08 신설 배경):
// 1. 원문을 영속 저장소(DB/Blob/파일)에 쓰지 않는다 — 요청 1회 처리 동안만 메모리에
//    존재하고, 응답은 추출된 일부(개요/카운트/슬라이스)만 반환한다. 원문 전체를 그대로
//    반환하면 그 자체로 MCP 응답 크기 제한에 걸리고, 다운스트림에서 통째로 컨텍스트에
//    올려버릴 위험도 있다.
// 2. corpCode.xml(3.5MB)을 요청 처리 경로에서 직접 받다가 Vercel 함수에서 대용량 파일
//    다운로드가 지연되는 문제가 실측된 바 있다(scripts/refresh-corp-code.mjs 참고).
//    document.xml은 그보다 작지만(감사보고서 40KB대, 사업보고서 500KB대 zip) 같은
//    호스트이므로 동일 위험을 가정해 재시도+타임아웃을 둔다.
// 3. TLS 핸드셰이크 실패·503은 이 API의 흔한 일시 오류이므로(원인 불문 재시도로 대개
//    풀림), 에러 메시지에 재시도 여부와 curl 직접 호출 폴백 경로를 함께 안내한다.

import AdmZip from "adm-zip";

const DOC_URL = "https://opendart.fss.or.kr/api/document.xml";

function getApiKey() {
  const key = process.env.DART_API_KEY;
  if (!key) {
    throw new Error("DART_API_KEY 환경변수가 설정되어 있지 않습니다. Vercel 프로젝트 설정에서 등록하세요.");
  }
  return key;
}

// ---------------------------------------------------------------------------
// 1. 다운로드 (재시도 + 타임아웃, maxDuration=60초 예산 안에서 마무리)
// ---------------------------------------------------------------------------

const ATTEMPT_TIMEOUT_MS = 15_000;
const BACKOFF_MS = [0, 2_000, 4_000];

async function downloadZip(rcept_no) {
  const key = getApiKey();
  const url = `${DOC_URL}?crtfc_key=${key}&rcept_no=${rcept_no}`;
  let lastErr;
  for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
    if (BACKOFF_MS[attempt - 1]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // zip 시그니처(PK) 검증 — DART가 에러를 text/plain으로 반환할 때 이를 zip으로
      // 오인해 adm-zip에서 알아보기 어려운 에러를 내는 것을 방지.
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        const preview = buf.toString("utf-8", 0, Math.min(buf.length, 300));
        throw new Error(`정상 zip이 아님 (size=${buf.length}). 응답 미리보기: ${preview}`);
      }
      return buf;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `document.xml 다운로드 실패(${BACKOFF_MS.length}회 재시도 후): ${lastErr?.message}. ` +
      `이 API의 TLS 핸드셰이크 실패·503은 흔한 일시 오류이며 이 도구 호출을 다시 시도하면 ` +
      `대개 풀립니다. 반복 실패하면 Bash로 curl 직접 호출(man-dart 6-2)로 전환하세요: ` +
      `curl -s "https://opendart.fss.or.kr/api/document.xml?crtfc_key=<KEY>&rcept_no=${rcept_no}" -o doc.zip`
  );
}

// ---------------------------------------------------------------------------
// 2. 압축 해제 + 텍스트 정제
// ---------------------------------------------------------------------------

function unzipEntries(buf) {
  const zip = new AdmZip(buf);
  return zip.getEntries().map((e) => ({
    name: e.entryName,
    xml: e.getData().toString("utf-8"), // 사업보고서 원문은 UTF-8 고정(man-dart 6-7 실측 — EUC-KR로 읽으면 깨짐)
  }));
}

const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[ent] ?? m;
  });
}

function toPlainText(xml) {
  let t = xml.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  t = t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
  return t;
}

// ---------------------------------------------------------------------------
// 3. 개요(outline) — TITLE 앵커 + SUMMARY 블록
// ---------------------------------------------------------------------------

const SUMMARY_FIELDS = ["TOT_ASSETS", "TOT_DEBTS", "TOT_SALES", "TOT_EMPL", "IFRS_YN", "GMSH_DATE", "AUDIT_CIK"];

function extractSummary(xml) {
  const m = xml.match(/<SUMMARY[^>]*>([\s\S]*?)<\/SUMMARY>/i);
  if (!m) return null;
  const block = m[1];
  const out = {};
  for (const f of SUMMARY_FIELDS) {
    const fm = block.match(new RegExp(`<${f}>([^<]*)</${f}>`, "i"));
    if (fm) out[f] = fm[1].trim();
  }
  return Object.keys(out).length ? out : null;
}

function extractTitleAnchors(xml) {
  const anchors = [];
  const re = /<TITLE\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const engMatch = attrs.match(/ENG="([^"]*)"/i);
    anchors.push({ eng: engMatch ? engMatch[1] : null, attrs: attrs.trim() });
  }
  return anchors;
}

function buildOutline(entries) {
  return entries.map((e, i) => {
    const summary = extractSummary(e.xml);
    const titles = extractTitleAnchors(e.xml);
    return {
      fileIndex: i,
      file: e.name,
      sizeChars: e.xml.length,
      summary,
      titleAnchors: titles.length ? titles : null,
      note: titles.length
        ? undefined
        : "이 문서에는 <TITLE> 앵커가 없습니다(man-dart 6-4 2순위 케이스) — mode=count/extract로 표제 텍스트를 직접 탐색하세요(예: 자간이 벌어진 '재 무 상 태 표' 형태일 수 있어 keyword 매칭은 기본적으로 공백을 허용합니다).",
    };
  });
}

// ---------------------------------------------------------------------------
// 4. 키워드 카운트 / 슬라이스 추출 (공백 유연 매칭 — man-dart 6-4 자간 문제 대응)
// ---------------------------------------------------------------------------

function fuzzyPattern(keyword) {
  // 한 글자씩 사이에 \s*를 끼워 "재 무 상 태 표"처럼 자간이 벌어진 표제도 잡는다.
  const escaped = [...keyword].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.join("\\s*");
}

function countKeyword(plain, keyword, fuzzy = true) {
  const pattern = fuzzy ? fuzzyPattern(keyword) : keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(pattern, "g");
  const matches = plain.match(re);
  return matches ? matches.length : 0;
}

function findOccurrences(plain, keyword, fuzzy = true) {
  const pattern = fuzzy ? fuzzyPattern(keyword) : keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(pattern, "g");
  const out = [];
  let m;
  while ((m = re.exec(plain))) {
    const start = Math.max(0, m.index - 40);
    out.push({ index: m.index, preview: plain.slice(start, m.index + 40).trim() });
    if (m.index === re.lastIndex) re.lastIndex++; // 빈 매칭 무한루프 방지
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. 공개 API
// ---------------------------------------------------------------------------
// processEntries는 네트워크 호출과 분리된 순수 함수라 단위테스트가 가능하다
// (다운로드 없이 임의의 zip entries 배열로 파싱 로직만 검증할 수 있음).

export function processEntries(entries, { mode = "outline", fileIndex = 0, keywords, keyword, charsAfter = 3000, occurrenceIndex, fuzzy = true } = {}) {
  if (mode === "outline") {
    return { fileCount: entries.length, files: buildOutline(entries) };
  }

  if (fileIndex < 0 || fileIndex >= entries.length) {
    throw new Error(`fileIndex 범위 초과 (0~${entries.length - 1}). 먼저 mode=outline으로 파일 목록을 확인하세요.`);
  }
  const target = entries[fileIndex];
  const plain = toPlainText(target.xml);

  if (mode === "count") {
    if (!Array.isArray(keywords) || keywords.length === 0) {
      throw new Error("mode=count에는 keywords(배열)가 필요합니다.");
    }
    const counts = Object.fromEntries(keywords.map((k) => [k, countKeyword(plain, k, fuzzy)]));
    return { file: target.name, fileIndex, counts };
  }

  if (mode === "extract") {
    if (!keyword) throw new Error("mode=extract에는 keyword가 필요합니다.");
    const occs = findOccurrences(plain, keyword, fuzzy);
    if (occs.length === 0) {
      return { file: target.name, fileIndex, keyword, occurrenceCount: 0, note: "본문에서 발견되지 않았습니다." };
    }
    if (occs.length > 1 && occurrenceIndex === undefined) {
      return {
        file: target.name,
        fileIndex,
        keyword,
        occurrenceCount: occs.length,
        preview: occs.map((o, i) => ({ occurrenceIndex: i + 1, preview: o.preview })),
        note: "여러 곳에서 발견되었습니다. occurrenceIndex(1부터)로 위치를 지정해 재호출하세요.",
      };
    }
    const chosen = occurrenceIndex ? occs[occurrenceIndex - 1] : occs[0];
    if (!chosen) throw new Error(`occurrenceIndex 범위 초과 (1~${occs.length}).`);
    return {
      file: target.name,
      fileIndex,
      keyword,
      occurrenceCount: occs.length,
      occurrenceIndex: occurrenceIndex || 1,
      text: plain.slice(chosen.index, chosen.index + charsAfter).trim(),
    };
  }

  throw new Error(`알 수 없는 mode: ${mode} (outline/count/extract 중 하나)`);
}

// 네트워크 다운로드 + 파싱을 합친 실제 도구용 엔트리포인트.
// 원문 buf/entries는 이 함수 실행 범위 안에서만 존재하고 반환값에는 포함되지 않는다
// (영속 저장 안 함 — 설계 원칙 1번).
export async function getDocumentText({ rcept_no, ...opts }) {
  if (!rcept_no) throw new Error("rcept_no는 필수입니다(dart_search_disclosure 결과의 접수번호 14자리).");
  const buf = await downloadZip(rcept_no);
  const entries = unzipEntries(buf);
  const result = processEntries(entries, opts);
  return { rcept_no, ...result };
}
