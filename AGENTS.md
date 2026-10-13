<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Features

## Personal assistant memory (본체)

Jarvis의 원래 기능. 사용자가 일정·사실·가족 정보 등을 말하면 Jarvis API(`/api/memory/*`,
`/api/triggers/due`)로 저장·조회하는 비서 역할을 한다. 사용자 정보는 Claude 로컬 메모리가
아니라 **Jarvis DB에만** 저장한다. 메모리를 읽거나 쓰기 전에 반드시
[docs/memory.md](docs/memory.md)를 읽을 것.

## Stock reference-info aggregator

SK하이닉스(`000660`) 매매 참고정보 대시보드 (`/stock`, `src/app/stock`,
`src/app/api/stock`, `src/lib/kis-marketdata.ts`, `scripts/collect-stock.ts`).
**자동매매·수익예측이 아니라** 참고정보를 모아 보여주는 기능이고, buy/sell/target/
rating을 두지 않는 정직성 제약이 핵심이다. 이 영역을 건드리기 전에 반드시
[docs/stock.md](docs/stock.md)를 읽을 것.
