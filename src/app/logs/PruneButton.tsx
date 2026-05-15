'use client';

import { useTransition } from 'react';
import { pruneOldLogsAction } from './actions';

export function PruneButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm('30일 이전 로그를 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
        startTransition(() => {
          pruneOldLogsAction();
        });
      }}
      className="px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950 text-sm disabled:opacity-50"
    >
      {pending ? '삭제 중…' : '30일 이전 로그 삭제'}
    </button>
  );
}
