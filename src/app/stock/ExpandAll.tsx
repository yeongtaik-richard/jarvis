'use client';

/**
 * 테마 행 전체 펼치기·닫기.
 *
 * 보드의 다른 상태(기간 선택)는 전부 링크라 서버가 다시 렌더한다. 이것만 클라이언트인
 * 이유는 **펼침이 URL에 남을 상태가 아니기** 때문이다. `?open=1` 같은 걸로 처리하면
 * 버튼 한 번에 페이지가 다시 로드되고 스크롤 위치가 날아가는데, 20줄짜리 목록에서
 * 그건 쓰기 힘들다.
 *
 * `<details>`를 직접 건드린다. React 상태로 올리면 모든 행이 제어 컴포넌트가 되어
 * 개별 토글까지 상태로 관리해야 하는데, 네이티브 `<details>`가 이미 하는 일이다.
 * 대상은 `data-theme-row`가 붙은 것만 — 펼친 패널 안에 다른 `<details>`가 생겨도
 * 같이 열리지 않게 범위를 좁혀둔다.
 */
export function ExpandAll() {
  const setAll = (open: boolean) => {
    document
      .querySelectorAll<HTMLDetailsElement>('details[data-theme-row]')
      .forEach((d) => {
        d.open = open;
      });
  };
  const cls =
    'px-2 py-1 rounded border border-zinc-200 text-zinc-500 hover:bg-zinc-50 ' +
    'dark:border-zinc-800 dark:hover:bg-zinc-900';
  return (
    <span className="ml-auto flex gap-1">
      <button type="button" className={cls} onClick={() => setAll(true)}>
        전체 펼치기
      </button>
      <button type="button" className={cls} onClick={() => setAll(false)}>
        전체 닫기
      </button>
    </span>
  );
}
