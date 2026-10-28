/**
 * A readable message for a failed save. Supabase errors are plain objects (not
 * Error instances), so `err.message` has to be picked out by hand; and when the
 * database lacks the tc_waived column (migration 011 not run yet) say exactly that.
 */
export function describeDbError(err: unknown, fallback: string): string {
  const message =
    err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : fallback;
  if (message.includes("tc_waived")) {
    return "The database doesn't have the \"no transaction cost\" column yet. Run supabase/migrations/011_execution_tc_waived.sql in the Supabase SQL editor, then try again.";
  }
  return message || fallback;
}
