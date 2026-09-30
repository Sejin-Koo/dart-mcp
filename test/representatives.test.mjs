// parseRepresentatives 단위 검증.
// 입력은 이 대화에서 DART 원문 조회로 **실제로 관측한** 표지 문자열이다(지어낸 값 아님).
// 네트워크·자격증명 없이 파싱 로직만 검증한다.
import { parseRepresentatives } from "../lib/representatives.js";
import { formatDartResult } from "../lib/format.js";

const COVER = (company, title, names) =>
  `첨부된 재무제표는 당사가 작성한 것입니다. \n ${company} ${title} ${names} \n 본점 소재지 : \n (도로명주소) \n 서울시 구로구 디지털로26길 43 \n (전 화) \n 02-2025-4999 \n 재 무 상 태 표 `;

const CASES = [
  // ── 실측 표지 (2026-09-30 DART 원문 조회)
  { label: "㈜비디 FY2025 — 3인",            input: COVER("주식회사 비디", "대표이사", "김기용, 독고세준, 조성우"), expect: ["김기용", "독고세준", "조성우"] },
  { label: "㈜비디 FY2023 — 3인(제3자 상이)", input: COVER("주식회사 비디", "대표이사", "김기용, 독고세준, 이상명"), expect: ["김기용", "독고세준", "이상명"] },
  { label: "지엘케이에쿼티인베스트 — 2인",    input: COVER("주식회사 지엘케이에쿼티인베스트", "대표이사", "김상재, 황정일"), expect: ["김상재", "황정일"] },
  { label: "에어테크엔지니어링 — 자간 벌어짐", input: COVER("에어테크엔지니어링 주식회사", "대표이사", "김 도 영"), expect: ["김도영"] },
  { label: "쿠팡 — 외국인 성명 3토큰",        input: COVER("쿠팡 주식회사", "대표이사", "로저스 해롤드 린"), expect: ["로저스 해롤드 린"] },
  { label: "삼성웰스토리 — 회사명 붙여쓰기",  input: COVER("삼성웰스토리주식회사", "대표이사", "송규종"), expect: ["송규종"] },
  { label: "메가존클라우드 — 1인",            input: COVER("메가존클라우드 주식회사", "대표이사", "이주완"), expect: ["이주완"] },

  // ── 표기 변형 (서식이 흔들려도 견디는지)
  { label: "자간 벌어진 '본 점'",             input: COVER("주식회사 가나", "대표이사", "홍길동"). replace("본점", "본 점"), expect: ["홍길동"] },
  { label: "직명이 대표집행임원",             input: COVER("주식회사 다라", "대표집행임원", "김철수, 이영희"), expect: ["김철수", "이영희"] },
  { label: "쉼표 없이 가운뎃점",              input: COVER("주식회사 마바", "대표이사", "박민수·최지훈"), expect: ["박민수", "최지훈"] },

  // ── 음성 사례 (표지가 아닌 곳을 표지로 오인하면 안 됨)
  { label: "[음성] 주석의 연대보증 문장",     input: "당사의 차입금등과 관련하여 당사 대표이사로부터 지급(연대)보증을 제공받고 있습니다. 본점 이전 계획은 없습니다.", expect: null },
  { label: "[음성] 표지 블록 없음",           input: "감사의견 우리는 주식회사 비디의 재무제표를 감사하였습니다. 대표이사 귀하", expect: null },
];

let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  console.log(`${ok ? "  OK " : "  !! "} ${label}`);
  if (!ok && extra) console.log(`       ${extra}`);
  ok ? pass++ : fail++;
};

console.log("── 성명 파싱");
for (const c of CASES) {
  const got = parseRepresentatives(c.input);
  const names = got ? got.names : null;
  check(
    c.label,
    JSON.stringify(names) === JSON.stringify(c.expect),
    `기대 ${JSON.stringify(c.expect)} / 실제 ${JSON.stringify(names)}`
  );
}

// ── 표지상_회사명: 직전 문장이 섞여 들어오지 않아야 한다
// (실측 불량값: '2024년 12월 31일 까지 "첨부된 재무제표는 당사가 작성한 것입니다." 주식회사 비디')
console.log("\n── 표지상 회사명");
const COMPANY_CASES = [
  ["주식회사 비디", "주식회사 비디"],
  ["에어테크엔지니어링 주식회사", "에어테크엔지니어링 주식회사"],
  ["삼성웰스토리주식회사", "삼성웰스토리주식회사"],
  ["㈜비디", "㈜비디"],
  ["쿠팡 주식회사", "쿠팡 주식회사"],
];
for (const [company, expect] of COMPANY_CASES) {
  const got = parseRepresentatives(COVER(company, "대표이사", "홍길동"));
  check(
    `${company} → ${expect}`,
    got && got.companyHint === expect,
    `실제 ${JSON.stringify(got && got.companyHint)}`
  );
}

// ── 마크다운 렌더: 중첩 객체·객체 배열이 "[object Object]"로 찍히지 않아야 한다
console.log("\n── 중첩 값 렌더");
const NESTED = {
  corp_code: "01447800",
  조회됨: true,
  대표이사: ["김기용", "독고세준", "조성우"],
  인원수: 3,
  상세: [
    { 성명: "김기용", 직위: "대표이사", 재직기간: "2017.03.28~현재", 임기만료일: "2027.03.27" },
    { 성명: "독고세준", 직위: "대표이사", 재직기간: "2021.03.26~현재", 임기만료일: "2027.03.25" },
  ],
  출처: { 경로: "사업보고서 임원현황", 사업연도: "2024", 접수번호: "20250331001234" },
  caveats: [
    "사업보고서 임원현황 기재 기준입니다. 해당 사업연도 말 시점이므로 이후의 변동은 반영되지 않습니다.",
    "각자대표인지 공동대표인지는 임원현황에 기재되지 않습니다.",
  ],
};
const md = formatDartResult(NESTED);
check("[object Object]가 없다", !md.includes("[object Object]"));
check("객체 배열이 하위 표로 나온다", md.includes("**상세**") && md.includes("2017.03.28~현재"));
check("중첩 객체가 한 줄로 펼쳐진다", md.includes("접수번호: 20250331001234"));
check("긴 배열은 목록으로 떨어진다", /\*\*유의사항\*\*\n\n- /.test(md));
check("짧은 배열은 셀에 그대로 들어간다", md.includes("김기용 · 독고세준 · 조성우"));

// 값에 든 파이프가 열을 깨뜨리지 않아야 한다
check(
  "셀 안의 | 는 이스케이프된다",
  formatDartResult({ 비고: "가|나" }).includes("가\\|나"),
  formatDartResult({ 비고: "가|나" })
);

console.log(`\n통과 ${pass} / 실패 ${fail} (전체 ${pass + fail})`);
process.exit(fail ? 1 : 0);
