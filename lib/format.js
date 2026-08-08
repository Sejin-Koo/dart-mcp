// dart-mcp / lib/format.js
// 응답을 사람이 읽기 좋은 마크다운으로 가공하는 유틸리티. 원본 DART 필드명은 영문 축약어라
// 자주 나오는 필드는 한글 라벨로 매핑하고, 매핑이 없는 필드는 원본 필드명을 그대로 쓴다.

export const FIELD_LABELS = {
  corp_code: "고유번호",
  corp_name: "회사명",
  corp_name_eng: "영문회사명",
  stock_code: "종목코드",
  corp_cls: "법인구분",
  ceo_nm: "대표이사",
  jurir_no: "법인등록번호",
  bizr_no: "사업자등록번호",
  adres: "주소",
  hm_url: "홈페이지",
  ir_url: "IR 홈페이지",
  phn_no: "전화번호",
  fax_no: "팩스번호",
  induty_code: "업종코드",
  est_dt: "설립일",
  acc_mt: "결산월",
  rcept_no: "접수번호",
  rcept_dt: "접수일자",
  flr_nm: "제출인",
  report_nm: "보고서명",
  bsns_year: "사업연도",
  reprt_code: "보고서코드",
  stlm_dt: "결산기준일",
  nm: "성명",
  relate: "관계",
  stock_knd: "주식종류",
  bsis_posesn_stock_co: "기초소유주식수",
  bsis_posesn_stock_qota_rt: "기초지분율(%)",
  trmend_posesn_stock_co: "기말소유주식수",
  trmend_posesn_stock_qota_rt: "기말지분율(%)",
  rm: "비고",
  account_nm: "계정명",
  fs_div: "개별/연결구분",
  fs_nm: "개별/연결명",
  sj_div: "재무제표구분",
  sj_nm: "재무제표명",
  thstrm_nm: "당기명",
  thstrm_dt: "당기일자",
  thstrm_amount: "당기금액",
  frmtrm_nm: "전기명",
  frmtrm_dt: "전기일자",
  frmtrm_amount: "전기금액",
  bfefrmtrm_nm: "전전기명",
  bfefrmtrm_dt: "전전기일자",
  bfefrmtrm_amount: "전전기금액",
  ord: "정렬순서",
  modify_date: "최종변경일",
  currency: "통화단위",
  se: "구분",
  exctv_nm: "임원명",
  ofcps: "직위",
  chrg_job: "담당업무",
  main_career: "주요경력",
  mxmm_shrholdr_relate: "최대주주와의관계",
  hffc_pd: "재직기간",
  tenure_end_dt: "임기만료일",
  fo_bbm: "성별",
  sexdstn: "성별",
  birth_ym: "출생년월",
  emp_co: "직원수",
  avrg_cnwk_sdytrn: "평균근속연수",
  fyer_salary_totamt: "연간급여총액",
  jan_salary_am: "1인평균급여액",
  agnst_dl: "당기순이익",
  district: "부서",
  isu_cmpny: "발행회사",
  isu_de: "발행일자",
  isu_amount: "발행금액",
  remndr_exprtn1: "잔여만기",
  mtd: "만기일",
};

function fmtVal(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  return String(v);
}

function labelOf(key) {
  return FIELD_LABELS[key] || key;
}

// 단일 객체(예: 기업개황) → "항목 | 내용" 2열 표
export function toMarkdownKV(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "(빈 응답)";
  const lines = ["| 항목 | 내용 |", "| --- | --- |"];
  for (const k of keys) {
    lines.push(`| ${labelOf(k)} | ${fmtVal(obj[k])} |`);
  }
  return lines.join("\n");
}

// 배열(리스트) 응답 → 표. 컬럼은 전체 행의 key 합집합(첫 행 순서 우선)에서 구성.
// 토큰 다이어트:
//  - 모든 행에서 값이 동일한 컬럼(접수번호·사업연도·고유번호 등 메타)은 표에서 빼서
//    표 위에 "공통" 한 줄로 요약 (행 3개 이상일 때).
//  - 전 행이 빈 값인 컬럼은 제거.
export function toMarkdownTable(rows, { maxRows = 100, compact = true } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return "(조회된 데이터가 없습니다)";
  const colSet = [];
  const seen = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        colSet.push(k);
      }
    }
  }

  let commonLine = null;
  let cols = colSet;
  if (compact) {
    // 빈 컬럼 제거
    cols = cols.filter((c) => rows.some((r) => fmtVal(r[c]) !== "" && fmtVal(r[c]) !== "-"));
    if (rows.length >= 3) {
      const uniform = [];
      const varying = [];
      for (const c of cols) {
        const first = fmtVal(rows[0][c]);
        if (rows.every((r) => fmtVal(r[c]) === first)) uniform.push(c);
        else varying.push(c);
      }
      // 전부 동일한 표(1컬럼짜리 등)가 되지 않도록 varying이 있을 때만 분리
      if (uniform.length > 0 && varying.length > 0) {
        commonLine = `공통: ${uniform.map((c) => `${labelOf(c)}=${fmtVal(rows[0][c])}`).join(", ")}`;
        cols = varying;
      }
    }
  }

  const shown = rows.slice(0, maxRows);
  const header = `| ${cols.map(labelOf).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = shown.map((row) => `| ${cols.map((c) => fmtVal(row[c])).join(" | ")} |`);
  const lines = [];
  if (commonLine) lines.push(commonLine, "");
  lines.push(header, sep, ...body);
  if (rows.length > maxRows) {
    lines.push("", `_(총 ${rows.length}건 중 ${maxRows}건만 표시)_`);
  }
  return lines.join("\n");
}

// 재무제표(주요계정/전체 재무제표) 전용 포맷: 연결/개별로 섹션을 나누고
// 핵심 컬럼(재무제표명/계정명/당·전·전전기 금액)만 표시한다.
const FIN_ROW_KEYS = ["sj_nm", "account_nm", "thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"];
export function toFinancialMarkdown(rows, { maxRows = 200 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return "(조회된 데이터가 없습니다)";
  if (!rows[0] || !("account_nm" in rows[0])) return toMarkdownTable(rows, { maxRows });

  const groups = new Map(); // fs_nm(연결/개별) → rows
  for (const r of rows) {
    const g = r.fs_nm || r.fs_div || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  const first = rows[0];
  const period = [
    first.thstrm_nm && `당기=${fmtVal(first.thstrm_nm)}`,
    first.frmtrm_nm && `전기=${fmtVal(first.frmtrm_nm)}`,
    first.bfefrmtrm_nm && `전전기=${fmtVal(first.bfefrmtrm_nm)}`,
    first.currency && `통화=${fmtVal(first.currency)}`,
    first.rcept_no && `접수번호=${fmtVal(first.rcept_no)}`,
  ]
    .filter(Boolean)
    .join(", ");

  const keys = FIN_ROW_KEYS.filter((k) => rows.some((r) => fmtVal(r[k]) !== ""));
  const parts = [];
  if (period) parts.push(period);
  let shownTotal = 0;
  for (const [g, grows] of groups) {
    if (g) parts.push(`### ${g}`);
    const shown = grows.slice(0, Math.max(0, maxRows - shownTotal));
    shownTotal += shown.length;
    const header = `| ${keys.map(labelOf).join(" | ")} |`;
    const sep = `| ${keys.map(() => "---").join(" | ")} |`;
    const body = shown.map((r) => `| ${keys.map((k) => fmtVal(r[k])).join(" | ")} |`);
    parts.push([header, sep, ...body].join("\n"));
    if (shown.length < grows.length) {
      parts.push(`_(${g || "전체"} ${grows.length}행 중 ${shown.length}행만 표시)_`);
    }
  }
  return parts.join("\n\n");
}

// dart_get_document_text 전용 포맷. 이 도구의 응답은 중첩 객체/배열이라 위의
// toMarkdownKV/toMarkdownTable(평면 DART API 응답 전용)로는 [object Object]가 찍힌다.
export function formatDocumentResult(result) {
  const parts = [`접수번호: ${result.rcept_no}`];

  if (Array.isArray(result.files)) {
    parts.push(`파일 ${result.fileCount}개`);
    for (const f of result.files) {
      parts.push(`### [${f.fileIndex}] ${f.file} (${f.sizeChars.toLocaleString()}자${f.encoding ? `, ${f.encoding}` : ""})`);
      if (f.summary) {
        parts.push(toMarkdownKV(f.summary));
      }
      if (f.titleAnchors) {
        parts.push(
          "표제 앵커: " + f.titleAnchors.map((t) => t.eng || "(ENG 속성 없음)").join(" / ")
        );
      }
      if (f.note) parts.push(`⚠️ ${f.note}`);
    }
    return parts.join("\n\n");
  }

  if (result.counts) {
    parts.push(`파일: [${result.fileIndex}] ${result.file}`);
    const lines = ["| 키워드 | 등장횟수 |", "| --- | --- |"];
    for (const [k, v] of Object.entries(result.counts)) lines.push(`| ${k} | ${v} |`);
    parts.push(lines.join("\n"));
    return parts.join("\n\n");
  }

  // extract 모드
  parts.push(`파일: [${result.fileIndex}] ${result.file}`, `키워드: "${result.keyword}" (${result.occurrenceCount}건 발견)`);
  if (result.note) parts.push(`⚠️ ${result.note}`);
  if (Array.isArray(result.preview)) {
    const lines = ["| 위치 | 미리보기 |", "| --- | --- |"];
    for (const p of result.preview) lines.push(`| ${p.occurrenceIndex} | ...${p.preview}... |`);
    parts.push(lines.join("\n"));
  }
  if (result.text) {
    parts.push(`위치 ${result.occurrenceIndex}:\n\n${result.text}`);
  }
  return parts.join("\n\n");
}

// 도구 함수의 결과 객체를 사람이 읽기 좋은 마크다운 문자열로 변환.
// reportItem/infoType/label이 있으면 제목으로 사용.
export function formatDartResult(result) {
  const title = result.label
    ? `## ${result.label}`
    : null;

  if (result.error) {
    return [title, `❌ 오류 (status ${result.status}): ${result.message}`]
      .filter(Boolean)
      .join("\n\n");
  }
  if (result.status === "013") {
    return [title, "조회된 데이터가 없습니다."].filter(Boolean).join("\n\n");
  }

  const parts = [];
  if (title) parts.push(title);
  if (result.warning) parts.push(`⚠️ ${result.warning}`);

  if (Array.isArray(result.items)) {
    // dart_search_corp_code 전용 응답 형태
    parts.push(`검색결과 ${result.totalCount}건`);
    parts.push(toMarkdownTable(result.items));
    return parts.join("\n\n");
  }

  if (Array.isArray(result.list)) {
    if (typeof result.total_count === "number") {
      parts.push(`총 ${result.total_count}건 (페이지 ${result.page_no ?? 1}/${result.total_page ?? 1})`);
    }
    // 재무제표류(list 행에 account_nm 존재)는 전용 컴팩트 포맷 사용
    if (result.list[0] && "account_nm" in result.list[0] && "thstrm_amount" in result.list[0]) {
      parts.push(toFinancialMarkdown(result.list));
    } else {
      parts.push(toMarkdownTable(result.list));
    }
    return parts.join("\n\n");
  }

  // 단일 객체 응답 (기업개황 등) — status/message/reportItem/label/infoType 등 메타 필드는 제외
  const { status, message, reportItem, infoType, label, ...rest } = result;
  parts.push(toMarkdownKV(rest));
  return parts.join("\n\n");
}
