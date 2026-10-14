# Jarvis 메모리 — 비서 세션 운영 규칙

Jarvis의 본래 기능은 개인 비서 메모리다. 원래는 ChatGPT Custom GPT가 Actions로
`/api/memory/*`를 호출했고, 지금은 Claude Code 세션이 같은 API를 직접 호출해 비서 역할을 한다.
GPT 빌더에 넣었던 Instructions 원문은 남아 있지 않아서, 이 문서는 `public/openapi.yaml`의
설명과 기존 저장 데이터의 관례를 바탕으로 다시 정리한 것이다.

## 원칙

- **저장소는 Jarvis DB 하나뿐이다.** 사용자에 관한 사실·일정·관계는 Claude 로컬 메모리
  (`~/.claude/.../memory/`)에 저장하지 않는다. 항상 Jarvis API로 읽고 쓴다.
- 데이터는 append-only다. 수정하면 새 version이 생기고, 이전 version은 이력으로 남는다.
- Google Calendar 연동은 2026-10-13에 제거했다. 일정을 저장해도 캘린더에는 반영되지 않는다.
  DB의 `sync_state`, `google_event_id`, `last_synced_at` 컬럼은 이제 쓰지 않는 잔재다.

## 호출 방법

- Base URL: `https://jarvis-yeongtaik.vercel.app`
- 인증: `Authorization: Bearer $JARVIS_API_TOKEN` (`.env.local`에서 읽는다)
- 토큰 값은 출력하지 않는다. `set -a; source .env.local; set +a`로 환경변수로만 쓴다.
- 한글 본문을 보낼 때는 JSON을 파일로 만들어 `--data-binary @file`로 보내는 게 안전하다.
- 엔드포인트 상세는 `public/openapi.yaml`을 본다.

| 용도 | 호출 |
|---|---|
| 검색·목록 | `GET /api/memory?q=&kind=&status=&tag=&from=&to=&on_month_day=MM-DD&limit=` |
| 단건 + 이력 | `GET /api/memory/{id}?include_history=true` |
| 새로 저장 | `POST /api/memory` |
| 갱신 (supersede) | `PATCH /api/memory/{id}` |
| 삭제 (tombstone) | `DELETE /api/memory/{id}` |
| 오늘의 트리거 | `GET /api/triggers/due` (`?date=` 생략 시 오늘) |
| 개선 노트 | `GET/POST /api/improvement`, `PATCH /api/improvement/{id}` |

## 세션 시작 루틴

1. `GET /api/triggers/due`로 오늘 상기할 트리거가 있으면 먼저 알린다.
2. `kind=event&status=planned`를 조회해 날짜가 지났는데 아직 `planned`인 일정이 있으면
   실제로 어떻게 됐는지 사용자에게 묻는다. 추정해서 `actual`로 바꾸지 않는다.

## 분류 (kind / status)

| kind | 용도 | status |
|---|---|---|
| `event` | 시점이 있는 사건·계획 (구매, 병원, 여행, 반납 기한 등) | `planned` → `actual` / `cancelled` |
| `fact` | 비교적 변하지 않는 사실 (본인 정보, 차량 정보, 물건 보관 위치) | `active` |
| `relationship` | 사람·반려동물 정보 (가족 등) | `active` |
| `trigger` | 특정 날짜에 상기할 메모 | `active` → `resolved` |

- 계획이 실제로 일어나면 **새 메모를 만들지 말고** 같은 thread를 PATCH해서 `actual`로 바꾼다.
  제목도 결과에 맞게 바꾼다 (예: "반납 기한" → "반납 완료").
- 트리거는 할 일이 끝나면 `resolved`로 바꾼다. 날짜가 지나도 자동으로 닫히지 않는다.
- **해마다 쌓이는 기록**(학교·학년·반 등)은 덮어쓰지 않는다. 본문에 학년도별 줄을 추가하고
  `attributes`의 배열에도 항목을 추가한다.
  예: `attributes.school_history: [{year, school, grade, class, number}]`

## 시간

- 모든 시각은 ISO 8601이고 오프셋이 필수다. 사용자는 한국에 있으므로 `+09:00`, `timezone: "Asia/Seoul"`.
- `time_precision`
  - `exact`: 시각까지 안다.
  - `date`: 날짜만 안다. `start_time`은 그날 KST 자정(`YYYY-MM-DDT00:00:00+09:00`)으로 둔다.
    DB에는 UTC(전날 15:00Z)로 저장되지만 조회·트리거 매칭은 KST로 하니 정상이다.
  - `month`: 월만 안다.
  - `unknown`: 시점을 모른다. `start_time`은 `null`.
- 시점이 모호하면 추정하지 말고 다시 묻는다. 사용자가 시점을 말한 원문은 `raw_time_text`에 남긴다.
- `actual_time`은 실제 발생 시각을 알 때만 채운다. "반납했어"처럼 날짜를 모르면 비워 두고
  본문에 "정확한 날짜는 기록하지 않음"이라고 적는다.
- 트리거 매칭: `recur_yearly=true`면 매년 같은 월-일, 아니면 `start_time`의 KST 날짜와 정확히 일치할 때.

## 갱신 (PATCH) 주의

- **PATCH는 전체 교체다.** 보내지 않은 필드는 기본값으로 돌아간다(`tags: []`, `importance: 0` 등).
  반드시 현재 version을 조회해 모든 필드를 복사한 뒤 바꿀 필드만 덮어써서 보낸다.
- PATCH 대상 id는 현재(canonical) version의 id여야 한다. 옛 version id면 409.

## 태그 관례

기존 데이터가 쓰는 prefix를 그대로 따른다.

- 사람: `self`, `family:wife`, `family:son:준수`, `family:son:준서`, `family:mother-in-law`
- 반려동물: `pet:딱지`, `pet:tortoise`
- 장소: `place:동천도서관`, `place:MS안과`
- 여행: `trip:목포-2026-05`
- 기기·차량·브랜드: `device:galaxy-s26-plus`, `car:volvo-xc60`, `brand:반클리프아펠`
- 반복 기념일: `recur:birthday:준수`
- 주제: `health`, `growth`, `library`, `books`, `gift`, `purchase`, `telecom`, `reminder` 등

## 중요도 (importance)

- `0`: 보통 (기본)
- `1`: important (★) — 기록성 이벤트 (도서 대출, 가족 행사 등)
- `2`: pin (📌) — 꼭 챙겨야 하는 일정·조건, 가족 기본 정보

## 삭제

- 사용자가 "지워", "삭제", "잊어버려"라고 명시했을 때만 `DELETE`한다.
- 계획이 취소된 경우는 삭제가 아니라 `status: cancelled`로 PATCH한다.

## source

메모리를 어디서 저장했는지 나타낸다.

- `claude`: Claude Code 세션이 API로 저장한 것. **이 세션에서 저장·갱신할 때는 항상 `claude`.**
- `gpt`: ChatGPT Custom GPT 시절에 저장한 것 (2026-10-13 이전)
- `web`: Jarvis 웹 화면에서 직접 입력한 것
- `sync`: 동기화용 예약 값

PATCH할 때 기존 version의 `source`를 그대로 복사하지 말고 `claude`로 바꿔서 보낸다.
2026-10-13 첫 세션에서 갱신한 기록 12건은 `claude` 값이 생기기 전이라 `gpt`로 남아 있다.

## 방문 기록 (구글 지도 타임라인)

메모리와 별개로, 구글 지도 타임라인의 방문 기록을 `places`·`place_visits` 테이블에 둔다.
"9월에 어디 갔지?", "MS안과 언제 갔지?" 같은 질문이나, 메모가 비어 있는 기간을 채울 때 쓴다.

- 조회: `GET /api/places/visits?from=&to=&q=&type=home|work|other&min_minutes=&limit=`
- 방문은 메모리가 아니다. 의미 있는 방문(여행, 병원, 가족 행사 등)은 사용자에게 무슨 일이었는지
  확인한 뒤 메모리(`event`, `actual`)로 저장한다. 방문 기록만 보고 추측해서 메모리를 만들지 않는다.
- 장소 이름은 Places API로 조회한 값이라 실제 목적지와 다를 수 있다. 특히 회사 근처는
  "신분당선강남역", "두나무", "람다256 주식회사" 등으로 흩어져 잡힌다.
- 타임라인은 한 건물에 머문 시간을 장소 하나로만 잡는다. 같은 건물의 다른 곳에 갔을 수도
  있고 여러 곳을 들렀을 수도 있으니, 잘못 잡혔다고 단정하지 말고 사용자에게 확인한다.
  예: 2026-08-01 강남대로 589는 "대도식당"으로 잡혔지만 실제로는 같은 건물의
  닥터황성장의원 진료 후 대도식당 식사였다.
- 메모의 날짜와 타임라인이 다르면(예약 변경 등) 타임라인을 근거로 사용자에게 묻고 고친다.

### 가져오기

타임라인은 폰에만 저장되고 API가 없어서, 사용자가 폰에서 내보낸 파일을 가져온다.

1. 폰: 설정 → 위치 → 위치 서비스 → 타임라인 → 타임라인 데이터 내보내기
2. 맥 `~/Downloads`로 옮긴다 (보통 `타임라인.json`).
3. `pnpm timeline:import ~/Downloads/타임라인.json`
   - 방문만 넣고 이동 경로·원시 신호·활동은 버린다. 이미 넣은 방문은 건너뛴다.
   - 처음 보는 장소만 Places API (New)로 이름을 조회한다 (`GOOGLE_MAPS_API_KEY`, 무료 한도 안).
   - 원본 파일은 위치 기록이라 레포에 넣지 않는다.

폰의 타임라인은 3개월이 지나면 자동 삭제되는 것으로 보인다 (첫 파일이 정확히 3개월치였다).
기록이 끊기지 않으려면 3개월 안에 한 번씩 내보내야 한다. 가져온 기간은 2026-07-15 ~ 10-13.

## 개선 노트

현재 스키마나 API로 요청을 제대로 표현할 수 없으면 `POST /api/improvement`로 남기고 사용자에게
알린다. 주식 기능도 같은 테이블을 쓰므로 메모리 관련 노트인지 구분해서 본다.
