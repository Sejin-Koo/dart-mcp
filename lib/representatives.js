// dart-mcp / lib/representatives.js
// 대표이사 명단 조회 — 감사보고서·사업보고서 첨부 재무제표 **표지**에서 추출한다.
//
// 왜 이 모듈이 필요한가
//   DART 기업개황(`company`)의 ceo_nm과 금융위 기업기본정보의 enpRprFnm은 회사가 적은
//   **글자 하나**라, 대표이사가 여러 명이어도 1명만 적힌 회사가 있다(2026-09-30 실측: ㈜비디는
//   3인인데 두 소스 모두 1인만 반환). 반대로 여러 명이 다 적힌 회사도 있다(2026-11-16 실측:
//   삼성전자 "전영현, 노태문"). 그래서 기업개황만으로 명단을 확정하지 않고, 임원현황 결과와
//   **대조하는 데** 쓴다(reconcileWithCompany).
//
//   반면 외부감사법에 따라 제출되는 감사보고서의 첨부 재무제표 표지에는 대표이사가
//   **전원 병기**된다. 실측(2026-09-30, 서로 다른 업종 7개사)에서 7/7 모두 기재가 있었고,
//   2인 이상인 회사는 쉼표로 병기되어 있었다.
//
// 한계 (호출자에게 반드시 함께 전달할 것 — 응답의 caveats로 내보낸다)
//   - 각자대표/공동대표 구분은 표지에 없다. 상법상 공동대표는 등기사항이므로 등기부등본으로만
//     확정된다. 실측 7개사 전부 "각자대표"·"공동대표" 문구가 0회였다.
//   - 취임·퇴임일도 표지에 없다. 연도별 표지를 비교하면 변동 구간만 좁힐 수 있다.
//   - 표지는 그 보고서 작성 시점 기준이다. 최신 감사보고서 제출 이후의 변동은 반영되지 않는다.

import { searchDisclosure, getPeriodicReportItem, getCompanyInfo } from "./dart_client.js";
import { downloadDocumentEntries, toPlainText } from "./document_client.js";

// 표지 블록을 찾는 앵커. 실측 7개사에서 공통으로 관측된 구조는 아래와 같다.
//   "<회사명> 대표이사 <성명들>" → "본점 소재지 :" → "(도로명주소)" → 주소 → "(전 화)" → 전화번호
// "대표이사"는 감사인 서명·주석(연대보증)·내부회계관리제도 문단에도 등장하므로, 단독으로는
// 표지를 특정하지 못한다. **뒤따르는 "본점"까지를 한 쌍으로 묶는 것**이 판별의 핵심이다.
const TITLE_WORDS = ["대표이사", "대표집행임원", "대표자"];

// "대표이사"와 "본점" 사이에 허용할 최대 거리(문자). 표지에서는 성명 직후에 바로 오므로
// 짧다. 넉넉히 잡으면 주석 문장이 걸려들 수 있어 실측 최댓값(약 30자)의 여유배로 둔다.
const NAME_TO_BONJEOM_MAX = 120;

/**
 * 자간이 벌어진 한글 성명을 붙인다. "김 도 영" → "김도영".
 * 공백으로 나눈 조각이 **전부 1글자**일 때만 적용한다. 외국인 성명("로저스 해롤드 린")은
 * 조각이 2글자 이상이라 그대로 유지된다. 실측에서 두 형태가 모두 관측되어 구분이 필요했다.
 */
function normalizeName(raw) {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return "";
  const parts = s.split(" ");
  if (parts.length > 1 && parts.every((p) => [...p].length === 1)) return parts.join("");
  return s;
}

/** 성명 후보가 사람 이름으로 보이는지. 표지 파싱에서 조사·기호가 섞여 들어오는 것을 막는다. */
function looksLikeName(s) {
  if (!s) return false;
  const len = [...s.replace(/\s/g, "")].length;
  if (len < 2 || len > 20) return false;
  // 한글·영문·공백·가운뎃점 외의 문자가 섞이면 성명이 아니다(숫자·괄호·콜론 등).
  return /^[가-힣A-Za-z\s·.]+$/.test(s);
}

// 직명 바로 앞 구간에서 회사명만 떼어낸다.
// ★ 앞 60자를 그대로 쓰면 회사명이 아니라 직전 문장이 통째로 들어온다
//    (실측: '2024년 12월 31일 까지 "첨부된 재무제표는 당사가 작성한 것입니다." 주식회사 비디').
//    표지의 회사명은 언제나 '주식회사 X' 또는 'X 주식회사' 꼴이므로 그 형태로 끝을 잡는다.
const CO_FORM = "(?:주식회사|㈜|\\(주\\)|유한회사|유한책임회사)";
const CO_NAME = "[가-힣A-Za-z0-9()·\\-]+";

export function extractCompanyHint(before) {
  const s = String(before || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const m =
    s.match(new RegExp(`(${CO_FORM}\\s*${CO_NAME})\\s*$`)) ||
    s.match(new RegExp(`(${CO_NAME}\\s*${CO_FORM})\\s*$`));
  if (m) return m[1].replace(/\s+/g, " ").trim();
  // 회사 형태 표기가 없으면 최소한 직전 문장은 떼어낸다(따옴표·마침표로 끊는다).
  const tail = s.split(/["\u201c\u201d\u2018\u2019']/).pop().replace(/^[^가-힣A-Za-z0-9]+/, "").trim();
  return tail || null;
}

/**
 * 평문에서 대표이사 표지 블록을 찾아 성명 배열로 돌려준다.
 * 네트워크와 분리된 순수 함수라 단위테스트가 가능하다.
 */
export function parseRepresentatives(plain) {
  const hits = [];

  for (const word of TITLE_WORDS) {
    const re = new RegExp(word, "g");
    let m;
    while ((m = re.exec(plain))) {
      const after = plain.slice(m.index + word.length, m.index + word.length + NAME_TO_BONJEOM_MAX);

      // 조사가 붙어 문장으로 이어지는 경우(예: "대표이사로부터 지급보증을")는 표지가 아니다.
      // 판별은 **직명 바로 다음 글자가 공백인지**로 한다. 표지는 언제나 "대표이사 홍길동"처럼
      // 띄어 쓰고, 조사는 "대표이사로부터"처럼 붙기 때문이다.
      // ★ 음절 목록으로 거르지 말 것 — "이주완"·"로저스"처럼 조사와 같은 음절로 시작하는
      //    성명이 실제로 있어 멀쩡한 대표이사가 통째로 탈락한다(2026-09-30 단위테스트에서 발견).
      if (!/^\s/.test(after)) continue;

      // 표지 판별: 성명 뒤에 "본점"이 바로 따라와야 한다.
      const bon = after.search(/본\s*점/);
      if (bon < 0) continue;

      const segment = after.slice(0, bon);

      const names = segment
        .split(/[,，·、]/)
        .map(normalizeName)
        .filter(looksLikeName);
      if (names.length === 0) continue;

      // 표지에서는 회사명이 직명 바로 앞에 붙어 있다("쿠팡 주식회사 대표이사 …").
      const before = plain.slice(Math.max(0, m.index - 60), m.index);
      const companyHint = extractCompanyHint(before);

      hits.push({ title: word, names, companyHint, index: m.index });
    }
  }

  if (hits.length === 0) return null;
  // 같은 표지가 여러 번 잡히면 가장 앞선 것을 쓴다(첨부 재무제표 표지가 본문 앞쪽에 있다).
  hits.sort((a, b) => a.index - b.index);
  return hits[0];
}

/**
 * 1순위 — 사업보고서 임원현황(executive_status)에서 직위가 대표이사인 임원을 뽑는다.
 *
 * 표지 파싱보다 이쪽이 낫다: 직위·등기여부·재직기간(취임일)·임기만료일이 구조화되어 있고,
 * 표기 흔들림(자간·쉼표·회사명 접두)에 좌우되지 않는다. 다만 **사업보고서 제출대상 법인만**
 * 해당하므로(상장사 등), 감사보고서만 내는 비상장사는 2순위인 표지 파싱으로 넘어간다.
 *
 * 실측(2026-09-30): 포니링크(코스닥)는 감사보고서(F) 공시가 없어 표지 파싱이 실패했고,
 * 이 경로로는 대표이사 황정일과 재직기간까지 정상 확보됐다.
 */
const REPRT_NAME = {
  "11011": "사업보고서",
  "11012": "반기보고서",
  "11013": "1분기보고서",
  "11014": "3분기보고서",
};

// 결산기준일 비교용 키. "2026-06-30"·"2026년 06월 30일" 어느 표기로 와도 같은 값이 되도록
// 숫자만 남긴다. 값이 없으면 빈 문자열이 되어 항상 최하위로 밀린다.
function stlmKey(v) {
  return String(v || "").replace(/[^0-9]/g, "");
}

// 담당업무 칸에서 대표이사로 인정하는 표기. 칸 안의 항목(ㆍ·,·줄바꿈으로 나뉜 조각)이
// 이 말로 **시작**해야 한다. "대표이사 직속 감사실"·"대표이사 비서실장"처럼 대표이사를 꾸미는
// 말로 쓰인 경우는 뒤따르는 말로 걸러 낸다.
const CHRG_REP_RE = /^(?:각자\s*|공동\s*)?대표\s*(?:이사|집행임원)(?!\s*(?:직속|보좌|비서|지원|산하|부속|실(?:장)?(?![가-힣])))/;

/**
 * 임원현황의 한 사람이 대표이사인지, 그렇다면 어느 칸을 근거로 했는지 돌려준다.
 *   - "직위": 직위(ofcps)에 "대표"가 있음(대표이사·각자대표이사·대표집행임원 등)
 *   - "담당업무": 직위는 사장·부회장 등인데 담당업무(chrg_job) 항목이 "대표이사"로 시작함
 *   - null: 대표이사 표시 없음
 *
 * ★ 사장·부회장·회장 같은 **직급만으로는 대표이사로 보지 않는다.** 직급은 회사가 붙이는
 *   이름이고 대표이사는 이사회가 선임해 등기하는 지위라 서로 다르다(2026-11-16 실측:
 *   삼성전자 2026 반기 — 김용관 사장은 사내이사지만 대표이사가 아님).
 * ★ 담당업무 칸을 보는 이유: 팅크웨어는 2024 사업보고서까지 직위 "대표 이사"였다가 2025
 *   사업보고서부터 직위 "사장", 담당업무 "대표이사, 전사 경영 전반 총괄"로 적었다. 직위만
 *   보면 최근 보고서에서 대표이사를 못 찾고 2024 보고서까지 내려가 옛 명단을 돌려줬다.
 * ★ 주요경력(main_career)은 보지 않는다 — 다른 회사의 대표이사 경력이 섞여 엉뚱한 사람이 잡힌다.
 * ★ 담당업무 근거는 등기임원(사내이사 등)이거나 대표집행임원일 때만 인정한다. 대표이사는
 *   이사 중에서 선임하므로 미등기 임원의 "대표이사…" 표기는 다른 뜻일 가능성이 크다.
 */
export function repBasis(x) {
  if (!x) return null;
  if (typeof x.ofcps === "string" && x.ofcps.includes("대표")) return "직위";
  if (typeof x.chrg_job !== "string") return null;
  const items = x.chrg_job
    .split(/[ㆍ·•,，、\/\n]|\s-\s/)
    .map((t) => t.replace(/^[\s\-*·ㆍ•)\]]+/, "").trim())
    .filter(Boolean);
  for (const it of items) {
    if (!CHRG_REP_RE.test(it)) continue;
    const registered = typeof x.rgist_exctv_at === "string" && /이사/.test(x.rgist_exctv_at);
    if (registered || /대표\s*집행임원/.test(it)) return "담당업무";
  }
  return null;
}

/**
 * 여러 정기보고서에서 받은 임원현황 중 **결산기준일이 가장 최근인** 것을 고른다.
 * 네트워크와 분리된 순수 함수라 단위테스트가 가능하다.
 *
 * ★ 보고서 종류로 순서를 가정하지 말 것 — 12월 결산이 아닌 회사는 사업보고서의
 *   결산기준일이 같은 해 반기보고서보다 앞설 수 있다. 실제 stlm_dt로 고른다.
 *   기준일이 같으면 접수번호가 큰 쪽(나중에 제출된 쪽)을 쓴다.
 * 돌려주는 값의 latest는 대표이사 표시와 무관하게 **임원현황이 있는 가장 최근 보고서**다.
 * 고른 보고서(best)가 그보다 오래됐으면 최근 보고서에서 대표이사를 못 찾았다는 뜻이다.
 * @param {Array<{year:number, code:string, list:Array<object>}>} results
 */
export function pickLatestExecutiveSet(results) {
  let best = null;
  let latest = null;
  const newer = (a, b) => !b || a.stlm > b.stlm || (a.stlm === b.stlm && a.rcept > b.rcept);
  for (const r of results || []) {
    const list = Array.isArray(r && r.list) ? r.list : [];
    if (list.length === 0) continue;
    const cand = {
      year: r.year,
      code: r.code,
      list,
      stlm: stlmKey(list[0].stlm_dt),
      rcept: String(list[0].rcept_no || ""),
    };
    if (newer(cand, latest)) latest = cand;
    const reps = list.filter((x) => repBasis(x));
    if (reps.length === 0) continue;
    if (newer(cand, best)) best = { ...cand, reps };
  }
  if (best) best.latest = latest;
  return best;
}

const sameName = (a, b) => String(a || "").replace(/\s+/g, "") === String(b || "").replace(/\s+/g, "");

/**
 * DART 기업개황 대표자명(ceo_nm)을 성명 배열로 나눈다.
 * "전영현, 노태문" → ["전영현", "노태문"]. "홍길동 외 1명"처럼 일부만 적힌 경우 partial=true.
 */
export function parseCeoNames(raw) {
  const s = String(raw || "").trim();
  if (!s) return { names: [], partial: false };
  const partial = /외\s*\d+\s*(?:명|인)/.test(s);
  const names = s
    .replace(/\([^)]*\)/g, " ")
    .replace(/외\s*\d+\s*(?:명|인)/g, " ")
    .replace(/(?:각자|공동)?\s*대표\s*(?:이사|집행임원)?/g, " ")
    .split(/[,，·、\/&]|\s및\s/)
    .map(normalizeName)
    .filter(looksLikeName);
  return { names, partial };
}

/**
 * 임원현황에서 찾은 대표이사와 기업개황 대표자명을 대조한다(순수 함수).
 * @returns {{ 일치: string[], 기업개황에만: string[], 임원현황에만: string[] }}
 */
export function reconcileWithCompany(execNames, ceoNames) {
  const ex = execNames || [];
  const co = ceoNames || [];
  return {
    일치: ex.filter((n) => co.some((c) => sameName(c, n))),
    기업개황에만: co.filter((c) => !ex.some((n) => sameName(c, n))),
    임원현황에만: ex.filter((n) => !co.some((c) => sameName(c, n))),
  };
}

async function fromExecutiveStatus({ corp_code }) {
  const thisYear = new Date().getFullYear();

  // ★ 임원현황은 사업보고서뿐 아니라 **반기·분기보고서에도 실린다.** 사업보고서만 보면
  //    최대 6개월 묵은 명단을 돌려주고, 그 사이에 대표이사가 바뀌었어도 알 수가 없다
  //    (실측 2026-09-30: 포니링크 2025 사업보고서 기준일 2025-12-31 vs 2026 반기보고서
  //    기준일 2026-06-30). 그래서 후보를 한꺼번에 조회해 가장 최근 것을 고른다.
  const candidates = [];
  for (const year of [thisYear, thisYear - 1]) {
    for (const code of ["11011", "11014", "11012", "11013"]) candidates.push({ year, code });
  }
  candidates.push({ year: thisYear - 2, code: "11011" });

  // 순차 호출하면 후보 수만큼 지연이 쌓인다. 병렬로 던지고 실패한 것은 버린다.
  const settled = await Promise.allSettled(
    candidates.map(({ year, code }) =>
      getPeriodicReportItem({
        reportItem: "executive_status",
        corp_code,
        bsns_year: String(year),
        reprt_code: code,
      }).then((res) => ({ year, code, list: res && res.list }))
    )
  );

  const best = pickLatestExecutiveSet(
    settled.filter((x) => x.status === "fulfilled").map((x) => x.value)
  );
  if (!best) return null;

  const head = best.reps[0];
  const lt = best.latest;
  const stale = lt && lt.stlm > best.stlm ? lt : null;
  return {
    names: best.reps.map((r) => String(r.nm || "").replace(/\s+/g, " ").trim()).filter(Boolean),
    detail: best.reps.map((r) => execDetail(r, repBasis(r) === "직위" ? "임원현황 직위" : "임원현황 담당업무")),
    source: {
      경로: `${REPRT_NAME[best.code] || "정기보고서"} 임원현황`,
      사업연도: String(best.year),
      접수번호: head.rcept_no,
      회사명: head.corp_name,
      결산기준일: head.stlm_dt,
    },
    // 최근 보고서에서 대표이사를 못 찾아 이전 보고서로 내려갔을 때만 채운다.
    stale: stale
      ? {
          보고서: `${REPRT_NAME[stale.code] || "정기보고서"} (사업연도 ${stale.year})`,
          접수번호: stale.list[0].rcept_no,
          결산기준일: stale.list[0].stlm_dt,
        }
      : null,
    // 기업개황과 대조할 때 대표 표시가 없는 사람의 상세를 찾는 명단 — 가장 최근 보고서 기준.
    latestList: (lt || best).list,
  };
}

function execDetail(r, basis) {
  return {
    성명: r.nm,
    직위: r.ofcps,
    등기여부: r.rgist_exctv_at,
    상근여부: r.fte_at,
    담당업무: r.chrg_job,
    재직기간: r.hffc_pd,
    임기만료일: r.tenure_end_on,
    판정근거: basis,
  };
}

/** 기업개황 대표자명을 받아 온다. 실패해도 본 조회를 막지 않는다. */
async function companyCeo(corp_code) {
  try {
    const res = await getCompanyInfo({ corp_code });
    return res && typeof res.ceo_nm === "string" ? res.ceo_nm.trim() : null;
  } catch {
    return null;
  }
}

/** 감사보고서(F) → 사업보고서(A) 순으로 최근 공시를 찾는다. */
async function findLatestReport({ corp_code, bgn_de, end_de }) {
  for (const pblntf_ty of ["F", "A"]) {
    const res = await searchDisclosure({
      corp_code,
      bgn_de,
      end_de,
      pblntf_ty,
      page_count: 10,
      sort: "date",
      sort_mth: "desc",
    });
    const list = res && Array.isArray(res.list) ? res.list : [];
    if (list.length === 0) continue;
    // 정기보고서(A)는 최신순이면 반기·분기가 먼저 걸린다. 표지 기재는 사업보고서가 기준이므로
    // 사업보고서를 우선 고른다(실측: 포니링크가 반기보고서로 폴백해 표지 파싱이 실패했다).
    const preferred =
      pblntf_ty === "A" ? list.find((r) => /사업보고서/.test(r.report_nm || "")) || list[0] : list[0];
    return { pblntf_ty, report: preferred, candidates: list };
  }
  return null;
}

function yyyymmdd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 대표이사 전원 조회.
 * @param {string} corp_code 고유번호 8자리 (필수, rcept_no를 직접 줄 때는 생략 가능)
 * @param {string} [rcept_no] 특정 보고서를 지정할 때. 생략하면 최근 감사보고서를 자동 선택
 */
export async function getRepresentatives({ corp_code, rcept_no } = {}) {
  if (!corp_code && !rcept_no) {
    throw new Error("corp_code 또는 rcept_no 중 하나는 필수입니다.");
  }

  // rcept_no를 콕 집어 준 경우가 아니면 임원현황을 먼저 본다(더 정확하고 빠르다).
  if (!rcept_no && corp_code) {
    const [exec, ceoRaw] = await Promise.all([fromExecutiveStatus({ corp_code }), companyCeo(corp_code)]);
    if (exec) {
      const names = [...exec.names];
      const detail = [...exec.detail];
      const caveats = [];
      let check = null;

      if (exec.stale) {
        caveats.push(
          `가장 최근 보고서(${exec.stale.보고서}, 결산기준일 ${exec.stale.결산기준일})의 임원현황에는 대표이사 표시가 있는 임원이 없어, 그보다 이전 보고서(결산기준일 ${exec.source.결산기준일}) 기준입니다. 그사이 대표이사가 바뀌었을 수 있으니 아래 기업개황 대조와 최근 공시를 함께 확인하세요.`
        );
      }

      if (ceoRaw) {
        const ceo = parseCeoNames(ceoRaw);
        const r = reconcileWithCompany(exec.names, ceo.names);
        check = { 기업개황_대표자명: ceoRaw, ...r };
        // 기업개황에만 있는 이름은 명단에 더하되 근거를 밝힌다. 최근 임원현황에 같은 사람이
        // 있으면 그 직위·담당업무를 함께 붙인다(예: 삼성전자 노태문 — 반기 임원현황엔 '사장').
        for (const nm of r.기업개황에만) {
          const row = (exec.latestList || []).find((x) => sameName(x.nm, nm));
          names.push(nm);
          detail.push(
            row
              ? execDetail(row, "DART 기업개황 대표자명 (최근 임원현황에는 대표이사 표시 없음)")
              : { 성명: nm, 판정근거: "DART 기업개황 대표자명 (최근 임원현황에 없는 사람)" }
          );
        }
        if (r.기업개황에만.length) {
          caveats.push(
            `DART 기업개황 대표자명(${ceoRaw})에는 있지만 최근 임원현황에는 대표이사로 표시되지 않은 사람(${r.기업개황에만.join(", ")})을 명단에 함께 넣었습니다. 보고서 결산기준일 이후 선임됐거나 보고서에 표시가 빠진 경우입니다. 선임 시점은 대표이사 변경 공시나 등기부등본으로 확인하세요.`
          );
        }
        if (r.임원현황에만.length) {
          const where = (s) => (d) => sameName(d.성명, s);
          for (const nm of r.임원현황에만) {
            const d = detail.find(where(nm));
            if (d) d.비고 = "기업개황 대표자명에는 없음";
          }
          caveats.push(
            `임원현황에는 대표이사인데 DART 기업개황 대표자명(${ceoRaw})에는 없는 사람이 있습니다(${r.임원현황에만.join(", ")}). 기업개황은 회사가 대표자 1명만 적어 두는 경우가 많아 이것만으로 교체를 단정할 수는 없습니다. 다만 보고서 결산기준일 이후 바뀌었을 수 있으니 문서에 적기 전에 대표이사 변경 공시를 확인하세요.`
          );
        }
        if (ceo.partial) {
          caveats.push(`기업개황 대표자명이 "외 N명"처럼 일부만 적혀 있어 대조가 불완전합니다.`);
        }
      }

      caveats.push(
        "대표이사는 임원현황의 직위 칸에 '대표'가 있거나, 등기임원의 담당업무 칸이 '대표이사'로 시작할 때 인정했습니다. 사장·부회장 같은 직급만으로는 대표이사로 보지 않습니다(등기된 사장이 대표이사가 아닌 회사가 있습니다). 사람별 근거는 상세의 '판정근거'에 있습니다.",
        "정기보고서(사업·반기·분기) 임원현황 기재 기준이며, 그중 결산기준일이 가장 최근인 보고서를 골랐습니다. 그 기준일 이후의 변동은 반영되지 않으므로, 출처의 결산기준일을 함께 밝혀 쓰세요.",
        "각자대표인지 공동대표인지는 임원현황에 기재되지 않습니다. 공동대표는 상법상 등기사항이므로 등기부등본으로만 확정됩니다(등기가 없으면 각자대표가 원칙).",
        "DART 기업개황(ceo_nm)·금융위 기업기본정보(enpRprFnm)의 대표자명은 회사가 적은 글자 그대로라, 대표이사가 여러 명이어도 1명만 적힌 회사가 있습니다. 회사 식별에는 그 값을 쓰고, 대표이사를 문서에 기재할 때는 이 도구의 명단을 쓰세요."
      );

      return {
        corp_code,
        조회됨: true,
        대표이사: names,
        인원수: names.length,
        상세: detail,
        출처: exec.source,
        ...(exec.stale ? { 최근보고서_대표표시없음: exec.stale } : {}),
        ...(check ? { 기업개황_대조: check } : {}),
        caveats,
      };
    }
  }

  let source = null;
  let target = rcept_no;

  if (!target) {
    const end = new Date();
    const bgn = new Date(end.getFullYear() - 4, end.getMonth(), end.getDate());
    const found = await findLatestReport({
      corp_code,
      bgn_de: yyyymmdd(bgn),
      end_de: yyyymmdd(end),
    });
    if (!found) {
      return {
        corp_code,
        조회됨: false,
        사유:
          "최근 4년간 감사보고서(F)·사업보고서(A) 공시를 찾지 못했습니다. 외부감사 대상이 아닌 " +
          "소규모 법인이면 공시 자체가 존재하지 않습니다. 이 경우 대표이사 명단은 법인등기부등본으로만 확인됩니다.",
      };
    }
    target = found.report.rcept_no;
    source = {
      보고서명: found.report.report_nm,
      접수번호: found.report.rcept_no,
      접수일자: found.report.rcept_dt,
      회사명: found.report.corp_name,
      공시유형: found.pblntf_ty === "F" ? "감사보고서" : "정기보고서",
    };
  }

  const entries = await downloadDocumentEntries(target);
  // 첨부 재무제표 표지는 본문(0번 파일)에 있다. 없으면 첨부 파일들을 차례로 훑는다.
  let parsed = null;
  let usedFile = null;
  for (let i = 0; i < entries.length; i++) {
    parsed = parseRepresentatives(toPlainText(entries[i].xml));
    if (parsed) {
      usedFile = entries[i].name;
      break;
    }
  }

  if (!parsed) {
    return {
      corp_code,
      조회됨: false,
      접수번호: target,
      출처: source,
      사유:
        "이 보고서의 본문에서 대표이사 표지 블록을 찾지 못했습니다. 표지 서식이 다른 문서일 수 " +
        "있으니, dart_get_document_text(mode=extract, keyword='대표이사')로 원문을 직접 확인하세요.",
    };
  }

  return {
    corp_code,
    조회됨: true,
    대표이사: parsed.names,
    인원수: parsed.names.length,
    직명: parsed.title,
    표지상_회사명: parsed.companyHint || null,
    출처: source || { 접수번호: target },
    파싱대상파일: usedFile,
    caveats: [
      "감사보고서·사업보고서 첨부 재무제표 **표지** 기재를 그대로 옮긴 값입니다. 그 보고서 작성 시점 기준이므로, 이후의 변동은 반영되지 않습니다.",
      "각자대표인지 공동대표인지는 표지에 기재되지 않습니다. 공동대표는 상법상 등기사항이므로 등기부등본으로만 확정됩니다(등기가 없으면 각자대표가 원칙).",
      "취임·퇴임일도 표지에 없습니다. 연도별 보고서의 표지를 비교하면 변동이 일어난 구간만 좁힐 수 있습니다.",
      "DART 기업개황(ceo_nm)·금융위 기업기본정보(enpRprFnm)의 대표자명은 회사가 적은 글자 그대로라, 대표이사가 여러 명이어도 1명만 적힌 회사가 있습니다. 회사 식별에는 그 값을 쓰고, 대표이사를 문서에 기재할 때는 이 도구의 명단을 쓰세요.",
    ],
  };
}
