// Milliseconds from a monotonic clock. Used instead of the global `performance`, whose first use
// loads Node's perf_hooks modules (about 0.5 ms on every hook call; docs/decisions.md D3).
export const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
