// parseRepresentatives 단위 검증.
// 입력은 이 대화에서 DART 원문 조회로 **실제로 관측한** 표지 문자열이다(지어낸 값 아님).
// 네트워크·자격증명 없이 파싱 로직만 검증한다.
import { parseRepresentatives } from "../lib/representatives.js";

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
for (const c of CASES) {
  const got = parseRepresentatives(c.input);
  const names = got ? got.names : null;
  const ok = JSON.stringify(names) === JSON.stringify(c.expect);
  console.log(`${ok ? "  OK " : "  !! "} ${c.label}`);
  if (!ok) console.log(`       기대 ${JSON.stringify(c.expect)} / 실제 ${JSON.stringify(names)}`);
  ok ? pass++ : fail++;
}
console.log(`\n통과 ${pass} / 실패 ${fail} (전체 ${CASES.length})`);
process.exit(fail ? 1 : 0);
