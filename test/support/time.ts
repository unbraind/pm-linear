/** Scale harness budgets only; validate during module evaluation before child launch. */
const setting = process.env.PM_TEST_TIME_SCALE ?? "";
/** An empty setting is treated as unset: `Number("")` is 0, which would refuse every import. */
const scale = setting.trim() === "" ? 1 : Number(setting);
if (!Number.isFinite(scale) || scale <= 0) throw new Error("PM_TEST_TIME_SCALE must be finite and positive");
/** Return integer milliseconds accepted by child-process watchdogs. */
export function testTime(ms: number): number { return Math.ceil(ms * scale); }
