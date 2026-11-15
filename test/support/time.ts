/** Scale harness budgets only; validate during module evaluation before child launch. */
const scale = Number(process.env.PM_TEST_TIME_SCALE ?? 1);
if (!Number.isFinite(scale) || scale <= 0) throw new Error("PM_TEST_TIME_SCALE must be finite and positive");
/** Return integer milliseconds accepted by child-process watchdogs. */
export function testTime(ms: number): number { return Math.ceil(ms * scale); }
