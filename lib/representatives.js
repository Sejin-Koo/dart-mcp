// dart-mcp / lib/representatives.js
// 대표이사 명단 조회 — 감사보고서·사업보고서 첨부 재무제표 **표지**에서 추출한다.
//
// 왜 이 모듈이 필요한가
//   DART 기업개황(`company`)의 ceo_nm과 금융위 기업기본정보의 enpRprFnm은 **단일 문자열
//   필드**라, 대표이사가 여러 명이어도 1명만 반환한다. 그래서 그 값만 보고 보고서에
//   "대표이사 OOO"라고 적으면 공동·각자대표가 통째로 누락된다(2026-09-30 실측: ㈜비디는
//   3인인데 두 소스 모두 1인만 반환).
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

import { searchDisclosure } from "./dart_client.js";
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
      const companyHint = before.replace(/\s+/g, " ").trim().split(/[\n。]/).pop().trim();

      hits.push({ title: word, names, companyHint, index: m.index });
    }
  }

  if (hits.length === 0) return null;
  // 같은 표지가 여러 번 잡히면 가장 앞선 것을 쓴다(첨부 재무제표 표지가 본문 앞쪽에 있다).
  hits.sort((a, b) => a.index - b.index);
  return hits[0];
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
    if (list.length > 0) {
      return { pblntf_ty, report: list[0], candidates: list };
    }
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
      "DART 기업개황(ceo_nm)·금융위 기업기본정보(enpRprFnm)는 대표자 필드가 단일값이라 여러 명이어도 1명만 반환합니다. 회사 식별에는 그 값을 쓰고, 대표이사를 문서에 기재할 때는 이 도구의 값을 쓰세요.",
    ],
  };
}
