# dart-mcp

OpenDART(금융감독원 전자공시시스템) 오픈API를 감싼 MCP 서버입니다. 인증키는 URL이 아니라
Vercel 환경변수(`DART_API_KEY`)로만 보관하므로, 이 MCP의 엔드포인트 URL을 다른 사람과
공유해도 인증키는 노출되지 않습니다.

## 배경

기존에 연결해서 쓰던 DART MCP는 제3자(마켓플레이스) 호스팅 서버로, 연결 URL 자체에
개인 인증키가 쿼리 파라미터로 포함되는 구조였습니다. 그 URL이 곧 인증수단이라 URL을
공유하는 순간 키도 함께 노출되는 문제가 있어, 다른 자체 구축 MCP(public-data-portal-mcp,
kipris-mcp, fss-corp-info-mcp)와 동일한 패턴(서버 env var 보관)으로 새로 만들었습니다.

## 엔드포인트

```
https://dart-mcp.vercel.app/api/mcp
```

(실제 배포 URL은 Vercel 프로젝트 생성 시 확정됩니다. 다르면 실제 URL로 교체하세요.)

인증 불필요 (서버가 자체적으로 `DART_API_KEY` 환경변수 보유).

## 환경변수 (Vercel)

```
DART_API_KEY=faba5fc9612a3ce6f7b87364ae43f50a464eb4c6
```

## 설계 방침

OpenDART 공식 API는 6개 카테고리(DS001~DS006)에 총 85개 엔드포인트로 구성되어 있습니다
(2026-07-25 opendart.fss.or.kr/guide 공식 문서 전수 확인). 이를 85개의 개별 MCP 도구로
노출하는 대신, fss-corp-info-mcp에서 효과가 좋았던 "카테고리 통합 + enum 파라미터" 패턴을
적용해 8개 도구로 재구성했습니다. 문서 원본 4자리 파일 다운로드(document.xml, corpCode.xml
원본, XBRL 원본파일 등 바이너리 응답)는 JSON 데이터 조회 목적과 맞지 않아 라이브 도구로는
제외했습니다(단, corpCode.xml은 회사명 검색 기능 내부 구현에 활용).

## 제공 도구 (8개)

1. **dart_search_disclosure** — 공시검색 (list.json). 공시유형·회사·날짜로 검색.
2. **dart_get_company_info** — 기업개황 (company.json). 대표자·설립일·업종 등.
3. **dart_search_corp_code** — 회사명/종목코드로 고유번호(corp_code) 검색.
   `data/corp_code.json`(GitHub Actions가 매일 자동 갱신하는 정적 파일, 아래 "corp_code
   정적 캐시 방식" 절 참고)에서 부분일치 검색.
4. **dart_get_periodic_report_item** — 정기보고서 주요정보 30종 통합(DS002). 최대주주·
   임원·직원 현황, 배당, 자기주식, 증자·감자, 감사인·감사의견, 이사·감사 보수 등.
   `corp_code + bsns_year + reprt_code` 필수.
5. **dart_get_financial_statement** — 정기보고서 재무정보 5종 통합(DS003). 단일/다중회사
   주요계정·재무지표, 단일회사 전체 재무제표.
6. **dart_get_equity_disclosure** — 지분공시 종합정보 2종 통합(DS004). 대량보유상황보고,
   임원·주요주주 소유보고. `corp_code`만 필요.
7. **dart_get_major_report_item** — 주요사항보고서 주요정보 36종 통합(DS005). 부도·회생·
   해산·유상증자·무상증자·감자·소송·전환사채·합병·분할·영업양수도·자기주식 등.
   `corp_code + bgn_de + end_de` 필수.
8. **dart_get_securities_report_item** — 증권신고서 주요정보 6종 통합(DS006). 지분증권·
   채무증권·증권예탁증권·합병·분할·주식교환이전.

## 검증 이력 (2026-07-25)

- 85개 엔드포인트 전체를 opendart.fss.or.kr/guide 공식 문서에서 bash curl로 실시간
  스크래핑하여 URL 슬러그를 확보(추측 없음). 카테고리별 파라미터 패턴도 공식 문서에서
  직접 확인:
  - DS002(정기보고서 주요정보): `corp_code + bsns_year + reprt_code`
  - DS003(정기보고서 재무정보): 위 3개 + 항목별 `idx_cl_code`(지표) 또는 `fs_div`(전체
    재무제표)
  - DS004(지분공시): `corp_code`만
  - DS005(주요사항보고서), DS006(증권신고서): `corp_code + bgn_de + end_de`
- 실제 인증키로 로컬 스모크테스트 완료: `dart_search_corp_code`(포니링크→corp_code
  00392691 확인, 기존 스킬의 하드코딩 값과 일치. 젬백스인베스트 corp_code 01915356도
  확인), `dart_get_company_info`(삼성전자), `dart_search_disclosure`(삼성전자 최근
  공시), `dart_get_periodic_report_item`(최대주주 현황), `dart_get_financial_statement`
  (단일회사 주요계정), `dart_get_equity_disclosure`(대량보유상황보고),
  `dart_get_major_report_item`(자기주식취득결정), `dart_get_securities_report_item`
  (013 NODATA 정상 처리 확인) — 8개 도구 모두 실데이터로 확인.

## 발견한 quirk

- **corpCode.xml 파싱**: 실제 응답에 `<corp_eng_name>` 태그가 `<corp_name>`과
  `<stock_code>` 사이에 존재해서, 태그 순서 고정 정규식으로 파싱하면 전부 매치 실패함
  (최초 구현에서 실제로 발생 — 모든 검색이 0건으로 나왔음). `<list>...</list>` 블록
  단위로 나눈 뒤 태그별로 독립 추출하도록 수정.
- **status 013 = NODATA**: OpenDART 공통 관례상 013(조회된 데이터가 없습니다)은 실패가
  아니라 정상 무응답이므로 `{totalCount:0, items:[]}`로 정규화.
- DART API는 이 생태계의 다른 공공데이터포털 API들과 달리 응답 스키마가 매우 일관적
  (`{status, message, list?}` 단일 구조)이라 별도의 복잡한 정규화 분기가 필요 없었음.
- **corpCode.xml 대용량 다운로드는 Vercel에서 요청 시점에 하면 안 됨**: 처음에는
  `dart_search_corp_code` 요청이 올 때마다 opendart.fss.or.kr에서 corpCode.xml(zip,
  3.5MB)을 직접 받아와 24시간 TTL로 캐싱하는 방식이었는데, 로컬(약 1.2초)과 달리 Vercel
  프로덕션(iad1 리전)에서는 응답 헤더는 1초 내로 오면서도 본문 다운로드가 60초 제한을
  넘기며 타임아웃되는 문제가 실제로 발생했다(2026-07-25 Vercel Runtime Logs로 확인).
  동일 호스트의 소용량 JSON API 호출들은 정상 작동했으므로 대용량 파일 전송에 한정된
  스로틀링으로 추정. 아래 "corp_code 정적 캐시 방식" 절의 구조로 전환해 해결.

## corp_code 정적 캐시 방식 (2026-07-25 도입)

`dart_search_corp_code`는 더 이상 요청 처리 중에 opendart.fss.or.kr을 직접 호출하지
않습니다. 대신:

1. `scripts/refresh-corp-code.mjs`가 corpCode.xml을 받아 `corp_code`/`corp_name`/
   `stock_code`/`modify_date`만 추린 `data/corp_code.json`(약 10MB, 11만+ 건)을 생성.
2. `.github/workflows/refresh-corp-code.yml`이 매일 02:00 KST에 이 스크립트를 자동
   실행하고, 내용이 바뀌었을 때만 `data/corp_code.json`을 커밋·push (krx-regulation-mcp의
   주간 재크롤링 → 자동 커밋 패턴과 동일). push되면 Vercel이 자동 재배포.
3. `lib/dart_client.js`의 `loadCorpCodeList()`는 이 정적 파일을 `fs.readFileSync`로
   읽기만 함 — 외부 네트워크 호출이 전혀 없어 타임아웃이 구조적으로 발생할 수 없음.

**필요 설정**: GitHub 저장소 Settings > Secrets and variables > Actions에 `DART_API_KEY`
시크릿을 등록해야 자동 갱신 워크플로가 동작합니다(Vercel 환경변수와는 별개로 등록 필요).
수동 갱신은 저장소 Actions 탭에서 "Refresh corp_code.json" 워크플로를 "Run workflow"로
즉시 실행하거나, 로컬에서 `DART_API_KEY=xxx npm run refresh-corp-code`로도 가능합니다.

corp_code는 신규 법인 등록·상장·상호변경 때만 바뀌는 정적 성격의 데이터라 최대 1일
지연은 실무상 문제되지 않을 것으로 판단했습니다(당일 신규 상장 종목을 그날 즉시 검색해야
하는 경우가 아니라면).

## 성능 개선 이력 (2026-08-04)

기존 제3자 호스팅 DART MCP와의 실측 비교(회사검색 6종 질의 + 재무제표·공시검색 응답 크기)
결과를 바탕으로 다음을 개선했다.

1. **회사명 검색 고도화** (`dart_search_corp_code`):
   - 약칭 별칭 사전 추가(삼전→삼성전자, 하닉→SK하이닉스, 현대차→현대자동차, LG엔솔 등
     20여 개). 별칭 일치 회사는 무조건 최상단.
   - 오타 보정 추가: 질의를 자모로 분해해 편집거리 1(5음절 이상은 2)까지 허용
     ("삼성전지"→삼성전자·삼성전기, "포니링쿠"→포니링크). 정확일치 상장사가 없을 때만
     작동하며 상장사(약 4천 건) 우선 검사 후 필요시에만 전체 검사 — 추가 지연 실측
     60~90ms 수준.
   - 초성 질의를 부분수열 매칭에도 적용("ㅍㄴㄹㅋ"→포니링크).
   - 동률 정렬 개선: 매치 시작위치 → 회사명 길이 순. ("삼성전자" 질의 시 삼성전자가
     삼성전자판매보다 먼저)
   - 기준 비교: 기존 제3자 MCP는 종목코드 6자리 검색이 아예 실패하고("005930" → 0건)
     종목코드 앞자리 0이 잘린 채 표시되는(5930, 64800) 버그가 있음 — 본 서버는 둘 다 정상.
2. **응답 토큰 다이어트**: 원본 JSON 전문 덤프를 기본 응답에서 제거하고 `include_raw`
   파라미터(기본 false) 뒤로 옮김. 재무제표는 연결/개별 섹션 분리 + 핵심 5컬럼만 표시.
   리스트 응답은 전 행 동일값 컬럼을 "공통:" 한 줄로 추출하고 빈 컬럼 제거.
   실측: 삼성전자 FY2025 주요계정 응답 28,488자 → 2,694자(약 1/10.6), 공시검색 응답도
   제3자 MCP(약 700자)보다 작은 428자.
3. **corp_code 정적 캐시 신선도 감시**: 데이터가 3일 이상 오래되면 검색 응답에 경고 문구
   자동 표시(자동 갱신 워크플로 중단을 즉시 인지). refresh 스크립트에 240초 타임아웃 +
   4회 재시도(백오프) + zip 시그니처 검증 + "건수 10% 이상 감소 시 갱신 중단" 안전장치
   추가 — 데이터센터 IP에서 corpCode.xml 다운로드가 503 또는 15KB/s 수준으로 스로틀링되는
   현상이 클라우드 환경에서 실측 재현됐기 때문(GitHub Actions 러너도 데이터센터 IP).
4. **XBRL 표준계정과목체계 추가**: `dart_get_financial_statement`의 `infoType=xbrl_taxonomy`
   (sj_div만 필수, corp_code 불필요). 이로써 제3자 MCP 대비 도구 커버리지 열위 항목 해소.

## 현재 상태 (2026-07-25)

코드 완성, 로컬 스모크테스트 완료, GitHub push, Vercel 배포, corp_code 성능 문제
해결까지 완료했습니다. 다만 사용자 요청으로 **Settings 등록·관련 스킬
(dart-disclosure-lookup) 전환은 아직 보류** 중입니다. 기존에 쓰던 제3자 호스팅 DART MCP는
그대로 유지되며 이 서버 완성과 무관하게 정상 작동합니다. 실제로 전환하고 싶을 때 Settings에
엔드포인트 등록 → dart-disclosure-lookup 스킬 업데이트 순으로 진행하면 됩니다.

## 향후 개선 후보

- **회사명 검색 랭킹 고도화**: 현재 `dart_search_corp_code`는 상장 여부(종목코드 유무)만
  가중치로 반영하는데, corpCode.xml에는 시가총액·거래대금 같은 "인지도" 정보가 없어서
  동률 상장사들 사이에서 원하는 회사가 항상 1위로 뜨지는 않는다(예: "삼전" 검색 시 삼성전기·
  삼화전기 등과 삼성전자가 뒤섞임, 2026-07-25 확인). KRX 시가총액/거래대금 데이터
  (`market-macro-data-lookup` 스킬의 KRX API 또는 별도 KRX MCP)를 결합해서 랭킹에
  추가 가중치를 주면 기존 제3자 DART MCP 수준의 검색 품질에 더 가까워질 것으로 예상.
- **응답 포맷 세밀화**: 현재 `lib/format.js`는 모든 필드를 보여주는 범용 마크다운 표
  방식인데, 자주 쓰는 도구(최대주주현황, 배당, 임원현황 등)부터 기존 제3자 MCP처럼
  꼭 필요한 열만 골라 보여주도록 도구별 커스텀 컬럼 선택 로직을 추가하면 가독성이
  더 좋아질 것.
- **문서 원본파일 지원**: 공시서류 원본파일(document.xml), XBRL 재무제표 원본파일
  (fnlttXbrl.xml) 다운로드는 바이너리 응답이라 이번 범위에서 제외했음. 필요해지면
  Base64 인코딩 등으로 별도 도구를 추가할 수 있음.

## 이 서버가 하지 않는 것

- 공시서류 원본파일(document.xml), corpCode.xml 원본 파일, XBRL 재무제표 원본파일 등
  바이너리/파일 다운로드 자체를 반환하는 기능. corpCode.xml만 예외적으로 서버 내부에서
  회사명 검색 인덱스로 활용.
- 개인정보 성격의 세부 항목(이사·감사 개인별 보수 5억 이상 등)은 원본 API가 제공하는
  그대로 반환하되, 별도 마스킹/가공은 하지 않음.
