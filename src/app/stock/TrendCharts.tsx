'use client';

/**
 * /stock 추이 차트. 라이브러리 없이 인라인 SVG로 그린다 (프로젝트에 차트 의존성 없음).
 * 색 토큰은 globals.css의 `.viz` — 부호 색은 국내 관례(빨강=순매수·상승, 파랑=반대)이고
 * 부호는 0선 위/아래 위치로도 중복 인코딩된다. 값은 툴팁 없이도 카드의 표(표로 보기)에서
 * 전부 읽을 수 있어야 한다 — 툴팁은 보조 수단이지 유일한 경로가 아니다.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { korQty, moneyMil, shortDate, won } from './format';

export type ClosePoint = { date: string; close: number };
export type FlowPoint = {
  date: string;
  foreign: number;
  institution: number;
  individual: number;
};

const PAD_L = 44;
const PAD_R = 10;

/** 컨테이너 실측 폭. 서버 렌더/측정 전에는 320px로 그린다(하이드레이션 동일). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setW(box.width);
    });
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w || 320] as const;
}

/**
 * 3개 안팎의 깔끔한 눈금. 후보 배수(1/2/2.5/5/10)를 훑어 눈금이 2개 미만으로 떨어지면
 * 한 단계 촘촘한 배수로 내려간다 — 범위에 따라 눈금이 하나만 남는 걸 막는다.
 */
function niceTicks(lo: number, hi: number, count = 3): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 2.5, 5, 10]
    .map((m) => m * mag)
    .filter((s) => s >= raw / 2)
    .sort((a, b) => a - b);
  for (const step of steps) {
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    if (out.length >= 2 && out.length <= count + 1) return out;
  }
  return [lo + (hi - lo) / 2];
}

/** 데이터 끝만 4px 둥글고 baseline 쪽은 각진 막대. */
function barPath(cx: number, w: number, zeroY: number, valY: number): string {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const r = Math.min(4, w / 2, Math.abs(valY - zeroY));
  const s = valY < zeroY ? 1 : -1; // 위로 자라면 1
  return [
    `M ${x0} ${zeroY}`,
    `L ${x0} ${valY + r * s}`,
    `Q ${x0} ${valY} ${x0 + r} ${valY}`,
    `L ${x1 - r} ${valY}`,
    `Q ${x1} ${valY} ${x1} ${valY + r * s}`,
    `L ${x1} ${zeroY} Z`,
  ].join(' ');
}

/** 포인터/키보드로 고른 인덱스 상태 + 핸들러. */
function useHoverIndex(count: number) {
  const [i, setI] = useState<number | null>(null);
  const pick = (x: number, toIndex: (x: number) => number) => {
    setI(Math.min(count - 1, Math.max(0, toIndex(x))));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') return setI(null);
    const cur = i ?? count - 1;
    setI(Math.min(count - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))));
  };
  return { i, setI, pick, onKeyDown };
}

/** 툴팁은 마크를 가리지 않는 쪽에 붙인다 (`place`). 값은 표로 보기에도 그대로 있다. */
function Tooltip({
  left,
  width,
  place,
  children,
}: {
  left: number;
  width: number;
  place: 'top' | 'bottom';
  children: React.ReactNode;
}) {
  const TW = 148;
  const x = Math.min(Math.max(left - TW / 2, 0), Math.max(0, width - TW));
  return (
    <div
      className={`pointer-events-none absolute z-10 rounded-md border border-zinc-200 bg-white/95 px-2 py-1.5 text-[11px] shadow-sm dark:border-zinc-700 dark:bg-zinc-900/95 ${
        place === 'top' ? 'top-0' : 'bottom-0'
      }`}
      style={{ left: x, width: TW }}
    >
      {children}
    </div>
  );
}

const focusRing =
  'outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:rounded';

export function CloseTrendChart({ points }: { points: ClosePoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { i: hover, setI, pick, onKeyDown } = useHoverIndex(points.length);

  const PLOT_H = 128;
  const AXIS_H = 16;
  const padT = 8;
  const padB = 6;
  const plotW = Math.max(40, width - PAD_L - PAD_R);
  const innerH = PLOT_H - padT - padB;

  const closes = points.map((p) => p.close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const ticks = niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0]!);
  const yMax = Math.max(hi, ticks[ticks.length - 1]!);
  const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const x = (idx: number) =>
    PAD_L + (points.length < 2 ? plotW / 2 : (idx * plotW) / (points.length - 1));
  const step = points.length < 2 ? plotW : plotW / (points.length - 1);

  const line = points.map((p, idx) => `${idx ? 'L' : 'M'} ${x(idx)} ${y(p.close)}`).join(' ');
  const area = `${line} L ${x(points.length - 1)} ${padT + innerH} L ${x(0)} ${padT + innerH} Z`;

  const last = points[points.length - 1]!;
  const first = points[0]!;
  const up = last.close >= first.close;
  const accent = up ? 'var(--viz-up)' : 'var(--viz-down)';

  const at = hover === null ? null : points[hover]!;
  const prev = hover === null || hover === 0 ? null : points[hover - 1]!;
  const dayChange = at && prev ? ((at.close - prev.close) / prev.close) * 100 : null;

  // x축은 처음/중간/끝만 — 22개 날짜를 다 찍으면 읽히지 않는다.
  const tickIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (v, idx, a) => a.indexOf(v) === idx,
  );

  return (
    <div ref={ref} className="viz relative">
      {at && (
        <Tooltip
          left={x(hover!)}
          width={width}
          // 점이 위쪽에 있으면 툴팁을 아래로 — 선을 가리지 않게.
          place={y(at.close) < PLOT_H / 2 ? 'bottom' : 'top'}
        >
          <div className="text-zinc-500">{at.date}</div>
          <div className="font-medium tabular-nums">{won(at.close)}</div>
          {dayChange !== null && (
            <div className="tabular-nums text-zinc-500">
              전일 대비 {dayChange >= 0 ? '+' : ''}
              {dayChange.toFixed(2)}%
            </div>
          )}
        </Tooltip>
      )}
      <svg
        width="100%"
        height={PLOT_H + AXIS_H}
        viewBox={`0 0 ${width} ${PLOT_H + AXIS_H}`}
        className={focusRing}
        role="img"
        aria-label={`최근 ${points.length}거래일 종가 추이. 값은 아래 표로 보기에 있습니다.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setI(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--viz-grid)"
              strokeWidth="1"
            />
            <text
              x={PAD_L - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--viz-muted)"
              className="tabular-nums"
            >
              {korQty(t)}
            </text>
          </g>
        ))}

        <path d={area} fill={accent} fillOpacity="0.1" />
        <path
          d={line}
          fill="none"
          stroke="var(--viz-line)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={padT}
            y2={padT + innerH}
            stroke="var(--viz-axis)"
            strokeWidth="1"
          />
        )}

        <circle
          cx={x(points.length - 1)}
          cy={y(last.close)}
          r="4"
          fill={accent}
          stroke="var(--viz-surface)"
          strokeWidth="2"
        />
        {at && (
          <circle
            cx={x(hover!)}
            cy={y(at.close)}
            r="4"
            fill="var(--viz-line)"
            stroke="var(--viz-surface)"
            strokeWidth="2"
          />
        )}

        {tickIdx.map((idx) => (
          <text
            key={idx}
            x={x(idx)}
            y={PLOT_H + 10}
            textAnchor={idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle'}
            fontSize="10"
            fill="var(--viz-muted)"
            className="tabular-nums"
          >
            {shortDate(points[idx]!.date)}
          </text>
        ))}

        <rect
          x={PAD_L - step / 2}
          y={0}
          width={plotW + step}
          height={PLOT_H}
          fill="transparent"
          onPointerMove={(e) =>
            pick(e.nativeEvent.offsetX, (px) => Math.round((px - PAD_L) / step))
          }
          onPointerDown={(e) =>
            pick(e.nativeEvent.offsetX, (px) => Math.round((px - PAD_L) / step))
          }
          onPointerLeave={() => setI(null)}
        />
      </svg>
    </div>
  );
}

const SERIES = [
  { key: 'foreign', label: '외국인' },
  { key: 'institution', label: '기관' },
  { key: 'individual', label: '개인' },
] as const;

export function NetFlowChart({ points }: { points: FlowPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { i: hover, setI, pick, onKeyDown } = useHoverIndex(points.length);

  const FACET_H = 52;
  const AXIS_H = 16;
  const plotW = Math.max(40, width - PAD_L - PAD_R);
  const band = plotW / Math.max(1, points.length);
  const barW = Math.max(2, Math.min(14, band - 2)); // 2px 서페이스 간격
  const scale = Math.max(
    1,
    ...points.flatMap((p) => [
      Math.abs(p.foreign),
      Math.abs(p.institution),
      Math.abs(p.individual),
    ]),
  );
  const cx = (idx: number) => PAD_L + band * idx + band / 2;
  const at = hover === null ? null : points[hover]!;

  const tickIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (v, idx, a) => a.indexOf(v) === idx,
  );

  return (
    <div ref={ref} className="viz relative">
      {at && (
        // 세 패싯을 다 가리지 않도록 캡션 위쪽(맨 아래)에 붙인다.
        <Tooltip left={cx(hover!)} width={width} place="bottom">
          <div className="mb-0.5 text-zinc-500">{at.date}</div>
          {SERIES.map((s) => {
            const v = at[s.key];
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-0.5 w-3 shrink-0 rounded"
                  style={{ background: v >= 0 ? 'var(--viz-up)' : 'var(--viz-down)' }}
                />
                <span className="tabular-nums font-medium">
                  {v === 0 ? '보합' : `${v > 0 ? '순매수' : '순매도'} ${moneyMil(v)}`}
                </span>
                <span className="ml-auto text-zinc-500">{s.label}</span>
              </div>
            );
          })}
        </Tooltip>
      )}

      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setI(null)}
        className={focusRing}
        role="group"
        aria-label={`최근 ${points.length}거래일 투자자별 순매수. 값은 아래 표로 보기에 있습니다.`}
      >
        {SERIES.map((s, si) => {
          const isLast = si === SERIES.length - 1;
          const h = FACET_H + (isLast ? AXIS_H : 0);
          const zeroY = FACET_H / 2;
          const half = FACET_H / 2 - 3;
          const total = points.reduce((sum, p) => sum + p[s.key], 0);
          return (
            <div key={s.key} className={si ? 'mt-2' : ''}>
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="text-zinc-500">{s.label}</span>
                <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                  {points.length}일 누적{' '}
                  {total === 0 ? '보합' : `${total > 0 ? '순매수' : '순매도'} ${moneyMil(total)}`}
                </span>
              </div>
              <svg
                width="100%"
                height={h}
                viewBox={`0 0 ${width} ${h}`}
                role="img"
                aria-label={`${s.label} 일별 순매수`}
              >
                <line
                  x1={PAD_L}
                  x2={width - PAD_R}
                  y1={zeroY}
                  y2={zeroY}
                  stroke="var(--viz-axis)"
                  strokeWidth="1"
                />
                <text
                  x={PAD_L - 6}
                  y={zeroY + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--viz-muted)"
                >
                  0
                </text>

                {hover !== null && (
                  <line
                    x1={cx(hover)}
                    x2={cx(hover)}
                    y1={0}
                    y2={FACET_H}
                    stroke="var(--viz-axis)"
                    strokeWidth="1"
                  />
                )}

                {points.map((p, idx) => {
                  const v = p[s.key];
                  if (v === 0) return null;
                  const mag = Math.max(1, (Math.abs(v) / scale) * half);
                  const valY = v > 0 ? zeroY - mag : zeroY + mag;
                  return (
                    <path
                      key={p.date}
                      d={barPath(cx(idx), barW, zeroY, valY)}
                      fill={v > 0 ? 'var(--viz-up)' : 'var(--viz-down)'}
                      fillOpacity={hover === null || hover === idx ? 1 : 0.45}
                    />
                  );
                })}

                {isLast &&
                  tickIdx.map((idx) => (
                    <text
                      key={idx}
                      x={cx(idx)}
                      y={FACET_H + 12}
                      textAnchor={
                        idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle'
                      }
                      fontSize="10"
                      fill="var(--viz-muted)"
                      className="tabular-nums"
                    >
                      {shortDate(points[idx]!.date)}
                    </text>
                  ))}

                <rect
                  x={PAD_L}
                  y={0}
                  width={plotW}
                  height={FACET_H}
                  fill="transparent"
                  onPointerMove={(e) =>
                    pick(e.nativeEvent.offsetX, (px) => Math.floor((px - PAD_L) / band))
                  }
                  onPointerDown={(e) =>
                    pick(e.nativeEvent.offsetX, (px) => Math.floor((px - PAD_L) / band))
                  }
                  onPointerLeave={() => setI(null)}
                />
              </svg>
            </div>
          );
        })}
      </div>

      <p className="mt-1 text-[11px] text-zinc-400">
        세 그래프는 같은 스케일(±{moneyMil(scale)})이라 서로 비교할 수 있다. 0선 위=순매수,
        아래=순매도.
      </p>
    </div>
  );
}
